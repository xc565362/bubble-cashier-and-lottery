import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createPoolManagement}=require('../lottery-backend/pool-management.cjs');
const {createService}=require('../lottery-backend/service.js');
const {createManagementCenter}=require('../lottery-backend/management-center.cjs');
const {createCenterLottery}=require('../lottery-backend/center-lottery.cjs');
const {createPhysicalCenter}=require('../lottery-backend/physical-center.cjs');
const {createCatalogCenter}=require('../lottery-backend/catalog-center.cjs');
async function fixture(){
  let tables=new Map(),tail=Promise.resolve(),ticket=0,capable=true,provisions=0;
  const store={transaction:job=>{const pending=tail.then(async()=>{const snapshot=structuredClone(tables);const result=await job({get:async(t,id)=>structuredClone(snapshot.get(t+':'+id)),set:async(t,id,value)=>snapshot.set(t+':'+id,structuredClone(value))});tables=snapshot;return result;});tail=pending.catch(()=>{});return pending;}};
  const now=()=>1800000000000,prizes=[{id:'cap',name:'旧帽子',kind:'physical',probability:50},{id:'tote',name:'旧袋子',kind:'physical',probability:50}];
  const campaign={id:'catalog-fixture',title:'目录测试',enabled:false,startsAt:now()-1000,endsAt:now()+3600000,redeemEndsAt:now()+7200000,inventory:{version:1,total:4,quantities:{cap:2,tote:2}}};
  const options={store,prizes,campaign,now,randomIndex:()=>ticket,makeCode:()=>crypto.randomBytes(8).toString('hex').toUpperCase(),entryId:id=>id,adminIds:['admin']};
  const service=createService(options);await service('initializePool',{},'admin');campaign.enabled=true;
  const pool=createPoolManagement({...options,getCenter:async catalog=>({catalogSupported:capable,prizes:Object.fromEntries(catalog.map(p=>[p.id,{quota:100,issued:0,enabled:true}]))}),provisionCatalog:async({catalog,previous})=>{provisions++;return catalog.map(p=>previous.some(old=>old.id===p.id)?p:{...p,centerCampaignId:'center-'+p.id});}});
  const update=async(operation,rest={})=>pool.update({operation,expectedRevision:(await pool.snapshot()).revision,requestId:crypto.randomUUID(),reason:'测试变更',...rest});
  return {store,service,pool,options,update,tables:()=>structuredClone(tables),ticket:value=>ticket=value,capable:value=>capable=value,provisions:()=>provisions};
}
const scarf={id:'scarf2',name:'越野头巾',shortName:'头巾',kind:'physical',imageUrl:'https://assets.example.test/scarf.png',product:{id:'local-one',name:'越野头巾',sku:'SCARF-002',barcode:'6900000000002'}};

test('public state exposes current inventory probabilities and hides them when paused',async()=>{
  const f=await fixture();await f.service('draw',{},'first');const state=await f.service('state',{},'new');
  assert.ok(Math.abs(state.prizes.find(p=>p.id==='cap').probability-100/3)<1e-10);assert.ok(Math.abs(state.prizes.find(p=>p.id==='tote').probability-200/3)<1e-10);
  await f.update('pause');assert.equal((await f.service('state',{},'new')).prizes.every(p=>p.effectiveProbability===0),true);
});

test('new prize, retirement, current draw and historic receipt use one atomic catalog',async()=>{
  const f=await fixture(),first=await f.service('draw',{},'old');const before=f.tables().get('entries:old');await f.update('pause');
  const snapshot=await f.pool.snapshot();const catalog=snapshot.catalog.map(p=>p.id==='cap'?{...p,retired:true}:p).concat(scarf);
  await f.update('configure',{catalog,mode:'fixed',quantities:{cap:1,tote:2,scarf2:2},weightsBps:{cap:0,tote:5000,scarf2:5000}});await f.update('resume');
  f.ticket(5000);const result=await f.service('draw',{},'new');assert.equal(result.prize.id,'scarf2');assert.equal(result.prize.imageUrl,scarf.imageUrl);assert.equal(result.prize.centerCampaignId,undefined);assert.equal(result.prize.product,undefined);
  const stored=f.tables().get('entries:new');assert.equal(stored.prize.centerCampaignId,'center-scarf2');assert.equal(stored.prize.product.sku,'SCARF-002');
  assert.deepEqual(f.tables().get('entries:old'),before);assert.equal((await f.service('draw',{},'old')).code,first.code);
  const state=await f.service('state',{},'next');assert.deepEqual(state.prizes.map(p=>p.id),['tote','scarf2']);assert.equal(state.catalogRevision,3);assert.equal(state.inventory.remaining,3);
});

