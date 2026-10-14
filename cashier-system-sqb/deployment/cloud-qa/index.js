'use strict';
// Private, temporary CloudBase verification function. No HTTP route is required.
// Every database access is restricted to this deployment's explicit QA namespace.
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {createService:createOriginal}=require('./vendor/original/service.js');
const {createDrawRecords,createCloudRecordsReader}=require('./vendor/original/draw-records.cjs');
const scarf=require('./vendor/scarf/service.cjs');
const {createCloudTicketStore,createCloudCodeGuard}=require('./vendor/auth/auth-support.cjs');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const safeFailure=error=>({code:String(error?.code||error?.errCode||error?.name||'unknown').replace(/[^A-Za-z0-9_.-]/g,'').slice(0,80),message:String(error?.errMsg||error?.message||'').replace(/HT1\.[A-Za-z0-9_-]+/g,'[ticket]').replace(/[A-Za-z0-9_-]{24,}/g,'[redacted]').slice(0,240)});
const STAFF='qa_staff_identity_0001',USER='qa_participant_identity_0001';
const SUFFIXES=['control','entries','codes','pools','scarf_campaigns','scarf_inventory','scarf_entries','scarf_invites','scarf_codes','entitlements','auth_tickets','auth_codes'];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function createHarness({db,prefix,secret,now=Date.now}) {
  assert.match(prefix,/^qa_lottery_[a-f0-9]{12}$/);
  const names=new Set(SUFFIXES.map(s=>prefix+'_'+s));
  const name=suffix=>{const value=prefix+'_'+suffix;if(!names.has(value))throw new Error('QA_NAMESPACE_DENIED');return value;};
  // Never pass the unwrapped database to production auth/query modules.
  const isolated={command:db.command,collection:collection=>{if(!names.has(collection))throw new Error('QA_NAMESPACE_DENIED');return db.collection(collection);},runTransaction:callback=>db.runTransaction(native=>callback({collection:collection=>{if(!names.has(collection))throw new Error('QA_NAMESPACE_DENIED');return native.collection(collection);}}))};
  const missing=error=>/document(?:\s|\S)*?(?:does not exist|not exist|not found)/i.test(String(error.errMsg||error.message||''));
  async function get(native,collection,id){try{const result=await native.collection(collection).doc(id).get();const row=Array.isArray(result.data)?result.data[0]:result.data;if(!row||!Object.keys(row).length)return null;const {_id,...data}=row;return data;}catch(error){if(missing(error))return null;throw error;}}
  async function transaction(job){return isolated.runTransaction(native=>job({get:(collection,id)=>get(native,collection,id),set:async(collection,id,value)=>{const {_id,...data}=value;await native.collection(collection).doc(id).set({data});}}));}
  const originalMap={entries:name('entries'),codes:name('codes'),pools:name('pools')};
  const scarfMap=Object.fromEntries(Object.entries(scarf.COLLECTIONS).map(([key,value])=>[value,name('scarf_'+key)]));
  function serviceStore(mapping,entries) {return {readEntries:createCloudRecordsReader(isolated,entries),transaction:job=>transaction(tx=>job({get:(table,id)=>{if(!mapping[table])throw new Error('QA_COLLECTION_DENIED');return tx.get(mapping[table],id);},set:(table,id,value)=>{if(!mapping[table])throw new Error('QA_COLLECTION_DENIED');return tx.set(mapping[table],id,value);}}))};}
  const originalStore=serviceStore(originalMap,name('entries')),scarfStore=serviceStore(scarfMap,name('scarf_entries'));
  const prize={id:'qa_scarf',name:'QA only scarf',kind:'physical',imageUrl:'',product:{id:'qa-product',name:'QA only product',sku:'QA-NOT-FOR-SALE',barcode:'QA-NOT-FOR-SALE'}};
  const centerIdentity={centerId:prefix+'-center',environment:'development',campaignId:prefix+'-scarf-coupon'};
  const center={...centerIdentity,
    async issue({campaignId,owner,awardId,code}) {return transaction(async tx=>{const id=hash(awardId),old=await tx.get(name('entitlements'),id);if(old){assert.equal(old.owner,owner);assert.equal(old.code,code);return old;}const row={id,campaignId,owner,awardId,code,kind:'physical',physical:{prizeId:prize.id,quantity:1,product:prize.product},environment:'development',state:'AVAILABLE'};await tx.set(name('entitlements'),id,row);return row;});},
    async detail({campaignId,owner,id}) {return transaction(async tx=>{const row=await tx.get(name('entitlements'),id);assert.equal(row?.campaignId,campaignId);assert.equal(row?.owner,owner);return row;});}
  };
  const newScarf=randomBps=>scarf.createService({store:scarfStore,center,adminOpenIds:[STAFF],now,randomBps});
  const scarfWon=newScarf(()=>0),scarfLost=newScarf(()=>9999);
  const originalId=user=>hash(prefix+':original:'+user).slice(0,32),scarfId=user=>hash(scarf.CAMPAIGN_ID+':'+user);
  const controlId='run-v1';
  let retries=0,stage='initial',pendingConcurrentResponses=0;
  async function transient(job) {for(let attempt=0;;attempt++){try{return await job();}catch(error){if(attempt>=3||!/transaction.*(?:conflict|retry|abort)|(?:conflict|abort).*transaction/i.test(String(error.errMsg||error.message||'')))throw error;retries++;await sleep(40*(attempt+1));}}}
  function originalService(startedAt,enabled=true){const campaign={id:prefix+'-original',title:'Isolated CloudBase QA',enabled,startsAt:startedAt-60000,endsAt:startedAt+3600000,redeemEndsAt:startedAt+7200000,inventory:{version:1,total:3,quantities:{cap:3}}};return {campaign,call:createOriginal({store:originalStore,campaign,prizes:[{id:'cap',name:'QA only cap',kind:'physical',probability:100}],now,randomIndex:()=>0,makeCode:()=>crypto.randomBytes(8).toString('hex').toUpperCase(),entryId:originalId,adminIds:[STAFF]})};}
  async function checkReadback(control) {
    assert.ok(control&&control.startedAt&&control.state==='complete','QA_RUN_NOT_COMPLETE');
    const original=originalService(control.startedAt),s=await original.call('state',{},USER);
    assert.equal(s.inventory.remaining,0);assert.ok(s.entry?.code);
    const originalRecords=await createDrawRecords({readPage:originalStore.readEntries,campaignId:original.campaign.id,key:secret,now})({limit:2});
    assert.equal(originalRecords.total,3);assert.equal(originalRecords.items.length,2);assert.equal(originalRecords.hasMore,true);
    const next=await createDrawRecords({readPage:originalStore.readEntries,campaignId:original.campaign.id,key:secret,now})({limit:2,cursor:originalRecords.nextCursor});
    assert.equal(next.items.length,1);assert.equal(next.hasMore,false);
    const rows=await createDrawRecords({readPage:scarfStore.readEntries,campaignId:scarf.CAMPAIGN_ID,mode:'scarf',key:secret,now})({limit:20});
    assert.equal(rows.total,3);assert.equal(rows.items.filter(row=>row.outcome==='won').length,2);assert.equal(rows.items.filter(row=>row.outcome==='lost').length,1);
    const winner=await scarfWon('state',{},USER),loser=await scarfLost('state',{},'qa_miss_identity_0001');
    assert.equal(winner.entry.status,'redeemed');assert.equal(loser.entry.outcome,'lost');assert.equal(winner.inventory.remaining,0);
    const count=await isolated.collection(name('entitlements')).count();assert.equal(count.total,2);
    assert.equal((await isolated.collection(name('auth_tickets')).where({used:true}).count()).total,1);
    assert.equal((await isolated.collection(name('auth_codes')).count()).total,1);
    const codes=JSON.stringify([s.entry.code,winner.entry.createdAt,loser.entry.createdAt,rows.items.map(row=>[row.recordId,row.outcome])]);
    const result={originalDraws:3,scarfDraws:3,scarfWins:2,scarfMisses:1,isolatedEntitlements:2,usedLoginTickets:1,claimedLoginCodes:1,originalRemaining:0,scarfRemaining:0,persistenceDigest:hash(codes)};
    if(control.persistenceDigest)assert.equal(result.persistenceDigest,control.persistenceDigest,'CROSS_INVOCATION_PERSISTENCE_CHANGED');
    return result;
  }
  return async action=>{try{
    stage='readback';
    if(action==='readback'){const control=await transaction(tx=>tx.get(name('control'),controlId));return {ok:true,action,namespace:prefix,scope:'real-cloudbase-isolated-durability',couponAdapter:'isolated-cloudbase-simulator',...(await checkReadback(control))};}
    if(action!=='run')throw new Error('QA_ACTION_DENIED');
    stage='claim-namespace';const startedAt=now();
    await transaction(async tx=>{assert.equal(await tx.get(name('control'),controlId),null,'QA_ALREADY_INITIALIZED_NO_RESET');await tx.set(name('control'),controlId,{state:'running',startedAt,namespace:prefix});});
    const checks=[];
    stage='original-initialize';const original=originalService(startedAt,false);await original.call('initializePool',{},STAFF);original.campaign.enabled=true;
    stage='original-concurrent-same-user';const duplicates=await Promise.all(Array.from({length:4},()=>transient(()=>original.call('draw',{},USER))));assert.equal(new Set(duplicates.map(row=>row.code)).size,1,'original concurrent responses must reuse one persisted code');checks.push('original_same_user_concurrent_draw_once');
    stage='original-last-stock';
    await Promise.all(['qa_original_other_0001','qa_original_other_0002'].map(user=>transient(()=>original.call('draw',{},user))));
    await assert.rejects(original.call('draw',{},'qa_original_overflow_0001'),{code:'SOLD_OUT'});checks.push('original_inventory_no_oversell');
    const still=await original.call('draw',{},USER);assert.equal(still.code,duplicates[0].code);checks.push('original_result_replayed_without_redraw');
    stage='scarf-initialize';await transaction(async tx=>{
      await tx.set(name('scarf_campaigns'),scarf.CAMPAIGN_ID,{enabled:true,managed:true,startsAt:startedAt-60000,endsAt:startedAt+3600000,redeemEndsAt:startedAt+7200000,winProbabilityBps:5000,prize,center:centerIdentity});
      await tx.set(name('scarf_inventory'),scarf.CAMPAIGN_ID,{total:2,remaining:2,awarded:0,redeemed:0});
    });
    stage='scarf-durable-miss';const loseInvite=await scarfLost('grant',{},STAFF),lost=await scarfLost('draw',{inviteCode:loseInvite.inviteCode},'qa_miss_identity_0001');assert.equal(lost.entry.outcome,'lost');
    assert.equal((await scarfWon('draw',{inviteCode:loseInvite.inviteCode},'qa_miss_identity_0001')).entry.outcome,'lost');checks.push('scarf_miss_persists_no_reroll');
    stage='scarf-concurrent-same-user';const firstInvite=await scarfWon('grant',{},STAFF),winnerDraws=await Promise.all(Array.from({length:4},()=>transient(()=>scarfWon('draw',{inviteCode:firstInvite.inviteCode},USER))));
    assert.ok(winnerDraws.every(row=>row.entry.outcome==='won'),'all repeated draws retain the same winning outcome');
    // Issuance is deliberately outside the durable draw transaction. A concurrent
    // sync can fail transiently after another sync commits. The public contract
    // then returns an explicit issuing result without a redeemable code.
    const returnedCodes=winnerDraws.map(row=>row.entry.code).filter(code=>code!==undefined);
    assert.ok(new Set(returnedCodes).size<=1,'concurrent responses must never contain two distinct redeemable codes');
    for(const response of winnerDraws.filter(row=>row.entry.code===undefined)){
      assert.equal(response.entry.status,'issuing','missing code must be explicitly pending issuance');
      assert.equal(response.entry.fulfillmentStatus,'pending','missing code must not claim fulfilled');pendingConcurrentResponses++;
    }
    const recovered=await scarfWon('state',{},USER),persistedWinner=await transaction(tx=>tx.get(name('scarf_entries'),scarfId(USER)));
    assert.match(recovered.entry.code,/^[A-F0-9]{16}$/,'state retry must recover the issued winner code');assert.equal(recovered.entry.code,persistedWinner.code,'retry must recover the original durable code');
    for(const code of returnedCodes)assert.equal(code,persistedWinner.code,'all delivered codes match the single durable award');
    assert.equal((await isolated.collection(name('scarf_entries')).count()).total,2,'one miss and one winner only');
    assert.equal((await transaction(tx=>tx.get(name('scarf_inventory'),scarf.CAMPAIGN_ID))).awarded,1,'concurrent retry consumes one prize only');
    checks.push('scarf_same_user_concurrent_draw_once');
    stage='scarf-last-stock-and-invite';
    const lastInvite=await scarfWon('grant',{},STAFF),race=await Promise.allSettled(['qa_scarf_race_identity_0001','qa_scarf_race_identity_0002'].map(user=>transient(()=>scarfWon('draw',{inviteCode:lastInvite.inviteCode},user))));
    assert.equal(race.filter(row=>row.status==='fulfilled').length,1);assert.equal(race.filter(row=>row.status==='rejected').length,1);checks.push('scarf_single_invite_single_winner_and_last_stock');
    stage='scarf-fulfillment-sync';const winningRow=await transaction(tx=>tx.get(name('scarf_entries'),scarfId(USER)));assert.ok(winningRow.couponId);
    await transaction(async tx=>{const entitlement=await tx.get(name('entitlements'),winningRow.couponId);await tx.set(name('entitlements'),winningRow.couponId,{...entitlement,state:'REDEEMED',redeemedAt:new Date(now()).toISOString()});});
    assert.equal((await scarfWon('state',{},USER)).entry.status,'redeemed');assert.equal((await scarfWon('state',{},USER)).entry.status,'redeemed');
    assert.equal((await transaction(tx=>tx.get(name('scarf_inventory'),scarf.CAMPAIGN_ID))).redeemed,1);checks.push('scarf_fulfillment_sync_once_with_isolated_adapter');
    stage='auth-ticket-one-use';const ticketOptions={collection:name('auth_tickets'),appId:'wx0000000000000001',origin:'https://qa.invalid',audience:'original',now};
    const tickets=createCloudTicketStore(isolated,ticketOptions),other=createCloudTicketStore(isolated,{...ticketOptions,audience:'scarf'});
    const issued=await tickets.issue(USER);await assert.rejects(other.consume(issued.ticket,ticketOptions.origin));await assert.rejects(tickets.consume(issued.ticket,'https://wrong.invalid'));
    const consumed=await Promise.allSettled(Array.from({length:2},()=>transient(()=>tickets.consume(issued.ticket,ticketOptions.origin))));
    try{assert.equal(consumed.filter(row=>row.status==='fulfilled').length,1,'concurrent ticket consumption must succeed exactly once');}catch(error){error.qaFailures=consumed.filter(row=>row.status==='rejected').map(row=>safeFailure(row.reason));throw error;}
    await assert.rejects(tickets.consume(issued.ticket,ticketOptions.origin));checks.push('cloud_ticket_audience_origin_and_single_use');
    stage='auth-code-one-use';const guard=createCloudCodeGuard(isolated,{collection:name('auth_codes'),appId:ticketOptions.appId,now}),testCode='qa-code-'+crypto.randomBytes(10).toString('hex');
    await guard(testCode);await assert.rejects(guard(testCode),{code:'LOGIN_REUSED'});checks.push('cloud_login_code_single_use');
    stage='final-readback';const complete={state:'complete',startedAt,completedAt:now(),namespace:prefix,checks,transientRetries:retries,pendingConcurrentResponses};
    const evidence=await checkReadback(complete);complete.persistenceDigest=evidence.persistenceDigest;
    await transaction(tx=>tx.set(name('control'),controlId,complete));
    return {ok:true,action,namespace:prefix,scope:'real-cloudbase-isolated-durability',couponAdapter:'isolated-cloudbase-simulator',checks,transientRetries:retries,pendingConcurrentResponses,...evidence};
  }catch(error){error.qaStage=stage;throw error;}};
}
exports.main=async(event={})=>{
  try{
    const prefix=process.env.QA_PREFIX,secret=process.env.QA_AUTH_TOKEN;
    if(!/^qa_lottery_[a-f0-9]{12}$/.test(prefix||'')||!/^[a-f0-9]{64}$/.test(secret||'')||!event||typeof event!=='object'||Array.isArray(event)||event.httpMethod||Object.keys(event).some(key=>!['action','authorization'].includes(key))||!/^[a-f0-9]{64}$/.test(event.authorization||'')||!crypto.timingSafeEqual(Buffer.from(secret),Buffer.from(event.authorization)))return {ok:false,code:'QA_UNAUTHORIZED'};
    const cloud=require('wx-server-sdk');cloud.init({env:cloud.DYNAMIC_CURRENT_ENV});if(cloud.getWXContext()?.OPENID)return {ok:false,code:'QA_ADMIN_INVOCATION_REQUIRED'};
    return await createHarness({db:cloud.database(),prefix,secret})(event.action);
  }catch(error){return {ok:false,code:'QA_FAILED',stage:error.qaStage||'authorization',assertion:String(error.code||error.name||'unknown'),message:String(error.message||'').replace(/[A-Za-z0-9_-]{48,}/g,'[redacted]').slice(0,250),...(error.qaFailures?{failures:error.qaFailures}:{})};}
};
exports.createHarness=createHarness;
exports.collectionSuffixes=SUFFIXES;
