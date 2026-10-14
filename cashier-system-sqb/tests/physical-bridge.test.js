import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {priceOrder,completeOrder} from '../src/orderLogic.js';
const require=createRequire(import.meta.url);
const {createCouponBridge}=require('../coupons/bridge.cjs');
const {createPosFixture}=require('./helpers/posfixture.cjs');
const catalog=[['cap','BB250005','棒球帽'],['bucket','BB250003','渔夫帽'],['waist','BB240011','腰包'],['tote','BB260057','超大编织袋']].map(([id,sku,name])=>({id,sku,name,barcode:sku,productType:'sale',price:100,stock:2}));
async function fixture(t,bind=true){
  const pos=await createPosFixture(t);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bubble-physical-bridge-'));
  const bridges=[];const open=()=>{const b=createCouponBridge({directory,storeNs:pos.ns});bridges.push(b);return b;};
  const bridge=open();t.after(()=>{for(const b of bridges)b.close();fs.rmSync(directory,{recursive:true,force:true});});
  const campaign=await bridge.dispatch('create-campaign',{requestId:'campaign',name:'棒球帽',kind:'physical',physical:{prizeId:'cap',quantity:1},amountCents:0,minimumCents:0,quota:10,startsAt:new Date(Date.now()-10000).toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString()});
  const award=await bridge.dispatch('issue',{requestId:'award',campaignId:campaign.id,owner:'owner',awardId:'award',trustedCode:'AABBCCDDEEFF0011'});
  if(bind)await bridge.dispatch('bind-physical-products',{products:catalog});
  const reserve=()=>bridge.dispatch('reserve',{requestId:'reserve',code:award.code,checkoutId:'checkout',eligibleCents:0});
  return {bridge,open,award,reserve};
}
test('gift-only zero checkout is recoverable and retains original product price',async t=>{
  const f=await fixture(t),line=await f.reserve();
  assert.equal(line.id,'cap');assert.equal(line.price,0);assert.equal(line.productType,'gift');assert.equal(line.qty,1);assert.equal(catalog[0].price,100);
  const draft={id:'zero-order',orderNo:'ZERO-1',method:'零元结算',...priceOrder([line])};
  const result=await f.bridge.dispatch('zero',{draft});assert.equal(result.coupon.state,'REDEEMED');
  const second=f.open();assert.equal((await second.dispatch('sync'))[0].zeroDraft.id,draft.id);
  const retry=await second.dispatch('zero',{draft});assert.equal(retry.coupon.state,'REDEEMED');
  const paid=completeOrder({products:catalog,orders:[]},retry.draft);assert.equal(paid.products[0].stock,1);assert.equal(paid.products[0].price,100);
  assert.throws(()=>completeOrder(paid,retry.draft));await second.dispatch('zero-ack',{id:draft.id});assert.equal(second.hasPending(),false);
});
test('gift binding is persisted, cannot change while held, and validates all sensitive line fields',async t=>{
  const f=await fixture(t),line=await f.reserve();
  assert.equal((await f.open().dispatch('physical-bindings')).prizes.cap.product.id,'cap');
  await assert.rejects(f.bridge.dispatch('bind-physical-products',{products:catalog}),/待|占用/);
  const base={id:'order',orderNo:'ORDER',method:'零元结算',total:0,couponDiscount:0,items:[line]};
  for(const mutation of [{qty:2},{price:1},{id:'bucket'},{productType:'sale'},{lineKey:'wrong'},{sku:'changed'}])await assert.rejects(f.bridge.prepareDraft({...base,items:[{...line,...mutation}]},'zero'));
  await assert.rejects(f.bridge.prepareDraft({...base,items:[line,{...line}]},'zero'));
  await f.bridge.prepareDraft(base,'zero');
});
test('unbound product cannot leave an untracked active entitlement reservation',async t=>{
  const f=await fixture(t,false);await assert.rejects(f.reserve(),/绑定/);
  const c=await f.bridge.dispatch('coupon',{id:f.award.id});assert.equal(c.state,'AVAILABLE');assert.equal(f.bridge.hasPending(),false);
});
test('physical mixed order pays for goods only; zero mode cannot erase payable goods',async t=>{
  const f=await fixture(t),line=await f.reserve();
  const priced=priceOrder([{...catalog[0],qty:1},line]);assert.equal(priced.total,100);
  const draft={id:'mixed',orderNo:'MIXED',method:'收钱吧',...priced};
  await assert.rejects(f.bridge.dispatch('zero',{draft:{...draft,total:0,method:'零元结算'}}));
  await f.bridge.prepareDraft(draft,'test');
  await f.bridge.settle({id:draft.id,draft,state:'paid',amount:10000,orderSn:'TEST-PAID'});
  assert.equal((await f.bridge.dispatch('coupon',{id:f.award.id})).state,'REDEEMED');
});
test('replaying reserve cannot erase a completed zero checkout awaiting local acknowledgement',async t=>{
  const f=await fixture(t),line=await f.reserve();
  const draft={id:'zero-replay',orderNo:'ZERO-REPLAY',method:'零元结算',...priceOrder([line])};
  await f.bridge.dispatch('zero',{draft});
  await assert.rejects(f.reserve(),/结算|占用|结束/);
  assert.equal((await f.bridge.dispatch('sync'))[0].zeroDraft.id,draft.id);
  assert.equal(f.bridge.hasZeroPending(),true);
});