test('display edits affect new catalog while already-issued prize snapshots remain unchanged',async()=>{
  const f=await fixture();await f.service('draw',{},'old');await f.update('pause');const snapshot=await f.pool.snapshot();
  await f.update('configure',{catalog:snapshot.catalog.map(p=>p.id==='cap'?{...p,name:'新展示名称',shortName:'新帽',imageUrl:'https://assets.example.test/new.png'}:p),mode:'inventory',quantities:{cap:2,tote:2},weightsBps:{cap:5000,tote:5000}});
  assert.equal((await f.service('state',{},'other')).prizes.find(p=>p.id==='cap').name,'新展示名称');assert.equal((await f.service('state',{},'old')).entry.prize.name,'旧帽子');
});

test('reusing an old ID for new entitlement, deleting historic IDs and invalid retirement are rejected',async()=>{
  const f=await fixture();await f.service('draw',{},'old');await f.update('pause');const snapshot=await f.pool.snapshot();
  for(const catalog of [snapshot.catalog.slice(1),snapshot.catalog.map(p=>p.id==='cap'?{...p,kind:'cash',amount:5}:p),snapshot.catalog.map(p=>p.id==='cap'?{...p,product:scarf.product}:p)])await assert.rejects(f.update('configure',{catalog,mode:'fixed',quantities:{cap:2,tote:2},weightsBps:{cap:5000,tote:5000}}));
  const before=f.tables();await assert.rejects(f.update('configure',{catalog:snapshot.catalog.map(p=>p.id==='cap'?{...p,retired:true}:p),mode:'fixed',quantities:{cap:2,tote:2},weightsBps:{cap:0,tote:10000}}));assert.deepEqual(f.tables(),before);
});

test('catalog requires upgraded center; invalid metadata and forged center reference cannot bypass provision',async()=>{
  const f=await fixture();await f.update('pause');const snapshot=await f.pool.snapshot(),input={catalog:snapshot.catalog.concat(scarf),mode:'fixed',quantities:{cap:2,tote:2,scarf2:1},weightsBps:{cap:5000,tote:5000,scarf2:0}};
  f.capable(false);await assert.rejects(f.update('configure',input),e=>e.code==='CATALOG_UNSUPPORTED');assert.equal(f.provisions(),0);assert.deepEqual((await f.pool.snapshot()).capabilities,[]);
  f.capable(true);for(const patch of [{imageUrl:'javascript:alert(1)'},{product:{id:'local',name:'missing code'}},{id:'unsafe/id'}])await assert.rejects(f.update('configure',{...input,catalog:snapshot.catalog.concat({...scarf,...patch})}));
  await f.update('configure',{...input,catalog:snapshot.catalog.concat({...scarf,centerCampaignId:'attacker-center',token:'NEVER_PUBLIC'})});const updated=await f.pool.snapshot();assert.equal(updated.catalog.find(p=>p.id==='scarf2').centerCampaignId,'center-scarf2');assert.equal(JSON.stringify(updated).includes('NEVER_PUBLIC'),false);assert.ok(updated.capabilities.includes('lottery-catalog-v1'));
});

test('management center provisions with server admin auth and stable request identity',async()=>{
  const campaign={id:'fixture',startsAt:1800000000000,redeemEndsAt:1800007200000},calls=[];
  const center=createManagementCenter({campaign,prizes:[],config:{baseUrl:'https://center.example.test',centerId:'center',adminToken:'a'.repeat(64)},fetchFn:async(url,options)=>{assert.equal(options.headers.Authorization,'Bearer '+'a'.repeat(64));calls.push([new URL(url).pathname,options.body?JSON.parse(options.body):null]);return Response.json({ok:true,data:new URL(url).pathname==='/v1/info'?{service:'stall-coupon-center',centerId:'center',environment:'production',role:'admin',capabilities:['lottery-catalog-v1']}:{campaign:{id:'created-scarf'}}});}});
  const input={catalog:[scarf],previous:[],quantities:{scarf2:3},requestId:'request-example-12345'};const result=await center.provision(input);await center.provision(input);
  assert.equal(result[0].centerCampaignId,'created-scarf');assert.deepEqual(calls[1],calls[3]);assert.equal(calls[1][1].prize.product.sku,scarf.product.sku);assert.equal(calls[1][1].campaignId,'fixture');assert.equal(JSON.stringify(result).includes('a'.repeat(64)),false);
});

