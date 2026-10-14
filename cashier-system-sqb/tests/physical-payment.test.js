import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {priceOrder,completeOrder} from '../src/orderLogic.js';
const require=createRequire(import.meta.url);
const {createCouponStore}=require('../coupons/store.cjs');
const {couponHttp}=require('../coupons/http.cjs');
const {createService}=require('../payments/service.cjs');
const {signedEnvelope}=require('../payments/litepos.cjs');
const {createPosFixture}=require('./helpers/posfixture.cjs');
const catalog=[['cap','BB250005','棒球帽'],['bucket','BB250003','渔夫帽'],['waist','BB240011','腰包'],['tote','BB260057','超大编织袋']].map(([id,sku,name])=>({id,sku,name,barcode:sku,productType:'sale',price:100,stock:2}));
async function fixture(t,{unknown=false}={}){
 const pos=await createPosFixture(t);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'physical-payment-'));
 const store=await createCouponStore({pool:pos.pool,ns:pos.ns,environment:'production'}),admin={id:'admin',role:'admin'};
 const call=(a,p={})=>store.dispatch(admin,a,{requestId:crypto.randomUUID(),...p});
 const server=http.createServer(couponHttp(store,{adminToken:'a'.repeat(64)}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const platform=crypto.generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
 let count=0,loseCommit=true;const opened=[];
 const open=()=>{const svc=createService({directory:path.join(dir,'pos'),resolveTerminalIp:async()=>'8.8.4.4',fetchFn:async(url,options)=>{
   const parsed=new URL(url);
   if(parsed.hostname==='coupons.example.com'){
     const r=await fetch(base+parsed.pathname+parsed.search,options);
     if(parsed.pathname.endsWith('/commit')&&loseCommit){loseCommit=false;await r.text();throw Error('lost commit response');}return r;
   }
   assert.ok(parsed.pathname.endsWith('/purchase'));count++;
   assert.equal((await call('coupons')).items[0].state,'PAYMENT_PENDING');
   if(unknown)throw Error('unknown payment response');
   const body=JSON.parse(options.body).request.body;assert.equal(Number(body.amount),10000);
   const data={...body,order_sn:'MOCK-PAID',order_type:1,order_status:4,tenders:[{tender_sn:'MOCK-T',amount:10000,pay_status:3}]};
   return new Response(signedEnvelope('response',{head:{appid:'mock',sign_type:'SHA256'},body:{result_code:'200',biz_response:{result_code:'200',data}}},platform.privateKey));
 }});opened.push(svc);return svc;};
 t.after(()=>{for(const s of opened)s.close();server.closeAllConnections();server.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const svc=open();await svc.dispatch('coupon-connect',{baseUrl:'https://coupons.example.com',adminToken:'a'.repeat(64)});
 await svc.dispatch('coupon-bind-physical-products',{products:catalog});await svc.dispatch('generate-key');
 const config={mode:'production',appid:'mock',brand_code:'MOCK',store_sn:'mock',workstation_sn:'0',operator:'QA',gateway:'https://test.shouqianba.com',platformPublicKey:platform.publicKey};
 await svc.dispatch('save-config',config);
 const c=await call('create-campaign',{name:'棒球帽',kind:'physical',physical:{prizeId:'cap',quantity:1},amountCents:0,minimumCents:0,quota:10,startsAt:new Date(Date.now()-10000).toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString()});
 const award=await call('issue',{campaignId:c.id,owner:'customer',awardId:'award',trustedCode:'ABCDEF0123456789'});
 const line=await svc.dispatch('coupon-reserve',{requestId:crypto.randomUUID(),code:award.code,checkoutId:'checkout',eligibleCents:10000});
 const draft={id:crypto.randomUUID(),orderNo:'POS'+Date.now(),method:'收钱吧',...priceOrder([{...catalog[0],qty:1},line])};
 return {svc,open,call,draft,line,config,count:()=>count,award};
}
test('physical paid mixed order survives lost commit and restart without a second charge or stock deduction',async t=>{
 const f=await fixture(t);
 const paid=await f.svc.dispatch('start',{draft:f.draft,code:'130000000000000000'});
 assert.equal(paid.state,'paid');assert.equal(f.count(),1);
 assert.equal((await f.svc.dispatch('coupon-fulfilment',{orderId:f.draft.id})).redeemed,false);
 assert.equal((await f.call('coupon',{id:f.award.id})).state,'REDEEMED');
 await assert.rejects(f.svc.dispatch('start',{draft:{...f.draft,items:[f.draft.items[0],{...f.line,qty:2}]},code:'130000000000000000'}));
 f.svc.close();const second=f.open();assert.equal((await second.dispatch('query',{id:f.draft.id})).state,'paid');
 await second.dispatch('coupon-sync');assert.equal((await second.dispatch('coupon-fulfilment',{orderId:f.draft.id})).redeemed,true);
 const ledger=completeOrder({products:catalog,orders:[]},paid.draft);
 assert.equal(ledger.products[0].stock,0);assert.equal(ledger.products[0].price,100);assert.throws(()=>completeOrder(ledger,paid.draft));
 await second.dispatch('acknowledge',{id:f.draft.id});assert.equal(f.count(),1);
});
test('physical production rights reject test payment, and unknown formal payment keeps the award locked',async t=>{
 const f=await fixture(t,{unknown:true});await f.svc.dispatch('save-config',{...f.config,mode:'test'});
 await assert.rejects(f.svc.dispatch('start',{draft:f.draft,code:'130000000000000000',confirmTestPayment:true}),/正式.*测试/);
 assert.equal(f.count(),0);await f.svc.dispatch('save-config',f.config);
 const r=await f.svc.dispatch('start',{draft:f.draft,code:'130000000000000000'});assert.notEqual(r.state,'paid');
 assert.equal((await f.call('coupon',{id:f.award.id})).state,'PAYMENT_PENDING');
 await assert.rejects(f.svc.dispatch('coupon-release',{id:f.line.externalCoupon.reservationId}),/支付流程|先核对当前收退款/);
 assert.equal((await f.svc.dispatch('coupon-fulfilment',{orderId:f.draft.id})).redeemed,false);
});
