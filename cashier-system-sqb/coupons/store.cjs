'use strict';
const crypto = require('node:crypto');
const { safePrizeId, physicalSnapshot } = require('./catalog-contract.cjs');
const { withTransaction } = require('../online/mysql.cjs');

function problem(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function text(value, name, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw problem('INVALID_INPUT', `${name}不能为空且不能超过 ${max} 个字符`);
  return value.trim();
}
function integer(value, name, min = 0, max = 100000000) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw problem('INVALID_INPUT', `${name}不正确`);
  return value;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const uid = () => crypto.randomUUID();
// mysql2 parses JSON columns into objects; keep reads tolerant either way.
const parseData = value => typeof value === 'string' ? JSON.parse(value) : value;

// MySQL-backed coupon center. Tables pos_coupon_* (see online/mysql.cjs
// ensureSchema). The former SQLite partial unique indexes are enforced by
// generated claim columns + unique keys; UNIQUE(ns, issuer, award) keeps
// issuance idempotent. All state transitions run inside real transactions.
async function createCouponStore({ pool, ns = '', now = () => Date.now(), environment = 'development' }) {
  if (!pool || typeof pool.query !== 'function') throw problem('INVALID_STORE', '需要券数据库连接池', 500);
  await pool.query('INSERT IGNORE INTO pos_coupon_meta(ns, id, data) VALUES (?,?,?)',
    [ns, 'identity', JSON.stringify({ id: uid(), secret: crypto.randomBytes(32).toString('hex'), environment })]);
  const [identityRows] = await pool.query('SELECT data FROM pos_coupon_meta WHERE ns = ? AND id = ?', [ns, 'identity']);
  const identity = parseData(identityRows[0].data);
  if (identity.environment !== environment) throw problem('ENVIRONMENT_MISMATCH', '测试券数据库不能切换为正式环境');
  const get = async (table, id, q = pool) => { const [rows] = await q.query(`SELECT data FROM ${table} WHERE ns = ? AND id = ?`, [ns, id]); return rows.length ? parseData(rows[0].data) : null; };
  const put = (table, entry, q = pool) => q.query(`UPDATE ${table} SET data = ? WHERE ns = ? AND id = ?`, [JSON.stringify(entry), ns, entry.id]);
  const timestamp = () => new Date(now()).toISOString();
  const sign = id => crypto.createHmac('sha256', identity.secret).update(id).digest('base64url');
  const legacyCode = id => `LJC1_${id.replaceAll('-', '')}_${sign(id).slice(0, 24)}`;
  // Bearer tokens live outside public coupon JSON. Only authorized issue/detail
  // paths call this inside a transaction, including lazy historical migration.
  async function code(id, q = pool) {
    const [old] = await q.query('SELECT token FROM pos_coupon_tokens WHERE ns = ? AND coupon_id = ?', [ns, id]);
    if (old.length) return old[0].token;
    const token = `LJC1_${crypto.randomBytes(16).toString('hex').toUpperCase()}`;
    await q.query('INSERT INTO pos_coupon_tokens(ns, coupon_id, token) VALUES (?,?,?)', [ns, id, token]);
    return token;
  }
  const deadline = async (coupon, q = pool) => {
    const cutoff = (await get('pos_coupon_campaigns', coupon.campaignId, q))?.redemptionEndsAt;
    return cutoff && cutoff < coupon.expiresAt ? cutoff : coupon.expiresAt;
  };
  const view = async (coupon, showCode = false, q = pool) => ({ ...coupon, redemptionEndsAt: await deadline(coupon, q), ...(showCode && coupon.state === 'AVAILABLE' ? { code: await code(coupon.id, q) } : {}) });
  const issuerFor = actor => actor.role === 'lottery' ? `campaign:${actor.campaignId}` : actor.id;
  const event = (actor, action, target, q) => q.query('INSERT INTO pos_coupon_events(ns, id, at, actor, `action`, target) VALUES (?,?,?,?,?,?)', [ns, uid(), timestamp(), actor.id, action, target]);
  async function expire(q) {
    const time = timestamp();
    await q.query(`UPDATE pos_coupons SET data = JSON_SET(data, '$.state', 'AVAILABLE', '$.reservation', CAST('null' AS JSON))
      WHERE ns = ? AND data->>'$.state' = 'RESERVED' AND data->>'$.reservation.expiresAt' <= ?`, [ns, time]);
    await q.query(`UPDATE pos_coupons SET data = JSON_SET(data, '$.state', 'EXPIRED')
      WHERE ns = ? AND data->>'$.state' = 'AVAILABLE' AND (data->>'$.expiresAt' <= ? OR
        EXISTS (SELECT 1 FROM pos_coupon_campaigns WHERE pos_coupon_campaigns.ns = pos_coupons.ns AND pos_coupon_campaigns.id = pos_coupons.campaign AND pos_coupon_campaigns.data->>'$.redemptionEndsAt' <= ?))`, [ns, time, time]);
  }
  function requireRole(actor, roles) {
    if (!actor || !roles.includes(actor.role)) throw problem('FORBIDDEN', '接口权限不足', 403);
  }
  async function campaignFor(actor, id, q = pool) {
    const c = await get('pos_coupon_campaigns', id, q);
    if (!c) throw problem('NOT_FOUND', '券活动不存在', 404);
    if (actor.role === 'lottery' && actor.campaignId !== id) throw problem('FORBIDDEN', '此密钥不能访问该券活动', 403);
    return c;
  }
  async function ensureUnclaimed(q, field, value, id, errorCode, message) {
    const [collision] = await q.query(`SELECT id FROM pos_coupons WHERE ns = ? AND id <> ? AND
      data->>'$.state' IN ('RESERVED','PAYMENT_PENDING','REDEEMED') AND data->>'$.${field}' = ? LIMIT 1`, [ns, id, value]);
    if (collision.length) throw problem(errorCode, message, 409);
  }
  async function buildCampaign(input) {
    const kind=input.kind??'cash';
    if(!['cash','physical'].includes(kind))throw problem('INVALID_INPUT','奖品类型不正确');
    if(input.redemptionEnabled!==undefined&&(kind!=='physical'||typeof input.redemptionEnabled!=='boolean'))throw problem('INVALID_INPUT','实物领取开关不正确');
    let physical;
    if(kind==='physical') {
      physical=physicalSnapshot(input.physical);
      if(input.amountCents!==0||input.minimumCents!==0)throw problem('INVALID_INPUT','实物奖品的金额及门槛必须为零');
    } else if(input.physical!=null)throw problem('INVALID_INPUT','抵扣券不能包含实物奖品');
    if (![input.startsAt,input.expiresAt].every(value=>typeof value==='string'&&Number.isFinite(Date.parse(value))))throw problem('INVALID_TIME','请输入有效的活动时间');
    const startsAt=new Date(input.startsAt).toISOString(),expiresAt=new Date(input.expiresAt).toISOString();
    if(startsAt>=expiresAt||expiresAt<=timestamp())throw problem('INVALID_TIME','活动结束时间须晚于开始时间和当前时间');
    let redemptionEndsAt;
    if(input.redemptionEndsAt!=null) {
      if(typeof input.redemptionEndsAt!=='string'||!Number.isFinite(Date.parse(input.redemptionEndsAt)))throw problem('INVALID_TIME','兑奖截止时间不正确');
      redemptionEndsAt=new Date(input.redemptionEndsAt).toISOString();
      if(redemptionEndsAt<=startsAt||redemptionEndsAt>expiresAt||redemptionEndsAt<=timestamp())throw problem('INVALID_TIME','兑奖截止须晚于开始和当前时间且不晚于原有效期');
    }
    return {id:uid(),name:text(input.name,'券名称',60),kind,...(physical?{physical}:{}),amountCents:integer(input.amountCents,'券面额',physical?0:1,1000000),minimumCents:integer(input.minimumCents,'消费门槛'),
      quota:integer(input.quota,'发放上限',1,1000000),issued:0,startsAt,expiresAt,...(redemptionEndsAt?{redemptionEndsAt}:{}),enabled:true,...(physical?{redemptionEnabled:input.redemptionEnabled??true}:{}),createdAt:timestamp(),environment:identity.environment};
  }
  async function eligible(coupon, amount, q = pool) {
    const physical=coupon.kind==='physical';
    if (physical && (await get('pos_coupon_campaigns', coupon.campaignId, q))?.redemptionEnabled === false) throw problem('REDEMPTION_PAUSED','实物领取正在准备，请稍后再试');
    integer(amount, '商品应收金额', physical ? 0 : 1);
    if (amount < coupon.minimumCents) throw problem('MINIMUM_NOT_MET', '未达到优惠券使用门槛');
    if (coupon.startsAt > timestamp() || await deadline(coupon, q) <= timestamp()) throw problem('EXPIRED', '该奖品已超过兑奖或抵扣截止时间');
    return physical ? 0 : Math.min(coupon.amountCents, amount);
  }
  async function reservationFor(actor, id, q = pool) {
    const [rows] = await q.query("SELECT data FROM pos_coupons WHERE ns = ? AND data->>'$.reservation.id' = ?", [ns, id]);
    if (!rows.length) throw problem('RESERVATION_NOT_FOUND', '锁券记录不存在或已释放', 404);
    const c = parseData(rows[0].data);
    if (c.reservation.actorId !== actor.id) throw problem('FORBIDDEN', '不能操作其他收银终端的券', 403);
    return c;
  }
  async function mutate(actor, action, input, fn) {
    const requestId = text(input.requestId, '请求编号');
    const hash = digest(input);
    const scope = `${actor.id}:${action}`;
    return withTransaction(pool, async q => {
      const [oldRows] = await q.query('SELECT hash, data FROM pos_coupon_operations WHERE ns = ? AND scope = ? AND id = ?', [ns, scope, requestId]);
      const old = oldRows[0];
      if (old) {
        if (old.hash !== hash) throw problem('IDEMPOTENCY_CONFLICT', '请求编号已用于不同内容', 409);
        const cached = parseData(old.data);
        if (action === 'issue') { await expire(q); return view(await get('pos_coupons', cached.id, q), true, q); }
        if (action === 'create-key') return { ...cached, token: `ck_${cached.id}_${sign(`key:${cached.id}`)}` };
        return cached;
      }
      await expire(q);
      const result = await fn(q);
      const { code: unusedCode, token: unusedToken, ...cached } = result;
      await q.query('INSERT INTO pos_coupon_operations(ns, scope, id, hash, data) VALUES (?,?,?,?,?)', [ns, scope, requestId, hash, JSON.stringify(cached)]);
      return result;
    });
  }
  async function dispatch(actor, action, input = {}) {
    requireRole(actor, ['admin', 'lottery', 'cashier']);
    if (action === 'info') return { service: 'stall-coupon-center', version: 1, centerId: identity.id, environment: identity.environment, role: actor.role, capabilities:['physical-prize-v1','quota-increase-v1','redemption-deadline-v1','lottery-catalog-v1','lottery-record-status-v1'] };
    if (action === 'lottery-record-status') {
      requireRole(actor, ['admin']);
      const plain = value => value && typeof value === 'object' && !Array.isArray(value);
      const keys = (value, allowed) => plain(value) && Object.keys(value).every(k => allowed.includes(k));
      const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value);
      if (!keys(input, ['centerId','environment','refs']) || input.centerId !== identity.id || input.environment !== identity.environment) throw problem('CENTER_MISMATCH', '券中心身份不一致', 409);
      if (!Array.isArray(input.refs) || input.refs.length < 1 || input.refs.length > 50 || input.refs.some(ref => !keys(ref,['recordId','campaignId','owner','awardId','couponId']) || ![ref.recordId,ref.campaignId,ref.owner,ref.awardId].every(identifier) || ref.couponId != null && !identifier(ref.couponId)) || new Set(input.refs.map(r=>r.recordId)).size !== input.refs.length) throw problem('INVALID_INPUT','请提供1至50条不重复的完整中奖引用');
      // Unlike interactive coupon detail/list, this audit query never calls expire(), code(),
      // an issuance endpoint or a write transaction. Calculate the current state in memory.
      const checkedAt = now(), timestampAt = new Date(checkedAt).toISOString();
      const items = [];
      for (const ref of input.refs) {
        const [rows] = ref.couponId
          ? await pool.query('SELECT data FROM pos_coupons WHERE ns = ? AND id = ?', [ns, ref.couponId])
          : await pool.query('SELECT data FROM pos_coupons WHERE ns = ? AND campaign = ? AND owner = ? AND award = ? AND issuer = ?', [ns, ref.campaignId, ref.owner, ref.awardId, 'campaign:' + ref.campaignId]);
        if (!rows.length) { items.push({ recordId: ref.recordId, result: 'not_found' }); continue; }
        const coupon = parseData(rows[0].data);
        if (coupon.campaignId !== ref.campaignId || coupon.owner !== ref.owner || coupon.awardId !== ref.awardId || coupon.issuer !== 'campaign:' + ref.campaignId || coupon.environment !== identity.environment) { items.push({ recordId: ref.recordId, result: 'mismatch' }); continue; }
        let state = coupon.state;
        if (state === 'RESERVED' && coupon.reservation?.expiresAt <= timestampAt) state = 'AVAILABLE';
        if (state === 'AVAILABLE' && await deadline(coupon) <= timestampAt) state = 'EXPIRED';
        if (!['AVAILABLE','RESERVED','PAYMENT_PENDING','REDEEMED','VOID','EXPIRED'].includes(state)) { items.push({ recordId: ref.recordId, result: 'mismatch' }); continue; }
        const redeemedAt = coupon.redeemedAt ? Date.parse(coupon.redeemedAt) : null;
        if (state === 'REDEEMED' && (!Number.isSafeInteger(redeemedAt) || redeemedAt <= 0)) { items.push({ recordId: ref.recordId, result: 'mismatch' }); continue; }
        items.push({ recordId: ref.recordId, result: 'verified', couponId: coupon.id, state, redeemedAt: Number.isSafeInteger(redeemedAt) ? redeemedAt : null });
      }
      return { centerId: identity.id, environment: identity.environment, checkedAt, items };
    }
    if (action === 'lottery-issue' || action === 'lottery-coupon') {
      requireRole(actor,['admin']);
      const campaign=await campaignFor(actor,text(input.campaignId,'券活动编号'));
      if(!campaign.lotteryCatalog)throw problem('INVALID_INPUT','此接口仅供动态抽奖目录中的券活动使用');
      const delegated={id:'lottery-admin:'+actor.id,role:'lottery',campaignId:campaign.id};
      // Delegate into the original transaction/idempotency checks with a campaign-scoped
      // issuer, so owner/campaign validation and existing coupon lifecycle remain intact.
      if(action==='lottery-coupon')return dispatch(delegated,'coupon',{id:input.id,owner:input.owner});
      if(input.trustedCode!=null)throw problem('INVALID_INPUT','请使用 code 字段传递已确认的实物中奖码');
      return dispatch(delegated,'issue',{requestId:input.requestId,campaignId:campaign.id,owner:input.owner,awardId:input.awardId,...(input.code!=null?{trustedCode:input.code}:{})});
    }
    if (['campaigns', 'coupons', 'keys', 'coupon', 'reservation', 'events'].includes(action)) {
      return withTransaction(pool, async q => {
        await expire(q);
        if (action === 'campaigns') {
          requireRole(actor, ['admin', 'lottery']);
          const [rows] = await q.query('SELECT data FROM pos_coupon_campaigns WHERE ns = ? ORDER BY seq DESC', [ns]);
          return rows.map(row => parseData(row.data)).filter(c => actor.role === 'admin' || c.id === actor.campaignId);
        }
        if (action === 'keys') {
          requireRole(actor, ['admin']);
          const [rows] = await q.query('SELECT data FROM pos_coupon_api_keys WHERE ns = ? ORDER BY seq DESC', [ns]);
          return rows.map(row => parseData(row.data));
        }
        if (action === 'events') {
          requireRole(actor, ['admin']);
          const [rows] = await q.query('SELECT id, at, actor, `action`, target FROM pos_coupon_events WHERE ns = ? ORDER BY seq DESC LIMIT 100', [ns]);
          return rows;
        }
        if (action === 'reservation') {
          requireRole(actor, ['cashier', 'admin']);
          return view(await reservationFor(actor, text(input.id, '锁券编号'), q), false, q);
        }
        if (action === 'coupon') {
          const c = await get('pos_coupons', text(input.id, '券编号'), q);
          if (!c) throw problem('NOT_FOUND', '券不存在', 404);
          if (actor.role !== 'admin') {
            requireRole(actor, ['lottery']);
            if (c.issuer !== issuerFor(actor) || c.owner !== text(input.owner, '领取人标识') || c.campaignId !== actor.campaignId) throw problem('FORBIDDEN', '无权查看此券', 403);
          }
          return view(c, true, q);
        }
        requireRole(actor, ['admin', 'lottery']);
        const page = integer(input.page ?? 1, '页码', 1, 100000);
        const owner = actor.role === 'lottery' ? text(input.owner, '领取人标识') : String(input.owner || '');
        const params = [ns];
        const conditions = ['ns = ?'];
        if (actor.role === 'lottery') { conditions.push('issuer = ?'); params.push(issuerFor(actor)); }
        if (owner) { conditions.push('owner = ?'); params.push(owner); }
        if (input.campaignId) { conditions.push('campaign = ?'); params.push(String(input.campaignId)); }
        if (input.state) { conditions.push("data->>'$.state' = ?"); params.push(String(input.state)); }
        const where = ` WHERE ${conditions.join(' AND ')}`;
        const [countRows] = await q.query(`SELECT COUNT(*) AS count FROM pos_coupons${where}`, params);
        const [rows] = await q.query(`SELECT data FROM pos_coupons${where} ORDER BY seq DESC LIMIT 30 OFFSET ?`, [...params, (page - 1) * 30]);
        const items = [];
        for (const row of rows) items.push(await view(parseData(row.data), false, q));
        return { items, page, total: Number(countRows[0].count), pageSize: 30 };
      });
    }
    return mutate(actor, action, input, async q => {
      if(action==='lottery-provision') {
        requireRole(actor,['admin']);
        const campaignId=text(input.campaignId,'抽奖总活动编号',120),prize=input.prize;
        if(!prize||typeof prize!=='object'||Array.isArray(prize))throw problem('INVALID_INPUT','奖项信息不完整');
        const prizeId=safePrizeId(prize.id),kind=prize.kind;
        if(!['cash','physical'].includes(kind))throw problem('INVALID_INPUT','奖项类型不正确');
        let amountCents=0;
        if(kind==='cash') {
          if(typeof prize.amount!=='number'||!Number.isFinite(prize.amount)||Math.abs(prize.amount*100-Math.round(prize.amount*100))>0.000001)throw problem('INVALID_INPUT','购物券金额须为最多两位小数');
          amountCents=integer(Math.round(prize.amount*100),'购物券金额',1,1000000);
        } else if(prize.amount!=null&&prize.amount!==0)throw problem('INVALID_INPUT','实物奖项金额必须为零');
        const quota=Math.max(1,integer(input.quota,'发放上限',0,1000000));
        const c=await buildCampaign({name:prize.name,kind,amountCents,minimumCents:prize.minimumCents??0,
          ...(kind==='physical'?{physical:{prizeId,quantity:1,product:prize.product}}:{}),quota,startsAt:input.startsAt,expiresAt:input.expiresAt,redemptionEndsAt:input.redemptionEndsAt});
        if(kind==='physical'&&!c.physical.product)throw problem('INVALID_INPUT','新目录中的实物奖项必须绑定商品编码');
        const entitlement={kind,amountCents:c.amountCents,minimumCents:c.minimumCents,startsAt:c.startsAt,expiresAt:c.expiresAt,redemptionEndsAt:c.redemptionEndsAt||c.expiresAt,
          ...(c.physical?{physical:{prizeId,quantity:1,sku:c.physical.product.sku,barcode:c.physical.product.barcode}}:{})};
        const fingerprint=digest(entitlement);
        const [existingRows]=await q.query("SELECT data FROM pos_coupon_campaigns WHERE ns = ? AND data->>'$.lotteryCatalog.campaignId' = ? AND data->>'$.lotteryCatalog.prizeId' = ?",[ns,campaignId,prizeId]);
        const existing=existingRows[0];
        if(existing) {
          const previous=parseData(existing.data);
          if(previous.lotteryCatalog.entitlementFingerprint!==fingerprint)throw problem('AWARD_CONFLICT','已有奖项的商品、类型、券额或期限不能换绑，请使用新的奖项编号',409);
          // Display edits belong to the lottery catalog. Existing center campaigns and
          // issued coupons stay immutable; quota expansion is its separately audited API.
          return {campaign:previous};
        }
        c.lotteryCatalog={campaignId,prizeId,entitlementFingerprint:fingerprint};
        await q.query('INSERT INTO pos_coupon_campaigns(ns, id, data) VALUES (?,?,?)',[ns,c.id,JSON.stringify(c)]);await event(actor,action,c.id,q);
        return {campaign:c};
      }
      if (action === 'create-campaign') {
        requireRole(actor, ['admin']);
        const c=await buildCampaign(input);
        await q.query('INSERT INTO pos_coupon_campaigns(ns, id, data) VALUES (?,?,?)', [ns, c.id, JSON.stringify(c)]); await event(actor, action, c.id, q); return c;
      }
      if (action === 'increase-quota') {
        requireRole(actor, ['admin']);
        const c = await campaignFor(actor, input.id, q);
        const quota = integer(input.quota, '发放上限', 1, 1000000);
        const reason = text(input.reason, '调整原因', 200);
        if (quota < c.quota || quota < c.issued) throw problem('INVALID_INPUT', '券发放上限仅允许增加，不能减少已经承诺的奖品');
        const before = c.quota;
        c.quota = quota;
        c.lastQuotaAdjustment = { before, quota, reason, at: timestamp(), actor: actor.id, requestId: input.requestId };
        await put('pos_coupon_campaigns', c, q); await event(actor, action, c.id, q); return c;
      }
      if (action === 'set-deadline') {
        requireRole(actor, ['admin']);
        if (!Array.isArray(input.campaignIds) || input.campaignIds.length < 1 || input.campaignIds.length > 30 ||
          new Set(input.campaignIds).size !== input.campaignIds.length || input.campaignIds.some(id => typeof id !== 'string' || !id)) throw problem('INVALID_INPUT', '请选择不重复的券活动');
        if (typeof input.redemptionEndsAt !== 'string' || !Number.isFinite(Date.parse(input.redemptionEndsAt))) throw problem('INVALID_TIME', '兑奖截止时间不正确');
        const cutoff = new Date(input.redemptionEndsAt).toISOString();
        const reason = text(input.reason, '调整原因', 200);
        const campaigns = [];
        for (const id of input.campaignIds) campaigns.push(await campaignFor(actor, id, q));
        if (cutoff <= timestamp() || campaigns.some(c => cutoff <= c.startsAt || cutoff > (c.redemptionEndsAt || c.expiresAt))) throw problem('INVALID_TIME', '截止须晚于当前时间与开始时间，且不能延长原有效期');
        for (const c of campaigns) {
          c.lastDeadlineAdjustment = { before: c.redemptionEndsAt || c.expiresAt, redemptionEndsAt: cutoff, reason, at: timestamp(), actor: actor.id, requestId: input.requestId };
          c.redemptionEndsAt = cutoff;
          await put('pos_coupon_campaigns', c, q); await event(actor, action, c.id, q);
        }
        return { campaigns };
      }
      if (action === 'set-campaign') {
        requireRole(actor, ['admin']); const c = await campaignFor(actor, input.id, q);
        if (typeof input.enabled !== 'boolean') throw problem('INVALID_INPUT', '活动开关不正确');
        if(input.redemptionEnabled!==undefined){
          if(c.kind!=='physical'||typeof input.redemptionEnabled!=='boolean')throw problem('INVALID_INPUT','实物领取开关不正确');
          c.redemptionEnabled=input.redemptionEnabled;
        }
        c.enabled = input.enabled; await put('pos_coupon_campaigns', c, q); await event(actor, action, c.id, q); return c;
      }
      if (action === 'create-key') {
        requireRole(actor, ['admin']);
        if (!['lottery', 'cashier'].includes(input.role)) throw problem('INVALID_ROLE', '仅能创建抽奖或收银凭证');
        if (input.role === 'lottery') await campaignFor(actor, input.campaignId, q);
        const k = { id: uid(), name: text(input.name, '凭证名称', 60), role: input.role, campaignId: input.role === 'lottery' ? input.campaignId : null, enabled: true, createdAt: timestamp() };
        const token = `ck_${k.id}_${sign(`key:${k.id}`)}`;
        await q.query('INSERT INTO pos_coupon_api_keys(ns, id, hash, data) VALUES (?,?,?,?)', [ns, k.id, digest(token), JSON.stringify(k)]); await event(actor, action, k.id, q);
        return { ...k, token };
      }
      if (action === 'revoke-key') {
        requireRole(actor, ['admin']); const k = await get('pos_coupon_api_keys', input.id, q);
        if (!k) throw problem('NOT_FOUND', '凭证不存在', 404);
        const [busyRows] = await q.query("SELECT id FROM pos_coupons WHERE ns = ? AND data->>'$.state' IN ('RESERVED','PAYMENT_PENDING') AND data->>'$.reservation.actorId' = ? LIMIT 1", [ns, k.id]);
        if (busyRows.length) throw problem('BUSY', '此收银凭证还有占用中的券，请先核对', 409);
        k.enabled = false; await put('pos_coupon_api_keys', k, q); await event(actor, action, k.id, q); return k;
      }
      if (action === 'issue') {
        requireRole(actor, ['admin', 'lottery']);
        const campaign = await campaignFor(actor, text(input.campaignId, '活动编号'), q);
        if(campaign.lotteryCatalog&&actor.role==='admin')throw problem('FORBIDDEN','动态抽奖奖项须通过专用服务端发放接口核对活动与领取人',403);
        const owner = text(input.owner, '领取人标识'); const awardId = text(input.awardId, '中奖/发放记录编号');
        const physical=campaign.kind==='physical';
        if(physical&&!/^[0-9A-F]{16}$/.test(input.trustedCode||''))throw problem('INVALID_CODE','实物中奖条码不正确');
        if(!physical&&input.trustedCode!=null)throw problem('INVALID_CODE','金额券不接受外部指定条码');
        const [previousRows] = await q.query('SELECT data FROM pos_coupons WHERE ns = ? AND issuer = ? AND award = ?', [ns, issuerFor(actor), awardId]);
        const previous = previousRows[0];
        if (previous) {
          const c = parseData(previous.data);
          if (c.owner !== owner || c.campaignId !== campaign.id) throw problem('AWARD_CONFLICT', '中奖记录已绑定其他领取人或活动', 409);
          if(physical&&(c.kind!=='physical'||c.physical?.prizeId!==campaign.physical.prizeId||await code(c.id,q)!==input.trustedCode))throw problem('AWARD_CONFLICT','原中奖记录的奖品或条码不一致',409);
          return view(c, true, q);
        }
        if (!campaign.enabled || (campaign.redemptionEndsAt || campaign.expiresAt) <= timestamp()) throw problem('INACTIVE', '券活动已暂停或结束');
        if (campaign.issued >= campaign.quota) throw problem('SOLD_OUT', '券发放数量已达到上限', 409);
        if(physical){const [taken]=await q.query('SELECT coupon_id FROM pos_coupon_tokens WHERE ns = ? AND token = ?',[ns,input.trustedCode]);if(taken.length)throw problem('CODE_CONFLICT','该实物条码已绑定其他中奖记录',409);}
        const c = { id: uid(), campaignId: campaign.id, name: campaign.name, kind:campaign.kind||'cash', ...(physical?{physical:structuredClone(campaign.physical)}:{}), amountCents: campaign.amountCents, minimumCents: campaign.minimumCents, startsAt: campaign.startsAt,
          expiresAt: campaign.expiresAt, owner, issuer: issuerFor(actor), awardId, state: 'AVAILABLE', issuedAt: timestamp(), environment: identity.environment, reservation: null };
        await q.query('INSERT INTO pos_coupons(ns, id, campaign, owner, issuer, award, data) VALUES (?,?,?,?,?,?,?)', [ns, c.id, c.campaignId, owner, c.issuer, awardId, JSON.stringify(c)]);
        if(physical)await q.query('INSERT INTO pos_coupon_tokens(ns, coupon_id, token) VALUES (?,?,?)',[ns,c.id,input.trustedCode]);
        campaign.issued++; await put('pos_coupon_campaigns', campaign, q); await event(actor, action, c.id, q); return view(c, true, q);
      }
      if (action === 'void') {
        requireRole(actor, ['admin']); const c = await get('pos_coupons', input.id, q);
        if (!c) throw problem('NOT_FOUND', '券不存在', 404);
        if (c.state !== 'AVAILABLE') throw problem('INVALID_STATE', '只能作废尚未占用的可用券', 409);
        c.state = 'VOID'; c.voidReason = text(input.reason, '作废原因', 200); await put('pos_coupons', c, q); await event(actor, action, c.id, q); return view(c, false, q);
      }
      if (action === 'reserve') {
        requireRole(actor, ['admin', 'cashier']);
        const scanned = text(input.code, '券码', 200);
        let id;
        if (/^LJC1_[0-9A-F]{32}$/.test(scanned)||/^[0-9A-F]{16}$/.test(scanned)) {
          const [rows] = await q.query('SELECT coupon_id FROM pos_coupon_tokens WHERE ns = ? AND token = ?', [ns, scanned]);
          id = rows[0]?.coupon_id;
          if (!id) throw problem('INVALID_CODE', '券码无效');
        } else {
          const match = /^LJC1_([a-f0-9]{32})_([A-Za-z0-9_-]{24})$/.exec(scanned);
          if (!match) throw problem('INVALID_CODE', '不是有效的中奖券码');
          id = match[1].replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
          if (!crypto.timingSafeEqual(Buffer.from(scanned), Buffer.from(legacyCode(id)))) throw problem('INVALID_CODE', '券码无效');
        }
        const c = await get('pos_coupons', id, q);
        if (!c) throw problem('NOT_FOUND', '券不存在', 404);
        if(/^[0-9A-F]{16}$/.test(scanned)&&c.kind!=='physical')throw problem('INVALID_CODE','不是实物中奖条码');
        const checkoutId = text(input.checkoutId, '结算编号');
        if (c.state === 'RESERVED' && c.reservation.actorId === actor.id && c.reservation.checkoutId === checkoutId) return view(c, false, q);
        if (c.state !== 'AVAILABLE') throw problem('NOT_AVAILABLE', '券已使用、已过期或被其他订单占用', 409);
        await ensureUnclaimed(q, 'reservation.checkoutId', checkoutId, c.id, 'CHECKOUT_CONFLICT', '此结算已关联其他优惠券');
        const discountCents = await eligible(c, input.eligibleCents, q);
        c.state = 'RESERVED'; c.reservation = { id: uid(), actorId: actor.id, checkoutId, eligibleCents: input.eligibleCents, discountCents, expiresAt: new Date(now() + 15 * 60 * 1000).toISOString() };
        await put('pos_coupons', c, q); await event(actor, action, c.id, q); return view(c, false, q);
      }
      if (['prepare', 'commit', 'release'].includes(action)) {
        requireRole(actor, ['admin', 'cashier']); const c = await reservationFor(actor, text(input.id, '锁券编号'), q); const r = c.reservation;
        if (action === 'prepare') {
          if (c.state === 'PAYMENT_PENDING' && r.orderId === input.orderId && r.paidCents === input.paidCents && r.eligibleCents === input.eligibleCents) return view(c, false, q);
          if (c.state !== 'RESERVED') throw problem('INVALID_STATE', '券状态不能进入收款', 409);
          r.discountCents = await eligible(c, input.eligibleCents, q);
          r.eligibleCents = input.eligibleCents;
          if (integer(input.paidCents, '支付金额') !== input.eligibleCents - r.discountCents) throw problem('AMOUNT_MISMATCH', '优惠与支付金额不一致');
          r.paidCents = input.paidCents; r.orderId = text(input.orderId, '订单编号'); r.orderNo = text(input.orderNo, '收银订单号');
          await ensureUnclaimed(q, 'reservation.orderId', r.orderId, c.id, 'ORDER_CONFLICT', '此订单已关联其他优惠券');
          c.state = 'PAYMENT_PENDING'; await put('pos_coupons', c, q); await event(actor, action, c.id, q); return view(c, false, q);
        }
        if (action === 'commit') {
          if (r.orderId !== input.orderId || r.paidCents !== input.paidCents) throw problem('ORDER_MISMATCH', '订单或金额与占用记录不一致', 409);
          const paymentReference = text(input.paymentReference, '支付或零元结算编号');
          if (c.state === 'REDEEMED') {
            if (c.paymentReference !== paymentReference) throw problem('ORDER_MISMATCH', '核销回执不一致', 409);
            return view(c, false, q);
          }
          if (c.state !== 'PAYMENT_PENDING') throw problem('INVALID_STATE', '券尚未关联支付订单', 409);
          await ensureUnclaimed(q, 'paymentReference', paymentReference, c.id, 'PAYMENT_CONFLICT', '此支付编号已核销其他优惠券');
          c.state = 'REDEEMED'; c.paymentReference = paymentReference; c.redeemedAt = timestamp(); await put('pos_coupons', c, q); await event(actor, action, c.id, q); return view(c, false, q);
        }
        if (c.state === 'PAYMENT_PENDING' && (input.orderId !== r.orderId || !['failed', 'not-started'].includes(input.outcome))) throw problem('PAYMENT_UNKNOWN', '支付结果未知，不能释放优惠券', 409);
        if (!['RESERVED', 'PAYMENT_PENDING'].includes(c.state)) throw problem('INVALID_STATE', '不能释放已核销的券', 409);
        c.state = await deadline(c, q) <= timestamp() ? 'EXPIRED' : 'AVAILABLE'; c.reservation = null; await put('pos_coupons', c, q); await event(actor, action, c.id, q); return view(c, false, q);
      }
      throw problem('NOT_FOUND', '接口不存在', 404);
    });
  }
  return {
    dispatch,
    async authenticate(token) {
      const [rows] = await pool.query('SELECT data FROM pos_coupon_api_keys WHERE ns = ? AND hash = ?', [ns, digest(token)]);
      const key = rows.length ? parseData(rows[0].data) : null;
      if (!key?.enabled) throw problem('UNAUTHORIZED', '凭证无效或已停用', 401);
      return key;
    },
    // The pool belongs to the caller; close() is kept for interface stability.
    close() {},
    identity: { id: identity.id, environment: identity.environment },
  };
}
module.exports = { createCouponStore, problem, digest };