test('managed center client binds admin identity and fixed issue/detail routes without leaking tokens',async()=>{
  const calls=[],config={baseUrl:'https://center.example.test',centerId:'test',adminToken:'b'.repeat(64)};
  const client=createCatalogCenter({config,fetchFn:async(url,options)=>{calls.push({path:new URL(url).pathname,body:options.body?JSON.parse(options.body):null});return Response.json({ok:true,data:new URL(url).pathname==='/v1/info'?{service:'stall-coupon-center',centerId:'test',environment:'production',role:'admin',capabilities:['lottery-catalog-v1']}:{id:'coupon'}});}});
  await client.issue('center-scarf','owner','award','A'.repeat(16));await client.detail('center-scarf','owner','coupon');assert.deepEqual(calls.map(c=>c.path),['/v1/info','/v1/lottery/issue','/v1/lottery/coupons/detail']);assert.equal(calls[1].body.code,'A'.repeat(16));assert.equal(calls[2].body.campaignId,'center-scarf');assert.equal(JSON.stringify(calls).includes(config.adminToken),false);
});

test('catalog identity verification is single-flight for 60 seconds and never caches failures',async()=>{
  let timestamp=1800000000000,infoCalls=0,release,wrong=false,issueFails=false;
  const pending=new Promise(resolve=>release=resolve),info={service:'stall-coupon-center',centerId:'test',environment:'production',role:'admin',capabilities:['lottery-catalog-v1']};
  const client=createCatalogCenter({config:{baseUrl:'https://center.example.test',centerId:'test',adminToken:'a'.repeat(64)},now:()=>timestamp,fetchFn:async(url)=>{if(new URL(url).pathname==='/v1/info'){infoCalls++;if(infoCalls===1)await pending;return Response.json({ok:true,data:wrong?{...info,centerId:'other'}:info});}return issueFails?Response.json({ok:false,code:'FORBIDDEN'},{status:403}):Response.json({ok:true,data:{id:'coupon'}});}});
  const batch=Array.from({length:30},()=>client.verify());assert.equal(infoCalls,1);release();await Promise.all(batch);await client.verify();assert.equal(infoCalls,1);
  timestamp+=60000;wrong=true;await assert.rejects(client.verify(),e=>e.code==='CATALOG_UNSUPPORTED');await assert.rejects(client.verify(),e=>e.code==='CATALOG_UNSUPPORTED');assert.equal(infoCalls,3);
  wrong=false;await client.verify();assert.equal(infoCalls,4);issueFails=true;await assert.rejects(client.issue('center-scarf','owner','award'),e=>e.code==='FORBIDDEN');issueFails=false;await client.detail('center-scarf','owner','coupon');assert.equal(infoCalls,5);
});

test('partial provision recovery increases only an unissued, unpublished matching campaign with an audited stable request',async()=>{
  const calls=[],campaign={id:'fixture',startsAt:1800000000000,redeemEndsAt:1800007200000};let issued=0,external='fixture',quota=2;
  const center=createManagementCenter({campaign,prizes:[],config:{baseUrl:'https://center.example.test',centerId:'center',adminToken:'a'.repeat(64)},fetchFn:async(url,options)=>{const route=new URL(url).pathname,body=options.body?JSON.parse(options.body):null;calls.push({route,body});return Response.json({ok:true,data:route==='/v1/info'?{service:'stall-coupon-center',centerId:'center',environment:'production',role:'admin',capabilities:['lottery-catalog-v1']}:route==='/v1/campaigns/lottery-provision'?{campaign:{id:'created-scarf',quota,issued,lotteryCatalog:{campaignId:external,prizeId:'scarf2'}}}:{id:'created-scarf',quota:3}});}});
  const input={catalog:[scarf],previous:[],quantities:{scarf2:3},requestId:'partial-request-12345',reason:'重试时改为3份'};
  await center.provision(input);await center.provision(input);const increases=calls.filter(c=>c.route==='/v1/campaigns/quota');assert.equal(increases.length,2);assert.deepEqual(increases[0].body,increases[1].body);assert.equal(increases[0].body.quota,3);assert.match(increases[0].body.reason,/未发布/);assert.notEqual(increases[0].body.requestId,calls.find(c=>c.route==='/v1/campaigns/lottery-provision').body.requestId);
  issued=1;await assert.rejects(center.provision(input),e=>e.code==='CENTER_CAPACITY');issued=0;external='other';await assert.rejects(center.provision(input),e=>e.code==='CENTER_CAPACITY');assert.equal(calls.filter(c=>c.route==='/v1/campaigns/quota').length,2);
  external='fixture';quota=5;await center.provision(input);await center.provision({...input,previous:[{...scarf,centerCampaignId:'created-scarf'}],catalog:[{...scarf,centerCampaignId:'created-scarf'}],quantities:{scarf2:8}});assert.equal(calls.filter(c=>c.route==='/v1/campaigns/quota').length,2);
});

