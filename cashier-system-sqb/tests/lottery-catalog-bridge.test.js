import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {Readable} from 'node:stream';
import {createRequire} from 'node:module';
import {priceOrder,completeOrder} from '../src/orderLogic.js';
const require=createRequire(import.meta.url);
const {createCouponStore}=require('../coupons/store.cjs');
const {couponHttp}=require('../coupons/http.cjs');
const {createCouponBridge}=require('../coupons/bridge.cjs');
const {createLotteryBridge}=require('../payments/lottery.cjs');
const {resolveCatalogProduct}=require('../coupons/physical-products.cjs');
const administrator={id:'isolated-admin',role:'admin'};
const sourceProduct={id:'device-a-product',name:'联调围巾',sku:'SCARF-ISOLATED-001',barcode:'0012345678901'};
const localProduct={id:'device-b-product',name:'本机围巾',sku:sourceProduct.sku,barcode:sourceProduct.barcode,productType:'sale',price:68,stock:3};

function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bubble-catalog-bridge-'));
  const store=createCouponStore({file:path.join(directory,'coupon-development','coupons.sqlite')});
  const bridges=[];
  t.after(()=>{for(const bridge of bridges)bridge.close();store.close();fs.rmSync(directory,{recursive:true,force:true});});
  const base={campaignId:'catalog-isolated',quota:5,startsAt:new Date(Date.now()-60000).toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString()};
  function provision(prize={id:'scarf-v1',name:'联调围巾',kind:'physical',product:sourceProduct},patch={}){
    return store.dispatch(administrator,'lottery-provision',{...base,requestId:'provision-'+prize.id,prize,...patch}).campaign;
  }
  function issue(campaign,patch={}){
    return store.dispatch(administrator,'lottery-issue',{requestId:'issue-'+campaign.id,campaignId:campaign.id,owner:'isolated-owner',awardId:'isolated-award',...(campaign.kind==='physical'?{code:'0123456789ABCDEF'}:{}),...patch});
  }
  function bridge(){const result=createCouponBridge({directory});bridges.push(result);return result;}
  return {directory,store,base,provision,issue,bridge};
}

test('catalog provisions arbitrary safe physical IDs with portable product snapshots and preserves legacy campaigns',t=>{
  const f=fixture(t),campaign=f.provision();
  assert.ok(f.store.dispatch(administrator,'info').capabilities.includes('lottery-catalog-v1'));
  assert.equal(campaign.physical.prizeId,'scarf-v1');assert.equal(campaign.physical.quantity,1);
  assert.deepEqual(campaign.physical.product,sourceProduct);
  assert.equal(campaign.lotteryCatalog.campaignId,f.base.campaignId);
  const again=f.provision(undefined,{requestId:'another-provision'});assert.equal(again.id,campaign.id);
  const zero=f.provision({id:'scarf-disabled',name:'待启用围巾',kind:'physical',product:sourceProduct},{quota:0});assert.equal(zero.quota,1);
  const legacy=f.store.dispatch(administrator,'create-campaign',{...f.base,requestId:'legacy',name:'旧帽子',kind:'physical',physical:{prizeId:'cap',quantity:1},amountCents:0,minimumCents:0});
  assert.deepEqual(legacy.physical,{prizeId:'cap',quantity:1});
});

test('same catalog ID cannot change existing benefits, while new IDs leave issued awards intact',t=>{
  const f=fixture(t),campaign=f.provision(),coupon=f.issue(campaign);
  for(const patch of [
    {id:'scarf-v1',name:'换成鞋',kind:'physical',product:{...sourceProduct,sku:'SHOE-OTHER'}},
    {id:'scarf-v1',name:'现金券',kind:'cash',amount:10},
    {id:'scarf-v1',name:'还是围巾',kind:'physical',product:sourceProduct,minimumCents:100}
  ])assert.throws(()=>f.provision(patch,{requestId:'changed-'+patch.name}),/换绑|金额及门槛/);
  const newer=f.provision({id:'scarf-v2',name:'新版围巾',kind:'physical',product:{...sourceProduct,sku:'SCARF-NEW',barcode:'NEW-001'}});
  assert.notEqual(newer.id,campaign.id);
  assert.deepEqual(f.store.dispatch(administrator,'lottery-coupon',{campaignId:campaign.id,id:coupon.id,owner:coupon.owner}).physical.product,sourceProduct);
  assert.equal(f.store.dispatch(administrator,'campaigns').find(row=>row.id===campaign.id).issued,1);
});

