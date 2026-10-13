'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createService,CAMPAIGN_ID,COLLECTIONS}=require('../server/cloudfunctions/bubble-scarf-gateway/service.cjs');
const {createManagementService,createManagementHttp}=require('../server/cloudfunctions/bubble-scarf-gateway/management.cjs');
const {createScarfCenter}=require('../server/cloudfunctions/bubble-scarf-gateway/center.cjs');
const TIME=1800000000000,ADMIN='oScarf_Admin00000001',USER='oScarf_Visitor000001';
function memoryStore(){let rows=new Map(),tail=Promise.resolve();return {
  seed(collection,id,data){rows.set(collection+'/'+id,structuredClone(data));},
  rows(collection){return [...rows].filter(([key])=>key.startsWith(collection+'/')).map(([,v])=>structuredClone(v));},
  transaction(job){const pending=tail.then(async()=>{const copy=new Map([...rows].map(([k,v])=>[k,structuredClone(v)]));const result=await job({get:async(c,id)=>structuredClone(copy.get(c+'/'+id)||null),set:async(c,id,data)=>copy.set(c+'/'+id,structuredClone(data))});rows=copy;return result;});tail=pending.catch(()=>{});return pending;}
};}
function fakeCenter(){const campaigns=new Map(),coupons=new Map();let failIssue=false,failDetail=false,failAfterIssue=false;return {
  centerId:'center-test',environment:'development',campaigns,coupons,
  fail(kind,value=true){if(kind==='issue')failIssue=value;if(kind==='detail')failDetail=value;if(kind==='after-issue')failAfterIssue=value;},
  async verify(){return {centerId:this.centerId,environment:this.environment};},
  async provision({prize}){const id='campaign-'+prize.id;campaigns.set(id,structuredClone(prize));return {centerId:this.centerId,environment:this.environment,campaignId:id};},
  async issue({campaignId,owner,awardId,code}){if(failIssue)throw new Error('offline');if(!coupons.has(awardId)){const prize=campaigns.get(campaignId);coupons.set(awardId,{id:'coupon-'+awardId,campaignId,owner,awardId,code,kind:'physical',physical:{prizeId:prize.id,quantity:1,product:prize.product},environment:this.environment,state:'AVAILABLE'});}if(failAfterIssue)throw new Error('connection lost after commit');return structuredClone(coupons.get(awardId));},
  async detail({id}){if(failDetail)throw new Error('offline');return structuredClone([...coupons.values()].find(c=>c.id===id));},
  async redeemed(ids){return [...coupons.values()].filter(c=>ids.includes(c.campaignId)&&c.state==='REDEEMED').length;}
};}
function fixture({bps=5000,sample=0,total=200}={}){
  const store=memoryStore(),center=fakeCenter();let sequence=0,samples=0;
  const service=createService({store,center,adminOpenIds:[ADMIN],now:()=>TIME,randomBps:()=>{samples++;return sample;},randomCode:()=> (++sequence).toString(16).toUpperCase().padStart(16,'0')});
  const manage=createManagementService({store,center,now:()=>TIME});
  const configuration={campaign:{title:'山野有约',venue:'赛事现场 · Bubble 展位',startsAt:new Date(TIME-1000).toISOString(),endsAt:TIME+3600000,redeemEndsAt:TIME+7200000,winProbabilityBps:bps},prize:{id:'scarf',name:'魔术头巾',imageUrl:'',product:{id:'p1',name:'黄橘头巾',sku:'SCARF-01',barcode:''}},total};
  const update=async(operation,patch={})=>manage('update',{revision:(await manage('snapshot')).revision,requestId:crypto.randomUUID(),operation,reason:'测试调整',...patch});
  return {store,center,service,manage,configuration,update,samples:()=>samples,
    async setup(){await update('configure',configuration);await update('resume');},
    async draw(user=USER){const invite=await service('grant',{},ADMIN);return service('draw',{inviteCode:invite.inviteCode},user);},
    state:()=>service('state',{},USER)};
}
test('new activity is paused, saves full draft without dates, and cannot resume incomplete setup',async()=>{
  const f=fixture(),empty=await f.manage('snapshot');assert.equal(empty.campaign.enabled,false);assert.equal(empty.inventory.total,200);assert.equal(empty.campaign.winProbabilityBps,5000);
  const draft=structuredClone(f.configuration);draft.campaign.startsAt=draft.campaign.endsAt=draft.campaign.redeemEndsAt=null;
  const saved=await f.update('configure',draft);assert.equal(saved.revision,1);assert.equal(saved.prize.product.sku,'SCARF-01');assert.equal(saved.campaign.startsAt,null);
  await assert.rejects(f.update('resume'),{code:'NOT_CONFIGURED'});assert.equal(f.center.campaigns.size,0);
});
test('configure requires pause and rejects missing product codes, unsafe images, impossible dates, and probabilities',async()=>{
  const f=fixture();await f.setup();await assert.rejects(f.update('configure',f.configuration),{code:'PAUSE_REQUIRED'});await f.update('pause');
  for(const mutate of [x=>x.prize.product.sku='',x=>x.prize.imageUrl='http://bad.test/a.png',x=>x.campaign.winProbabilityBps=10001,x=>x.campaign.endsAt=x.campaign.startsAt,x=>x.total=-1]){const invalid=structuredClone(f.configuration);mutate(invalid);await assert.rejects(f.update('configure',invalid));}
  assert.equal((await f.manage('snapshot')).revision,3);
});
test('configuration uses optimistic revisions, repeat requests are idempotent, and request reuse cannot change content',async()=>{
  const f=fixture();const p={revision:0,requestId:'one-operation-0001',operation:'configure',reason:'配置活动',...f.configuration};
  const result=await f.manage('update',p);assert.equal(result.revision,1);assert.equal((await f.manage('update',p)).revision,1);assert.equal((await f.manage('snapshot')).audit.length,1);
  await assert.rejects(f.manage('update',{...p,total:201}),{code:'REQUEST_CONFLICT'});
  await assert.rejects(f.manage('update',{...p,requestId:'another-operation'}),{code:'REVISION_CONFLICT'});
  assert.equal(f.center.campaigns.size,1);
});
test('rules text saves normalized plain text, is public, and records compact audit evidence',async()=>{
  const f=fixture(),initial=await f.manage('snapshot');
  assert.equal(initial.campaign.rulesText,'');assert.ok(initial.capabilities.includes('rules-text-v1'));
  const original='  第一行\r\n\t第二行\r第三行 <b>按文字展示</b>  ',expected='第一行\n\t第二行\n第三行 <b>按文字展示</b>';
  const saved=await f.update('configure',{...f.configuration,campaign:{...f.configuration.campaign,rulesText:original}});
  assert.equal(saved.campaign.rulesText,expected);assert.equal((await f.manage('snapshot')).campaign.rulesText,expected);
  assert.equal((await f.state()).campaign.rulesText,expected);
  const audit=saved.audit.at(-1);assert.equal(audit.rulesTextChanged,true);
  assert.deepEqual(audit.before.rulesTextSummary,{length:0,sha256:crypto.createHash('sha256').update('').digest('hex')});
  assert.deepEqual(audit.after.rulesTextSummary,{length:expected.length,sha256:crypto.createHash('sha256').update(expected).digest('hex')});
  assert.equal(JSON.stringify(audit).includes('按文字展示'),false);
});
test('old clients preserve omitted rules text and explicit empty text restores defaults',async()=>{
  const f=fixture();await f.update('configure',{...f.configuration,campaign:{...f.configuration.campaign,rulesText:'现场说明'}});
  const preserved=await f.update('configure',f.configuration);assert.equal(preserved.campaign.rulesText,'现场说明');assert.equal(preserved.audit.at(-1).rulesTextChanged,false);
  await f.update('resume');assert.equal((await f.state()).campaign.rulesText,'现场说明');
  await assert.rejects(f.update('configure',{...f.configuration,campaign:{...f.configuration.campaign,rulesText:'另一份说明'}}),{code:'PAUSE_REQUIRED'});
  await f.update('pause');assert.equal((await f.manage('snapshot')).campaign.rulesText,'现场说明');
  for(const rulesText of ['',' \t\r\n ']){const saved=await f.update('configure',{...f.configuration,campaign:{...f.configuration.campaign,rulesText}});assert.equal(saved.campaign.rulesText,'');assert.equal((await f.state()).campaign.rulesText,'');}
});
test('rules text rejects invalid types, controls and oversize input before any campaign or center writes',async()=>{
  const f=fixture();await f.update('configure',f.configuration);const before=f.store.rows(COLLECTIONS.campaigns),revision=(await f.manage('snapshot')).revision;
  let provisions=0;f.center.provision=async()=>{provisions++;throw new Error('validation must reject first');};
  for(const rulesText of [undefined,null,23,{},[], '字'.repeat(5001),'\u0000开头','结尾\u000b','\u000c','中\u001f间','中\u007f间','中\u0085间','中\u009f间']){
    await assert.rejects(f.update('configure',{...f.configuration,campaign:{...f.configuration.campaign,rulesText}}),{code:'INVALID_REQUEST'});
  }
  assert.equal(provisions,0);assert.equal((await f.manage('snapshot')).revision,revision);assert.deepEqual(f.store.rows(COLLECTIONS.campaigns),before);
});
test('rules text enforces its limit after line-ending normalization and trim',async()=>{
  const f=fixture(),body='界'.repeat(4998)+'\r\n界';
  const saved=await f.update('configure',{...f.configuration,campaign:{...f.configuration.campaign,rulesText:'  '+body+'  '}});
  assert.equal(saved.campaign.rulesText.length,5000);assert.equal(saved.campaign.rulesText.includes('\r'),false);
  assert.ok(JSON.stringify(saved.audit.at(-1)).length<1500,'audit stores hashes rather than copies of a long body');
});
test('rules text updates retain revision conflicts and idempotency',async()=>{
  const f=fixture(),payload={revision:0,requestId:'rules-operation-0001',operation:'configure',reason:'更新说明',...f.configuration,campaign:{...f.configuration.campaign,rulesText:'第一版'}};
  await f.manage('update',payload);await f.manage('update',payload);assert.equal((await f.manage('snapshot')).audit.length,1);
  await assert.rejects(f.manage('update',{...payload,requestId:'rules-operation-0002',campaign:{...payload.campaign,rulesText:'过期修改'}}),{code:'REVISION_CONFLICT'});
  await assert.rejects(f.manage('update',{...payload,campaign:{...payload.campaign,rulesText:'不同正文'}}),{code:'REQUEST_CONFLICT'});
  assert.equal((await f.state()).campaign.rulesText,'第一版');
});
test('only one competing configuration can commit its revision',async()=>{
  const f=fixture();const responses=await Promise.allSettled([1,2].map(i=>f.manage('update',{revision:0,requestId:'competing-operation-'+i,operation:'configure',reason:'并发保存',...f.configuration,total:200+i})));
  assert.equal(responses.filter(x=>x.status==='fulfilled').length,1);assert.equal(responses.find(x=>x.status==='rejected').reason.code,'REVISION_CONFLICT');assert.equal((await f.manage('snapshot')).audit.length,1);
});
test('probability boundaries support 0, 50 and 100 percent on the server',async()=>{
  for(const [bps,sample,expected]of [[0,0,'lost'],[5000,4999,'won'],[5000,5000,'lost'],[10000,9999,'won']]){const f=fixture({bps,sample});await f.setup();const result=await f.draw();assert.equal(result.entry.outcome,expected);assert.equal(result.campaign.winProbabilityBps,bps);assert.equal(f.samples(),1);}
});
test('cashier award is durable before issuance; network failure after coupon creation retries the same award and code',async()=>{
  const f=fixture();await f.setup();f.center.fail('after-issue');const first=await f.draw();assert.equal(first.entry.outcome,'won');assert.equal(first.entry.status,'issuing');assert.equal(first.entry.code,undefined);
  assert.equal(f.store.rows(COLLECTIONS.entries).length,1);assert.equal(f.center.coupons.size,1);assert.equal(first.inventory.remaining,199);
  f.center.fail('after-issue',false);const retry=await f.state();assert.equal(retry.entry.status,'pending');assert.match(retry.entry.code,/^[A-F0-9]{16}$/);assert.equal(f.center.coupons.size,1);assert.equal(f.samples(),1);
  assert.deepEqual(Object.keys(retry.entry.prize).sort(),['id','imageUrl','name']);assert.equal(JSON.stringify(retry).includes('SCARF-01'),false);
});
test('unavailable center hides stale coupon code without rerolling or losing the win',async()=>{
  const f=fixture();await f.setup();const first=await f.draw();f.center.fail('detail');const failed=await f.state();assert.equal(failed.entry.status,'issuing');assert.equal(failed.entry.code,undefined);assert.equal(failed.entry.outcome,'won');
  f.center.fail('detail',false);assert.equal((await f.state()).entry.code,first.entry.code);assert.equal(f.samples(),1);
});
test('cashier-only redemption prevents staff double fulfillment and sync counts change once under concurrency',async()=>{
  const f=fixture();await f.setup();const won=await f.draw();await assert.rejects(f.service('redeem',{code:won.entry.code},ADMIN),{code:'USE_CASHIER'});
  const coupon=[...f.center.coupons.values()][0];coupon.state='REDEEMED';coupon.redeemedAt=new Date(TIME).toISOString();
  const states=await Promise.all(Array.from({length:12},()=>f.state()));for(const s of states){assert.equal(s.entry.status,'redeemed');assert.equal(s.entry.code,undefined);}
  assert.equal(f.store.rows(COLLECTIONS.inventory)[0].redeemed,1);assert.equal((await f.manage('snapshot')).inventory.redeemed,1);
});
test('the last prize is issued once across simultaneous participants and exhausted invitations remain unconsumed',async()=>{
  const f=fixture({total:1});await f.setup();const a=await f.service('grant',{},ADMIN),b=await f.service('grant',{},ADMIN);
  const results=await Promise.allSettled([f.service('draw',{inviteCode:a.inviteCode},USER),f.service('draw',{inviteCode:b.inviteCode},USER+'2')]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.code,'SOLD_OUT');assert.equal(f.center.coupons.size,1);assert.equal(f.store.rows(COLLECTIONS.invites).filter(x=>!x.consumedBy).length,1);
});
test('changing product and validity makes a new entitlement while historical prizes retain name, product and expiry',async()=>{
  const f=fixture();await f.setup();const old=await f.draw(),oldCoupon=[...f.center.coupons.values()][0];await f.update('pause');
  const patch=structuredClone(f.configuration);patch.prize.name='越野帽';patch.prize.product={id:'p2',name:'越野帽',sku:'HAT-02',barcode:''};patch.campaign.redeemEndsAt+=3600000;
  const saved=await f.update('configure',patch);assert.notEqual(saved.prize.id,old.entry.prize.id);await f.update('resume');
  const current=await f.state();assert.equal(current.prize.name,'越野帽');assert.equal(current.entry.prize.name,'魔术头巾');assert.equal(current.entry.expiresAt,old.entry.expiresAt);assert.equal(oldCoupon.physical.product.sku,'SCARF-01');
  const next=await f.draw(USER+'2');assert.equal(next.entry.prize.name,'越野帽');assert.equal(f.center.coupons.size,2);
});
test('total cannot shrink below awards, and increasing capacity preserves previous counters and rights',async()=>{
  const f=fixture();await f.setup();await f.draw();await f.update('pause');await assert.rejects(f.update('configure',{...f.configuration,total:0}),{code:'INVALID_STOCK'});
  const changed=await f.update('configure',{...f.configuration,total:250});assert.equal(changed.inventory.awarded,1);assert.equal(changed.inventory.remaining,249);assert.equal(f.center.coupons.size,1);
});
test('old standalone awards stay outside coupon center and retain the original staff redemption route',async()=>{
  const f=fixture();f.store.seed(COLLECTIONS.campaigns,CAMPAIGN_ID,{enabled:true,startsAt:TIME-1000,endsAt:TIME+3600000,redeemEndsAt:TIME+7200000});f.store.seed(COLLECTIONS.inventory,CAMPAIGN_ID,{total:200,remaining:200,awarded:0,redeemed:0});
  const legacy=await f.draw();assert.equal(legacy.entry.fulfillment,'legacy');assert.equal(f.center.coupons.size,0);await f.update('pause');await f.update('configure',f.configuration);await f.update('resume');
  const redeemed=await f.service('redeem',{code:legacy.entry.code},ADMIN);assert.equal(redeemed.entry.status,'redeemed');assert.equal(f.center.coupons.size,0);assert.equal((await f.manage('snapshot')).inventory.redeemed,1);
});
test('HMAC management rejects browsers, tampering, replay, wrong campaign and expired requests',async()=>{
  const store=memoryStore(),key='a'.repeat(64),handler=createManagementHttp({store,key,now:()=>TIME});
  function event(patch={}){const body=JSON.stringify({campaignId:CAMPAIGN_ID,action:'snapshot',payload:{},...patch}),time=String(TIME),nonce=crypto.randomUUID();return {path:'/api/scarf-management',httpMethod:'POST',body,headers:{'Content-Type':'application/json','X-Lottery-Time':time,'X-Lottery-Nonce':nonce,'X-Lottery-Signature':crypto.createHmac('sha256',key).update(time+'\n'+nonce+'\n'+body).digest('hex')}};}
  const request=event();assert.equal((await handler(request)).statusCode,200);assert.equal(JSON.parse((await handler(request)).body).code,'REPLAYED');
  const browser=event();browser.headers.Origin='https://h5.test';assert.equal((await handler(browser)).statusCode,403);
  const forged=event();forged.body=forged.body.replace('snapshot','update');assert.equal((await handler(forged)).statusCode,401);
  assert.equal(JSON.parse((await handler(event({campaignId:'other'}))).body).code,'INVALID_CAMPAIGN');
  const expired=event();expired.headers['X-Lottery-Time']=String(TIME-61000);assert.equal((await handler(expired)).statusCode,401);
  assert.equal((await handler({...event(),path:'/api/scarf-h5/call'})).statusCode,404);
});
test('coupon center client caches trusted identity, rejects identity mismatch, and never allows public HTTP in production',async()=>{
  const config={baseUrl:'https://center.test',centerId:'center',adminToken:'x'.repeat(40),environment:'production'};let time=TIME,infoCalls=0;
  const client=createScarfCenter({config,now:()=>time,fetchFn:async(url,options)=>{assert.equal(options.headers.Origin,undefined);if(url.pathname==='/v1/info')infoCalls++;return {ok:true,json:async()=>({ok:true,data:{service:'stall-coupon-center',version:1,centerId:'center',environment:'production',role:'admin',capabilities:['lottery-catalog-v1']}})};}});
  await Promise.all(Array.from({length:20},()=>client.verify()));assert.equal(infoCalls,1);time+=60001;await client.verify();assert.equal(infoCalls,2);
  assert.throws(()=>createScarfCenter({config:{...config,baseUrl:'http://public.test'}}));
  await assert.rejects(createScarfCenter({config,fetchFn:async()=>({ok:true,json:async()=>({ok:true,data:{service:'stall-coupon-center',centerId:'other'}})})}).verify(),{code:'CENTER_UNAVAILABLE'});
});
test('clearing dates does not unlock the original coupon center identity',async()=>{
  const f=fixture();await f.setup();await f.draw();await f.update('pause');
  const draft=structuredClone(f.configuration);draft.campaign.startsAt=draft.campaign.endsAt=draft.campaign.redeemEndsAt=null;
  await f.update('configure',draft);
  const other=fakeCenter();other.centerId='another-center';const manage=createManagementService({store:f.store,center:other,now:()=>TIME});
  const state=await manage('snapshot');assert.equal(state.fulfillment.ready,false);
  for(const operation of ['configure','resume'])await assert.rejects(manage('update',{revision:state.revision,requestId:crypto.randomUUID(),reason:'换机核对',operation,...(operation==='configure'?f.configuration:{})}),{code:'CENTER_MISMATCH'});
  assert.equal((await f.state()).entry.status,'pending');
});
test('lost results never make issue or detail requests when state is polled',async()=>{
  const f=fixture({sample:9999});await f.setup();await f.draw();
  let calls=0;f.center.issue=async()=>{calls++;throw new Error('should not issue');};f.center.detail=async()=>{calls++;throw new Error('should not query');};
  for(let i=0;i<10;i++)assert.equal((await f.state()).entry.outcome,'lost');assert.equal(calls,0);assert.equal(f.samples(),1);
});
test('pausing from cashier blocks new draws while old standalone winners can still redeem once',async()=>{
  const f=fixture();f.store.seed(COLLECTIONS.campaigns,CAMPAIGN_ID,{enabled:true,startsAt:TIME-1000,endsAt:TIME+3600000,redeemEndsAt:TIME+7200000});f.store.seed(COLLECTIONS.inventory,CAMPAIGN_ID,{total:200,remaining:200,awarded:0,redeemed:0});
  const won=await f.draw();await f.update('pause');
  const first=await f.service('redeem',{code:won.entry.code},ADMIN),second=await f.service('redeem',{code:won.entry.code},ADMIN);
  assert.equal(first.alreadyRedeemed,false);assert.equal(second.alreadyRedeemed,true);assert.equal((await f.manage('snapshot')).inventory.redeemed,1);
  await assert.rejects(f.service('grant',{},ADMIN));assert.equal(f.center.coupons.size,0);
});