test('managed physical award uses POS center and old catalog absence does not break an issued receipt',async()=>{
  const f=await fixture();await f.update('pause');const initial=await f.pool.snapshot();await f.update('configure',{catalog:initial.catalog.concat(scarf),mode:'fixed',quantities:{cap:2,tote:2,scarf2:2},weightsBps:{cap:0,tote:0,scarf2:10000}});await f.update('resume');
  const options={...f.options,centerConfig:{baseUrl:'https://legacy.example.test',centerId:'legacy',environment:'production',prizes:{}},physicalConfig:{stage:'active',handoffReadyAt:f.options.now()-1,baseUrl:'https://legacy.example.test',centerId:'legacy',environment:'production',prizes:{cap:{campaignId:'old-cap',token:'x'.repeat(64)},tote:{campaignId:'old-tote',token:'y'.repeat(64)}}},catalogCenterConfig:{baseUrl:'https://center.example.test',centerId:'managed',adminToken:'a'.repeat(64)}};
  let coupon;
  options.fetchFn=async(url,request)=>{const route=new URL(url).pathname;if(route==='/v1/info')return Response.json({ok:true,data:{service:'stall-coupon-center',centerId:'managed',environment:'production',role:'admin',capabilities:['lottery-catalog-v1']}});const body=JSON.parse(request.body);if(route==='/v1/lottery/issue')coupon={id:'managed-coupon',campaignId:body.campaignId,owner:body.owner,awardId:body.awardId,issuer:'campaign:'+body.campaignId,environment:'production',kind:'physical',physical:{prizeId:'scarf2',quantity:1,product:scarf.product},code:body.code,amountCents:0,minimumCents:0,startsAt:new Date(f.options.campaign.startsAt).toISOString(),expiresAt:new Date(f.options.campaign.redeemEndsAt).toISOString(),state:'AVAILABLE'};return Response.json({ok:true,data:coupon});};
  const base=createCenterLottery({...options,createService}),service=createPhysicalCenter({...options,base});const result=await service('draw',{},'managed-winner');assert.equal(result.status,'pending');assert.equal(result.prize.id,'scarf2');assert.equal(result.prize.centerCampaignId,undefined);assert.equal(result.prize.product,undefined);await assert.rejects(service('redeem',{code:result.code},'admin'),e=>e.code==='POS_REQUIRED');
  coupon.state='REDEEMED';coupon.redeemedAt=new Date(f.options.now()).toISOString();assert.equal((await service('state',{},'managed-winner')).entry.status,'redeemed');
});

test('managed cash retains cents, minimum spend and original entitlement after retirement',async()=>{
  const f=await fixture();f.options.campaign.cashFulfilment='checkout_coupon';await f.update('pause');const initial=await f.pool.snapshot();
  const cash={id:'cash029',name:'0.29元券',kind:'cash',amount:0.29,minimumCents:200};
  await f.update('configure',{catalog:initial.catalog.concat(cash),mode:'fixed',quantities:{cap:2,tote:2,cash029:2},weightsBps:{cap:0,tote:0,cash029:10000}});await f.update('resume');
  const options={...f.options,createService,centerConfig:{baseUrl:'https://legacy.example.test',centerId:'legacy',environment:'production',prizes:{}},catalogCenterConfig:{baseUrl:'https://center.example.test',centerId:'managed',adminToken:'a'.repeat(64)}};
  let coupon;
  options.fetchFn=async(url,request)=>{const route=new URL(url).pathname;if(route==='/v1/info')return Response.json({ok:true,data:{service:'stall-coupon-center',centerId:'managed',environment:'production',role:'admin',capabilities:['lottery-catalog-v1']}});const body=JSON.parse(request.body);if(route==='/v1/lottery/issue')coupon={id:'managed-cash',campaignId:body.campaignId,owner:body.owner,awardId:body.awardId,issuer:'campaign:'+body.campaignId,environment:'production',kind:'cash',code:'LJC1_'+'C'.repeat(32),amountCents:29,minimumCents:200,startsAt:new Date(f.options.campaign.startsAt).toISOString(),expiresAt:new Date(f.options.campaign.redeemEndsAt).toISOString(),state:'AVAILABLE'};return Response.json({ok:true,data:coupon});};
  const service=createCenterLottery(options);const result=await service('draw',{},'cash-winner');assert.equal(result.status,'pending');assert.equal(result.prize.amount,0.29);assert.equal(result.minimumGoodsAmountCents,200);assert.equal(result.prize.centerCampaignId,undefined);
  const original=f.tables().get('entries:cash-winner');assert.equal(original.cashCenter.amountCents,29);await f.update('pause');const snapshot=await f.pool.snapshot();await f.update('configure',{catalog:snapshot.catalog.map(p=>p.id==='cash029'?{...p,retired:true}:p),mode:'fixed',quantities:{cap:2,tote:2,cash029:1},weightsBps:{cap:5000,tote:5000,cash029:0}});
  const after=await service('state',{},'cash-winner');assert.equal(after.entry.code,result.code);assert.equal(after.prizes.some(p=>p.id==='cash029'),false);assert.equal(f.tables().get('entries:cash-winner').cashCenter.campaignId,original.cashCenter.campaignId);
});