test('provision validates identity, one item, money precision and portable product identifiers',t=>{
  const f=fixture(t);
  for(const prize of [
    {id:'../unsafe',name:'bad',kind:'physical',product:sourceProduct},
    {id:'custom-no-sku',name:'bad',kind:'physical',product:{...sourceProduct,sku:'',barcode:''}},
    {id:'custom-missing',name:'bad',kind:'physical'},
    {id:'wrong-kind',name:'bad',kind:'other'},
    {id:'bad-amount',name:'bad',kind:'cash',amount:1.001},
    {id:'zero-cash',name:'bad',kind:'cash',amount:0},
    {id:'physical-amount',name:'bad',kind:'physical',product:sourceProduct,amount:1}
  ])assert.throws(()=>f.provision(prize));
  assert.throws(()=>f.store.dispatch(administrator,'create-campaign',{...f.base,requestId:'quantity-two',name:'bad',kind:'physical',physical:{prizeId:'new-item',quantity:2,product:sourceProduct},amountCents:0,minimumCents:0}));
  const cash=f.provision({id:'cash-v2',name:'12.34元券',kind:'cash',amount:12.34,minimumCents:1500});
  assert.equal(cash.amountCents,1234);assert.equal(cash.minimumCents,1500);
});

test('admin delegated issue is campaign scoped, idempotent and rejects wrong owners or forged physical codes',t=>{
  const f=fixture(t),campaign=f.provision(),one=f.issue(campaign);
  assert.equal(one.issuer,'campaign:'+campaign.id);
  assert.deepEqual(one.physical.product,sourceProduct);
  assert.equal(f.issue(campaign,{requestId:'retry-another'}).id,one.id);
  assert.throws(()=>f.issue(campaign,{requestId:'wrong-owner',owner:'other-owner'}),{code:'AWARD_CONFLICT'});
  assert.throws(()=>f.issue(campaign,{requestId:'different-code',code:'1111111111111111'}),{code:'AWARD_CONFLICT'});
  assert.throws(()=>f.issue(campaign,{requestId:'another-award',awardId:'second-award'}),{code:'CODE_CONFLICT'});
  assert.throws(()=>f.store.dispatch(administrator,'lottery-coupon',{campaignId:campaign.id,id:one.id,owner:'wrong-owner'}),{code:'FORBIDDEN'});
  assert.throws(()=>f.store.dispatch(administrator,'issue',{requestId:'unscoped',campaignId:campaign.id,owner:'isolated-owner',awardId:'unscoped',trustedCode:'1111111111111111'}),{code:'FORBIDDEN'});
  const cash=f.provision({id:'cash-safe',name:'现金券',kind:'cash',amount:5});
  assert.throws(()=>f.issue(cash,{code:'2222222222222222'}),{code:'INVALID_CODE'});
  for(const role of ['cashier','lottery']){
    const actor={id:'other-role',role,campaignId:campaign.id};
    for(const action of ['lottery-provision','lottery-issue','lottery-coupon'])assert.throws(()=>f.store.dispatch(actor,action,{requestId:'forbidden',campaignId:campaign.id}),{code:'FORBIDDEN'});
  }
  const events=f.store.dispatch(administrator,'events');
  assert.ok(events.some(row=>row.action==='lottery-provision'));
  assert.ok(events.some(row=>row.action==='issue'&&row.actor==='lottery-admin:isolated-admin'));
});

test('portable lookup uses codes rather than source computer IDs and rejects ambiguous/conflicting products',()=>{
  assert.equal(resolveCatalogProduct(sourceProduct,[localProduct]).id,'device-b-product');
  assert.equal(resolveCatalogProduct(sourceProduct,[{...localProduct,sku:'',barcode:sourceProduct.sku}]).id,'device-b-product');
  assert.throws(()=>resolveCatalogProduct(sourceProduct,[{...localProduct,sku:'unknown',barcode:'unknown'}]),/未找到/);
  assert.throws(()=>resolveCatalogProduct(sourceProduct,[localProduct,{...localProduct,id:'duplicate'}]),/多个|冲突/);
  assert.throws(()=>resolveCatalogProduct(sourceProduct,[{...localProduct,barcode:''},{...localProduct,id:'conflicting',sku:'',barcode:sourceProduct.barcode}]),/多个|冲突/);
  assert.throws(()=>resolveCatalogProduct(sourceProduct,[{...localProduct,stock:0}]),/库存不足/);
  assert.throws(()=>resolveCatalogProduct(sourceProduct,[{...localProduct,productType:'coupon'}]),/类型/);
});

