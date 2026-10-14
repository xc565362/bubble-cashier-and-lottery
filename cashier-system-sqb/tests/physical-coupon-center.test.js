import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {createCouponStore}=require('../coupons/store.cjs');
const {createPosFixture}=require('./helpers/posfixture.cjs');
async function fixture(t){
  const pos=await createPosFixture(t);
  let now=Date.parse('2026-09-21T04:00:00Z');
  const open=()=>createCouponStore({pool:pos.pool,ns:pos.ns,now:()=>now});
  const center=await open();
  const admin={id:'admin',role:'admin'},staff={id:'terminal',role:'cashier'};
  const create=(override={})=>center.dispatch(admin,'create-campaign',{requestId:crypto.randomUUID(),name:'棒球帽',kind:'physical',physical:{prizeId:'cap',quantity:1},amountCents:0,minimumCents:0,quota:10,startsAt:'2026-09-17T00:00:00+08:00',expiresAt:'2026-09-28T00:00:00+08:00',...override});
  return {center,open,admin,staff,create,setNow:v=>{now=v;}};
}
function issue(f,c,override={}){return f.center.dispatch(f.admin,'issue',{requestId:'issue-1',campaignId:c.id,owner:'owner-1',awardId:'award-1',trustedCode:'AABBCCDDEEFF0011',...override});}
function reserve(f,code,override={}){return f.center.dispatch(f.staff,'reserve',{requestId:'hold-1',code,checkoutId:'checkout-1',eligibleCents:0,...override});}
function prepare(f,held,eligibleCents=0){return f.center.dispatch(f.staff,'prepare',{requestId:'prepare-1',id:held.reservation.id,orderId:'order-1',orderNo:'ORDER-1',eligibleCents,paidCents:eligibleCents});}
test('physical old barcode supports one zero-order redemption and survives reopen',async t=>{
  const f=await fixture(t),c=await f.create(),a=await issue(f,c);assert.equal(a.kind,'physical');assert.equal(a.code,'AABBCCDDEEFF0011');
  const held=await reserve(f,a.code);assert.equal(held.reservation.discountCents,0);await prepare(f,held);
  const input={requestId:'commit-1',id:held.reservation.id,orderId:'order-1',paidCents:0,paymentReference:'ZERO:order-1'};
  const used=await f.center.dispatch(f.staff,'commit',input);assert.equal(used.state,'REDEEMED');assert.equal(used.code,undefined);
  assert.equal((await (await f.open()).dispatch(f.staff,'commit',input)).state,'REDEEMED');
  await assert.rejects(reserve(f,a.code,{requestId:'again',checkoutId:'second'}),{code:'NOT_AVAILABLE'});
  assert.equal((await issue(f,c,{requestId:'issue-retry'})).state,'REDEEMED');
  assert.equal((await f.center.dispatch(f.admin,'campaigns'))[0].issued,1);
});
test('physical entitlement does not discount mixed paid goods and stays held during unknown payment',async t=>{
  const f=await fixture(t),a=await issue(f,await f.create()),held=await reserve(f,a.code,{eligibleCents:2000});
  assert.equal(held.reservation.discountCents,0);await prepare(f,held,2000);
  f.setNow(Date.parse('2026-09-21T05:00:00Z'));
  await assert.rejects(f.center.dispatch(f.staff,'release',{requestId:'unknown',id:held.reservation.id,orderId:'order-1',outcome:'unknown'}),{code:'PAYMENT_UNKNOWN'});
  assert.equal((await f.center.dispatch(f.staff,'reservation',{id:held.reservation.id})).state,'PAYMENT_PENDING');
  await assert.rejects(f.center.dispatch(f.staff,'commit',{requestId:'wrong-amount',id:held.reservation.id,orderId:'order-1',paidCents:1900,paymentReference:'paid-1'}),{code:'ORDER_MISMATCH'});
  const c=await f.center.dispatch(f.staff,'commit',{requestId:'commit-1',id:held.reservation.id,orderId:'order-1',paidCents:2000,paymentReference:'paid-1'});
  assert.equal(c.state,'REDEEMED');
});
test('old barcode and award cannot be rebound to a different owner, prize, or code',async t=>{
  const f=await fixture(t),c=await f.create(),a=await issue(f,c);
  await assert.rejects(issue(f,c,{requestId:'changed-code',trustedCode:'AABBCCDDEEFF0022'}),{code:'AWARD_CONFLICT'});
  await assert.rejects(issue(f,c,{requestId:'changed-owner',owner:'owner-2'}),{code:'AWARD_CONFLICT'});
  const other=await f.create({physical:{prizeId:'tote',quantity:1}});
  await assert.rejects(issue(f,other,{requestId:'duplicate-code',awardId:'award-2'}),{code:'CODE_CONFLICT'});
  assert.equal((await f.center.dispatch(f.admin,'campaigns')).find(x=>x.id===other.id).issued,0);
  assert.equal(a.code,'AABBCCDDEEFF0011');
});
test('two center connections cannot reserve same physical code; unpaid cancel releases',async t=>{
  const f=await fixture(t),a=await issue(f,await f.create()),held=await reserve(f,a.code),second=await f.open();
  await assert.rejects(second.dispatch({id:'another',role:'cashier'},'reserve',{requestId:'other',code:a.code,checkoutId:'other',eligibleCents:0}),{code:'NOT_AVAILABLE'});
  await f.center.dispatch(f.staff,'release',{requestId:'cancel',id:held.reservation.id});
  assert.equal((await second.dispatch({id:'another',role:'cashier'},'reserve',{requestId:'other',code:a.code,checkoutId:'other',eligibleCents:0})).state,'RESERVED');
});
test('cash zero amounts, invalid physical data and unscoped physical issuance are rejected',async t=>{
  const f=await fixture(t);
  for(const override of [{kind:'cash',physical:undefined},{physical:{prizeId:'unknown',quantity:1}},{physical:{prizeId:'cap',quantity:2}},{amountCents:1},{minimumCents:1},{kind:'other'}])await assert.rejects(f.create(override));
  const c=await f.create();
  await assert.rejects(issue(f,c,{trustedCode:'BAD'}),{code:'INVALID_CODE'});
  await assert.rejects(f.center.dispatch(f.staff,'issue',{requestId:'staff',campaignId:c.id,owner:'owner',awardId:'a',trustedCode:'AABBCCDDEEFF0011'}),{code:'FORBIDDEN'});
  const wrong={id:'issuer',role:'lottery',campaignId:'different'};
  await assert.rejects(f.center.dispatch(wrong,'issue',{requestId:'wrong',campaignId:c.id,owner:'owner',awardId:'a',trustedCode:'AABBCCDDEEFF0011'}),{code:'FORBIDDEN'});
});
test('physical award becomes expired at the fixed deadline without returning its quota',async t=>{
  const f=await fixture(t),c=await f.create(),a=await issue(f,c);f.setNow(Date.parse('2026-09-28T00:00:00+08:00'));
  await assert.rejects(reserve(f,a.code),{code:'NOT_AVAILABLE'});
  assert.equal((await f.center.dispatch(f.admin,'coupon',{id:a.id})).state,'EXPIRED');
  assert.equal((await f.center.dispatch(f.admin,'campaigns'))[0].issued,1);
});
test('physical migration may issue while redemption is held, and only admin can enable collection',async t=>{
  const f=await fixture(t),c=await f.create({redemptionEnabled:false}),a=await issue(f,c);
  await assert.rejects(reserve(f,a.code),{code:'REDEMPTION_PAUSED'});
  assert.equal((await f.center.dispatch(f.admin,'coupon',{id:a.id})).state,'AVAILABLE');
  await assert.rejects(f.center.dispatch(f.staff,'set-campaign',{requestId:'staff-enable',id:c.id,enabled:true,redemptionEnabled:true}),{code:'FORBIDDEN'});
  await f.center.dispatch(f.admin,'set-campaign',{requestId:'enable',id:c.id,enabled:true,redemptionEnabled:true});
  assert.equal((await reserve(f,a.code)).state,'RESERVED');
});
