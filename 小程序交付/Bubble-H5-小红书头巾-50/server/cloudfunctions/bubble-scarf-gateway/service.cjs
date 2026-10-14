'use strict';
const crypto = require('node:crypto');
const CAMPAIGN_ID = 'scarf-xhs-50-v1';
const TOTAL_STOCK = 200;
const INVITE_TTL = 10 * 60 * 1000;
const PRIZE = Object.freeze({id: 'scarf', name: '魔术头巾', imageUrl:''});
const COLLECTIONS = Object.freeze({campaigns: 'bubble_scarf_campaigns', inventory: 'bubble_scarf_inventory', entries: 'bubble_scarf_entries', invites: 'bubble_scarf_invites', codes: 'bubble_scarf_codes'});
const fail = (code, message, status = 400) => { throw Object.assign(new Error(message), {code, status, gatewayFault: true}); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const validCode = code => typeof code === 'string' && /^[A-F0-9]{16}$/.test(code);
const validOpenId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{10,128}$/.test(value);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const validTime = value => Number.isSafeInteger(value) && value > 0;
const prizeView=prize=>({id:prize?.id||PRIZE.id,name:prize?.name||PRIZE.name,imageUrl:prize?.imageUrl||''});
function maskUnverified(result,verified){if(!verified&&result.entry?.fulfillment==='cashier'&&['pending','reserved'].includes(result.entry.status)){result.entry={...result.entry,status:'issuing',fulfillmentStatus:'pending'};delete result.entry.code;}return result;}
function configuration(campaign, inventory) {
  if (!record(campaign) || typeof campaign.enabled !== 'boolean' || !validTime(campaign.startsAt) || !validTime(campaign.endsAt) || !validTime(campaign.redeemEndsAt) || campaign.startsAt >= campaign.endsAt || campaign.endsAt > campaign.redeemEndsAt) return false;
  if (!record(inventory) || !Number.isSafeInteger(inventory.total) || inventory.total < 0 || inventory.total > 1000000 || (!campaign.managed && inventory.total !== TOTAL_STOCK) || ![inventory.remaining, inventory.awarded, inventory.redeemed].every(n => Number.isSafeInteger(n) && n >= 0) || inventory.remaining + inventory.awarded !== inventory.total || inventory.redeemed > inventory.awarded) return false;
  if (campaign.managed && (!Number.isSafeInteger(campaign.winProbabilityBps) || campaign.winProbabilityBps < 0 || campaign.winProbabilityBps > 10000)) return false;
  return true;
}
function publicCampaign(campaign) {
  return {id: CAMPAIGN_ID, title: campaign?.title || '山野有约', venue: campaign?.venue || '赛事现场 · Bubble 展位', rulesText:typeof campaign?.rulesText==='string'?campaign.rulesText:'', enabled:campaign?.enabled===true,winProbabilityBps:campaign?.winProbabilityBps??5000, startsAt: validTime(campaign?.startsAt) ? campaign.startsAt : null, endsAt: validTime(campaign?.endsAt) ? campaign.endsAt : null, redeemEndsAt: validTime(campaign?.redeemEndsAt) ? campaign.redeemEndsAt : null};
}
function publicEntry(row, now) {
  if (!row) return null;
  if (!['won', 'lost'].includes(row.outcome) || !validTime(row.createdAt) || !validTime(row.expiresAt) || (row.outcome === 'won' && (!validCode(row.code) || !['pending', 'redeemed'].includes(row.status))) || (row.outcome === 'lost' && row.status !== 'lost')) fail('INVALID_STATE', '活动记录异常，请联系工作人员', 503);
  let status = row.outcome === 'lost' ? 'lost' : row.status;
  if (status === 'pending' && now >= row.expiresAt) status = 'expired';
  const cashier=row.fulfillment==='cashier';
  if(status==='pending'&&cashier&&!row.couponId) status='issuing';
  if(status==='pending'&&cashier&&['RESERVED','PAYMENT_PENDING'].includes(row.couponState)) status='reserved';
  if(status==='pending'&&cashier&&['VOID','EXPIRED'].includes(row.couponState)) status='expired';
  const entry = {outcome: row.outcome, status, createdAt: row.createdAt, expiresAt: row.expiresAt, redeemedAt: row.redeemedAt || null,prize:prizeView(row.prize),fulfillment:cashier?'cashier':'legacy',fulfillmentStatus:cashier?(row.couponId?'ready':'pending'):'legacy'};
  if (status === 'pending') entry.code = row.code;
  return entry;
}
function availability(campaign, inventory, entry, now) {
  if (entry) return {canDraw: false, reason: 'ALREADY_DRAWN'};
  if (!configuration(campaign, inventory)) return {canDraw: false, reason: 'NOT_CONFIGURED'};
  if (campaign.managed && !campaign.center?.campaignId) return {canDraw:false,reason:'NOT_CONFIGURED'};
  if (!campaign.enabled) return {canDraw: false, reason: 'PAUSED'};
  if (now < campaign.startsAt) return {canDraw: false, reason: 'NOT_STARTED'};
  if (now >= campaign.endsAt) return {canDraw: false, reason: 'ENDED'};
  if (inventory.remaining === 0) return {canDraw: false, reason: 'SOLD_OUT'};
  return {canDraw: true, reason: 'READY'};
}
const denyMessages = {NOT_CONFIGURED: '活动时间或库存尚未配置，请联系工作人员', PAUSED: '活动暂未开放，请稍后再来', NOT_STARTED: '活动尚未开始', ENDED: '活动已经结束', SOLD_OUT: '头巾已领完，本次尚未消耗你的抽奖资格'};
function view(campaign, inventory, entry, now) {
  return {campaign: publicCampaign(campaign), prize: prizeView(campaign?.prize), entry: publicEntry(entry, now), inventory: {total:inventory?.total??TOTAL_STOCK, remaining: configuration(campaign, inventory) ? inventory.remaining : null}, availability: availability(campaign, inventory, entry, now), requiresInvite: true};
}
function createService({store, adminOpenIds = [], now = Date.now, random, randomBps=()=>crypto.randomInt(10000), randomCode = () => crypto.randomBytes(8).toString('hex').toUpperCase(),center}) {
  if (!store || typeof store.transaction !== 'function' || !Array.isArray(adminOpenIds) || adminOpenIds.some(id => !validOpenId(id))) fail('INVALID_CONFIG', '活动服务尚未配置', 503);
  const admins = new Set(adminOpenIds);
  const requireAdmin = openId => { if (!admins.has(openId)) fail('FORBIDDEN', '仅现场工作人员可以操作', 403); };
  const codeKey = code => hash(CAMPAIGN_ID + ':' + code);
  const entryKey = openId => hash(CAMPAIGN_ID + ':' + openId);
  async function uniqueCode(tx, collection) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const value = randomCode();
      if (!validCode(value)) fail('INVALID_RANDOM', '凭证生成服务异常', 503);
      if (!await tx.get(collection, codeKey(value))) return value;
    }
    fail('RETRY', '凭证生成暂时繁忙，请重试', 503);
  }
  async function syncEntry(id) {
    const row=await store.transaction(tx=>tx.get(COLLECTIONS.entries,id));
    if(!row||row.outcome!=='won'||row.fulfillment!=='cashier'||row.status==='redeemed') return true;
    if(!center||row.center.centerId!==center.centerId||row.center.environment!==center.environment)return false;
    try {
      const owner='scarf-'+hash(CAMPAIGN_ID+':'+row.openId),awardId='scarf-'+id;
      const coupon=row.couponId?await center.detail({campaignId:row.center.campaignId,owner,id:row.couponId}):await center.issue({campaignId:row.center.campaignId,owner,awardId,code:row.code});
      if(!coupon?.id||coupon.campaignId!==row.center.campaignId||coupon.kind!=='physical'||coupon.physical?.prizeId!==row.prize.id||coupon.environment!==row.center.environment||coupon.owner!==owner||coupon.awardId!==awardId||['sku','barcode'].some(k=>(coupon.physical.product?.[k]||'')!==(row.prize.product?.[k]||''))||(coupon.code&&coupon.code!==row.code)) throw new Error('Invalid coupon response');
      await store.transaction(async tx=>{
        const latest=await tx.get(COLLECTIONS.entries,id);
        if(!latest||latest.code!==row.code||latest.status==='redeemed')return;
        if(latest.couponId&&latest.couponId!==coupon.id)throw new Error('Coupon mismatch');
        latest.couponId=coupon.id;latest.couponState=coupon.state;
        if(coupon.state==='REDEEMED') {
          latest.status='redeemed';latest.redeemedAt=Number.isFinite(Date.parse(coupon.redeemedAt))?Date.parse(coupon.redeemedAt):now();
          const inventory=await tx.get(COLLECTIONS.inventory,CAMPAIGN_ID);
          if(!inventory||inventory.redeemed>=inventory.awarded)throw new Error('Inventory mismatch');
          inventory.redeemed++;await tx.set(COLLECTIONS.inventory,CAMPAIGN_ID,inventory);
        }
        await tx.set(COLLECTIONS.entries,id,latest);
      });
      return true;
    } catch { /* The durable draw is authoritative. The next state request safely retries issuance. */ return false; }
  }
  return async function call(action, payload = {}, openId) {
    if (!validOpenId(openId)) fail('UNAUTHENTICATED', '请从小程序活动入口重新进入', 401);
    if (!record(payload) || Object.keys(payload).some(key => !(['draw'].includes(action) ? ['inviteCode'] : ['lookup', 'redeem'].includes(action) ? ['code'] : []).includes(key))) fail('INVALID_REQUEST', '请求参数无效');
    if (action === 'identity') return {isAdmin: admins.has(openId)};
    if (['lookup', 'redeem', 'grant'].includes(action)) requireAdmin(openId);
    if (!['state', 'draw', 'lookup', 'redeem', 'grant'].includes(action)) fail('INVALID_ACTION', '此网页不支持该操作');
    if (['lookup', 'redeem'].includes(action) && !validCode(payload.code)) fail('INVALID_CODE', '请输入完整的16位领取码');
    if (action === 'draw' && !validCode(payload.inviteCode)) fail('INVALID_INVITE', '请先由工作人员确认关注并扫描参与码');
    let verified=true;
    if(action==='state'||action==='draw') verified=await syncEntry(entryKey(openId));
    if(action==='lookup'||action==='redeem') {
      const codeRow=await store.transaction(tx=>tx.get(COLLECTIONS.codes,codeKey(payload.code)));
      if(codeRow?.entryId)verified=await syncEntry(codeRow.entryId);
    }
    const result=await store.transaction(async tx => {
      const timestamp = now();
      const campaign = await tx.get(COLLECTIONS.campaigns, CAMPAIGN_ID);
      const inventory = await tx.get(COLLECTIONS.inventory, CAMPAIGN_ID);
      if (action === 'state' || action === 'draw') {
        const id = entryKey(openId);
        const existing = await tx.get(COLLECTIONS.entries, id);
        if (action === 'state' || existing) return view(campaign, inventory, existing, timestamp);
        const available = availability(campaign, inventory, null, timestamp);
        if (!available.canDraw) fail(available.reason, denyMessages[available.reason]);
        if(campaign.managed&&(!center||campaign.center.centerId!==center.centerId||campaign.center.environment!==center.environment))fail('NOT_CONFIGURED','收银券中心尚未连接，请联系工作人员',503);
        const inviteId = codeKey(payload.inviteCode);
        const invite = await tx.get(COLLECTIONS.invites, inviteId);
        if (!invite || invite.campaignId !== CAMPAIGN_ID || !validTime(invite.expiresAt)) fail('INVALID_INVITE', '参与码无效，请联系现场工作人员');
        if (invite.consumedBy) fail('INVITE_USED', '这个参与码已使用，请联系现场工作人员');
        if (timestamp >= invite.expiresAt) fail('INVITE_EXPIRED', '参与码已过期，请让工作人员重新生成');
        let sample=randomBps();
        if(random) {const coin=random();if(coin!==0&&coin!==1)fail('INVALID_RANDOM','抽奖服务暂时异常，请稍后重试',503);sample=coin===0?0:9999;}
        if (!Number.isSafeInteger(sample)||sample<0||sample>=10000) fail('INVALID_RANDOM', '抽奖服务暂时异常，请稍后重试', 503);
        const won = sample < (campaign.winProbabilityBps??5000);
        const code = won ? await uniqueCode(tx, COLLECTIONS.codes) : null;
        const row = {campaignId: CAMPAIGN_ID, openId, outcome: won ? 'won' : 'lost', status: won ? 'pending' : 'lost', createdAt: timestamp, expiresAt: campaign.redeemEndsAt, redeemedAt: null, code,prize:campaign.prize||PRIZE,fulfillment:campaign.managed?'cashier':'legacy',...(campaign.managed?{center:campaign.center,couponId:null,couponState:null}:{})};
        if (won) {
          inventory.remaining--;
          inventory.awarded++;
          await tx.set(COLLECTIONS.inventory, CAMPAIGN_ID, inventory);
          await tx.set(COLLECTIONS.codes, codeKey(code), {campaignId: CAMPAIGN_ID, entryId: id});
        }
        await tx.set(COLLECTIONS.entries, id, row);
        await tx.set(COLLECTIONS.invites, inviteId, {...invite, consumedBy: id, consumedAt: timestamp});
        return view(campaign, inventory, row, timestamp);
      }
      if (action === 'grant') {
        const available = availability(campaign, inventory, null, timestamp);
        if (!available.canDraw) fail(available.reason, denyMessages[available.reason]);
        if(campaign.managed&&(!center||campaign.center.centerId!==center.centerId||campaign.center.environment!==center.environment))fail('NOT_CONFIGURED','收银券中心尚未连接，请联系工作人员',503);
        const inviteCode = await uniqueCode(tx, COLLECTIONS.invites);
        const expiresAt = Math.min(timestamp + INVITE_TTL, campaign.endsAt);
        await tx.set(COLLECTIONS.invites, codeKey(inviteCode), {campaignId: CAMPAIGN_ID, createdAt: timestamp, expiresAt, issuedBy: openId, consumedBy: null, consumedAt: null, deleteAfter: new Date(expiresAt + 24 * 60 * 60 * 1000)});
        return {inviteCode, expiresAt};
      }
      const codeRow = await tx.get(COLLECTIONS.codes, codeKey(payload.code));
      if (!codeRow || codeRow.campaignId !== CAMPAIGN_ID || typeof codeRow.entryId !== 'string') fail('NOT_FOUND', '未找到本活动的领取码');
      const entry = await tx.get(COLLECTIONS.entries, codeRow.entryId);
      if (!entry || entry.campaignId !== CAMPAIGN_ID || entry.outcome !== 'won' || entry.code !== payload.code) fail('NOT_FOUND', '未找到本活动的领取码');
      const publicRow = publicEntry(entry, timestamp);
      if (action === 'lookup') return {entry: publicRow, prize: prizeView(entry.prize), campaign: publicCampaign(campaign)};
      if(entry.fulfillment==='cashier')fail('USE_CASHIER','请在收银系统扫码核销并完成零元领奖订单，现场工作台不能重复发奖',409);
      if (entry.status === 'redeemed') return {entry: publicRow, prize: prizeView(entry.prize), campaign: publicCampaign(campaign), alreadyRedeemed: true};
      if (!inventory || !campaign) fail('NOT_CONFIGURED', denyMessages.NOT_CONFIGURED, 503);
      if (!campaign.enabled&&!campaign.managed) fail('PAUSED', '活动已暂停核销，请联系负责人');
      if (publicRow.status === 'expired') fail('EXPIRED', '领取凭证已过期，无法核销');
      if (inventory.redeemed >= inventory.awarded) fail('INVALID_STATE', '库存记录异常，请联系负责人', 503);
      entry.status = 'redeemed';
      entry.redeemedAt = timestamp;
      entry.redeemedBy = openId;
      inventory.redeemed++;
      if(campaign.managed)inventory.legacyRedeemed=(inventory.legacyRedeemed||0)+1;
      await tx.set(COLLECTIONS.entries, codeRow.entryId, entry);
      await tx.set(COLLECTIONS.inventory, CAMPAIGN_ID, inventory);
      return {entry: publicEntry(entry, timestamp), prize: prizeView(entry.prize), campaign: publicCampaign(campaign), alreadyRedeemed: false};
    });
    if(action==='draw'&&result.entry?.fulfillment==='cashier'&&result.entry.outcome==='won') {
      verified=await syncEntry(entryKey(openId));
      return maskUnverified(await store.transaction(async tx=>view(await tx.get(COLLECTIONS.campaigns,CAMPAIGN_ID),await tx.get(COLLECTIONS.inventory,CAMPAIGN_ID),await tx.get(COLLECTIONS.entries,entryKey(openId)),now())),verified);
    }
    return maskUnverified(result,verified);
  };
}

function createCloudStore(db) {
  return {readEntries: require('./draw-records.cjs').createCloudRecordsReader(db,COLLECTIONS.entries),transaction: job => db.runTransaction(async transaction => job({
    async get(collection, id) {
      try {
        const result = await transaction.collection(collection).doc(id).get();
        const row = Array.isArray(result.data) ? result.data[0] : result.data;
        if (!row || !Object.keys(row).length) return null;
        const {_id, ...data} = row;
        return data;
      } catch (error) {
        if (/document(?:\s|\S)*?(?:does not exist|not exist|not found)/i.test(String(error.errMsg || error.message || ''))) return null;
        throw error;
      }
    },
    async set(collection, id, data) { await transaction.collection(collection).doc(id).set({data}); }
  }))};
}
module.exports = {CAMPAIGN_ID, TOTAL_STOCK, INVITE_TTL, COLLECTIONS, createService, createCloudStore, configuration, publicEntry,publicCampaign,PRIZE};