test('new physical prize scans on a second computer, stays one free item and completes stock once',async t=>{
  const f=fixture(t),campaign=f.provision(),coupon=f.issue(campaign),bridge=f.bridge();
  const line=await bridge.dispatch('reserve',{requestId:'reserve-dynamic',code:coupon.code,checkoutId:'dynamic-checkout',eligibleCents:0,products:[localProduct],physical:{prizeId:'forged'}});
  assert.equal(line.id,localProduct.id);assert.equal(line.externalCoupon.prizeId,campaign.physical.prizeId);
  assert.equal(line.price,0);assert.equal(line.qty,1);assert.equal(line.productType,'gift');assert.equal(localProduct.price,68);
  const draft={id:'dynamic-zero',orderNo:'DYNAMIC-ZERO',method:'零元结算',...priceOrder([line])};
  for(const change of [{id:sourceProduct.id},{qty:2},{price:1},{sku:'changed'},{name:'another product'}])await assert.rejects(bridge.prepareDraft({...draft,items:[{...line,...change}]},'zero'));
  const result=await bridge.dispatch('zero',{draft});assert.equal(result.coupon.state,'REDEEMED');
  const updated=completeOrder({products:[localProduct],orders:[]},result.draft);
  assert.equal(updated.products[0].stock,2);assert.equal(updated.products[0].price,68);
  assert.throws(()=>completeOrder(updated,result.draft));
  await bridge.dispatch('zero-ack',{id:draft.id});assert.equal(bridge.hasPending(),false);
});

test('missing or ambiguous local catalog releases the trusted entitlement instead of leaving a hidden lock',async t=>{
  const f=fixture(t),campaign=f.provision(),coupon=f.issue(campaign),bridge=f.bridge();
  await assert.rejects(bridge.dispatch('reserve',{requestId:'no-products',code:coupon.code,checkoutId:'missing-local',eligibleCents:0}),/商品目录/);
  assert.equal(bridge.hasPending(),false);
  assert.equal(f.store.dispatch(administrator,'lottery-coupon',{campaignId:campaign.id,id:coupon.id,owner:coupon.owner}).state,'AVAILABLE');
  await assert.rejects(bridge.dispatch('reserve',{requestId:'duplicate-products',code:coupon.code,checkoutId:'duplicate-local',eligibleCents:0,products:[localProduct,{...localProduct,id:'duplicate'}]}),/多个|冲突/);
  assert.equal(bridge.hasPending(),false);
});

test('catalog management bridge refuses old servers and preserves the catalog payload on supported servers',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bubble-catalog-management-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  let supported=false;const calls=[];
  const bridge=createLotteryBridge({directory,fetchFn:async(_url,options)=>{
    const input=JSON.parse(options.body);calls.push(input);
    return {ok:true,json:async()=>({ok:true,data:input.action==='snapshot'?{service:'bubble-lottery-management',version:1,campaignId:'test-catalog',capabilities:supported?['lottery-catalog-v1']:[]}:{revision:2}})};
  }});
  await bridge.dispatch('connect',{url:'https://management.example.test/lottery',key:'a'.repeat(64),campaignId:'test-catalog'});
  const payload={operation:'configure',requestId:'catalog-update',expectedRevision:1,reason:'isolated test',catalog:[{id:'scarf-new',kind:'physical',name:'new',product:sourceProduct}]};
  await assert.rejects(bridge.dispatch('update',payload),/尚未支持完整奖项管理/);
  assert.equal(calls.filter(row=>row.action==='update').length,0);
  supported=true;await bridge.dispatch('update',payload);
  assert.deepEqual(calls.find(row=>row.action==='update').payload,payload);
});

test('new HTTP endpoints require backend admin authentication and reject browser Origin',async t=>{
  const f=fixture(t),token='a'.repeat(64),handler=couponHttp(f.store,{adminToken:token});
  async function call(url,input,headers={}){
    const req=Readable.from([Buffer.from(JSON.stringify(input))]);req.url=url;req.method='POST';req.headers={'content-type':'application/json',authorization:'Bearer '+token,...headers};
    const result={statusCode:200,headers:{},setHeader(key,value){this.headers[key]=value;},end(body){this.body=JSON.parse(body);}};
    await handler(req,result);return result;
  }
  const provision={...f.base,requestId:'http-catalog',prize:{id:'http-scarf',name:'HTTP围巾',kind:'physical',product:sourceProduct}};
  assert.equal((await call('/v1/campaigns/lottery-provision',provision,{origin:'https://browser.example.test'})).statusCode,403);
  assert.equal((await call('/v1/campaigns/lottery-provision',provision,{authorization:''})).statusCode,401);
  const campaign=(await call('/v1/campaigns/lottery-provision',provision)).body.data.campaign;
  const issued=(await call('/v1/lottery/issue',{requestId:'http-issue',campaignId:campaign.id,owner:'http-owner',awardId:'http-award',code:'ABCDEF0123456789'})).body.data;
  assert.equal(issued.issuer,'campaign:'+campaign.id);
  assert.equal((await call('/v1/lottery/coupons/detail',{campaignId:campaign.id,id:issued.id,owner:'http-owner'})).body.data.id,issued.id);
  assert.equal((await call('/v1/lottery/coupons/detail',{campaignId:campaign.id,id:issued.id,owner:'wrong-owner'})).statusCode,403);
});

async function realHttpFixture(t,store,options={}) {
  const token='isolated-http-admin-'.padEnd(64,'a');
  const server=http.createServer(couponHttp(store,{adminToken:token,now:()=>1800000000000,...options}));
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return async(route,input,headers={})=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{
      method:input===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',...headers},
      ...(input===undefined?{}:{body:typeof input==='string'?input:JSON.stringify(input)})});
    return {status:response.status,body:await response.json()};
  };
}

test('real HTTP gives each dynamic owner 60 shared issue/detail requests without consuming the 180 management requests',async t=>{
  const f=fixture(t),campaign=f.provision({id:'rate-cash',name:'rate fixture',kind:'cash',amount:1}),call=await realHttpFixture(t,f.store);
  for(let n=0;n<4;n++){
    const input={requestId:'rate-issue-'+n,campaignId:campaign.id,owner:'rate-owner-'+n,awardId:'rate-award-'+n};
    const issued=await call('/v1/lottery/issue',input);assert.equal(issued.status,200);
    const detail={campaignId:campaign.id,id:issued.body.data.id,owner:input.owner};
    for(let count=1;count<60;count++){
      const result=count%2?await call('/v1/lottery/coupons/detail',detail):await call('/v1/lottery/issue',input);
      assert.equal(result.status,200,`owner ${n}, request ${count+1}`);
    }
    assert.equal((await call('/v1/lottery/coupons/detail',detail)).status,429);
  }
  for(let n=0;n<180;n++)assert.equal((await call('/v1/info')).status,200,`management request ${n+1}`);
  assert.equal((await call('/v1/info')).status,429);
  const fresh=await call('/v1/lottery/issue',{requestId:'fresh-after-admin-limit',campaignId:campaign.id,owner:'fresh-owner',awardId:'fresh-award'});
  assert.equal(fresh.status,200);
});

test('real HTTP aggregate includes invalid owners, rejects unauthenticated and malformed bodies before quota, and isolates management',async t=>{
  const f=fixture(t),campaign=f.provision({id:'aggregate-cash',name:'aggregate fixture',kind:'cash',amount:1});
  const call=await realHttpFixture(t,f.store,{catalogAggregateRateLimit:3});
  const input={requestId:'aggregate-issue',campaignId:campaign.id,owner:'aggregate-owner',awardId:'aggregate-award'};
  assert.equal((await call('/v1/lottery/issue',input,{authorization:''})).status,401);
  assert.equal((await call('/v1/lottery/issue','{')).status,400);
  assert.equal((await call('/v1/lottery/issue',{...input,owner:'x'.repeat(121)})).status,400);
  const issued=await call('/v1/lottery/issue',input);assert.equal(issued.status,200);
  assert.equal((await call('/v1/lottery/coupons/detail',{campaignId:campaign.id,id:issued.body.data.id,owner:input.owner})).status,200);
  assert.equal((await call('/v1/lottery/issue',{...input,owner:'new-owner'})).status,429);
  assert.equal((await call('/v1/lottery/issue',{...input,owner:'bad owner'})).status,429);
  assert.equal((await call('/v1/info')).status,200);
});

test('real HTTP catalog owner and aggregate limits reset by minute and reject unsafe limit configuration',async t=>{
  const f=fixture(t),campaign=f.provision({id:'reset-cash',name:'reset fixture',kind:'cash',amount:1});
  let stamp=1800000000000;const call=await realHttpFixture(t,f.store,{catalogAggregateRateLimit:61,now:()=>stamp});
  const input={requestId:'reset-issue',campaignId:campaign.id,owner:'reset-owner',awardId:'reset-award'};
  const issued=await call('/v1/lottery/issue',input);assert.equal(issued.status,200);
  for(let count=1;count<60;count++)assert.equal((await call('/v1/lottery/issue',input)).status,200);
  assert.equal((await call('/v1/lottery/issue',input)).status,429);
  assert.equal((await call('/v1/lottery/issue',{...input,owner:'another-owner'})).status,429);stamp+=60000;
  assert.equal((await call('/v1/lottery/coupons/detail',{campaignId:campaign.id,id:issued.body.data.id,owner:input.owner})).status,200);
  for(const limit of [0,-1,1.5,Infinity,1000001])assert.throws(()=>couponHttp(f.store,{adminToken:'a'.repeat(64),catalogAggregateRateLimit:limit}),/上限/);
});
