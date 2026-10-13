import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {createCouponStore}=require('../coupons/store.cjs');
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bubble-physical-center-'));
  const file=path.join(directory,'center.sqlite'); let now=Date.parse('2026-09-21T04:00:00Z');
  const stores=[]; const open=()=>{const s=createCouponStore({file,now:()=>now});stores.push(s);return s;};
  const center=open();t.after(()=>{for(const s of stores)s.close();fs.rmSync(directory,{recursive:true,force:true});});
  const admin={id:'admin',role:'admin'},staff={id:'terminal',role:'cashier'};
  const create=(override={})=>center.dispatch(admin,'create-campaign',{requestId:crypto.randomUUID(),name:'棒球帽',kind:'physical',physical:{prizeId:'cap',quantity:1},amountCents:0,minimumCents:0,quota:10,startsAt:'2026-09-17T00:00:00+08:00',expiresAt:'2026-09-28T00:00:00+08:00',...override});
  return {center,open,admin,staff,create,setNow:v=>{now=v;}};
}
function issue(f,c,override={}){return f.center.dispatch(f.admin,'issue',{requestId:'issue-1',campaignId:c.id,owner:'owner-1',awardId:'award-1',trustedCode:'AABBCCDDEEFF0011',...override});}
function reserve(f,code,override={}){return f.center.dispatch(f.staff,'reserve',{requestId:'hold-1',code,checkoutId:'checkout-1',eligibleCents:0,...override});}
function prepare(f,held,eligibleCents=0){return f.center.dispatch(f.staff,'prepare',{requestId:'prepare-1',id:held.reservation.id,orderId:'order-1',orderNo:'ORDER-1',eligibleCents,paidCents:eligibleCents});}
test('physical old barcode supports one zero-order redemption and survives reopen',t=>{
  const f=fixture(t),c=f.create(),a=issue(f,c);assert.equal(a.kind,'physical');assert.equal(a.code,'AABBCCDDEEFF0011');
  const held=reserve(f,a.code);assert.equal(held.reservation.discountCents,0);prepare(f,held);
  const input={requestId:'commit-1',id:held.reservation.id,orderId:'order-1',paidCents:0,paymentReference:'ZERO:order-1'};
  const used=f.center.dispatch(f.staff,'commit',input);assert.equal(used.state,'REDEEMED');assert.equal(used.code,undefined);
  assert.equal(f.open().dispatch(f.staff,'commit',input).state,'REDEEMED');
  assert.throws(()=>reserve(f,a.code,{requestId:'again',checkoutId:'second'}),{code:'NOT_AVAILABLE'});
  assert.equal(issue(f,c,{requestId:'issue-retry'}).state,'REDEEMED');
  assert.equal(f.center.dispatch(f.admin,'campaigns')[0].issued,1);
});
test('physical entitlement does not discount mixed paid goods and stays held during unknown payment',t=>{
  const f=fixture(t),a=issue(f,f.create()),held=reserve(f,a.code,{eligibleCents:2000});
  assert.equal(held.reservation.discountCents,0);prepare(f,held,2000);
  f.setNow(Date.parse('2026-09-21T05:00:00Z'));
  assert.throws(()=>f.center.dispatch(f.staff,'release',{requestId:'unknown',id:held.reservation.id,orderId:'order-1',outcome:'unknown'}),{code:'PAYMENT_UNKNOWN'});
  assert.equal(f.center.dispatch(f.staff,'reservation',{id:held.reservation.id}).state,'PAYMENT_PENDING');
  assert.throws(()=>f.center.dispatch(f.staff,'commit',{requestId:'wrong-amount',id:held.reservation.id,orderId:'order-1',paidCents:1900,paymentReference:'paid-1'}),{code:'ORDER_MISMATCH'});
  const c=f.center.dispatch(f.staff,'commit',{requestId:'commit-1',id:held.reservation.id,orderId:'order-1',paidCents:2000,paymentReference:'paid-1'});
  assert.equal(c.state,'REDEEMED');
});
test('old barcode and award cannot be rebound to a different owner, prize, or code',t=>{
  const f=fixture(t),c=f.create(),a=issue(f,c);
  assert.throws(()=>issue(f,c,{requestId:'changed-code',trustedCode:'AABBCCDDEEFF0022'}),{code:'AWARD_CONFLICT'});
  assert.throws(()=>issue(f,c,{requestId:'changed-owner',owner:'owner-2'}),{code:'AWARD_CONFLICT'});
  const other=f.create({physical:{prizeId:'tote',quantity:1}});
  assert.throws(()=>issue(f,other,{requestId:'duplicate-code',awardId:'award-2'}),{code:'CODE_CONFLICT'});
  assert.equal(f.center.dispatch(f.admin,'campaigns').find(x=>x.id===other.id).issued,0);
  assert.equal(a.code,'AABBCCDDEEFF0011');
});
test('two center connections cannot reserve same physical code; unpaid cancel releases',t=>{
  const f=fixture(t),a=issue(f,f.create()),held=reserve(f,a.code),second=f.open();
  assert.throws(()=>second.dispatch({id:'another',role:'cashier'},'reserve',{requestId:'other',code:a.code,checkoutId:'other',eligibleCents:0}),{code:'NOT_AVAILABLE'});
  f.center.dispatch(f.staff,'release',{requestId:'cancel',id:held.reservation.id});
  assert.equal(second.dispatch({id:'another',role:'cashier'},'reserve',{requestId:'other',code:a.code,checkoutId:'other',eligibleCents:0}).state,'RESERVED');
});
test('cash zero amounts, invalid physical data and unscoped physical issuance are rejected',t=>{
  const f=fixture(t);
  for(const override of [{kind:'cash',physical:undefined},{physical:{prizeId:'unknown',quantity:1}},{physical:{prizeId:'cap',quantity:2}},{amountCents:1},{minimumCents:1},{kind:'other'}])assert.throws(()=>f.create(override));
  const c=f.create();
  assert.throws(()=>issue(f,c,{trustedCode:'BAD'}),{code:'INVALID_CODE'});
  assert.throws(()=>f.center.dispatch(f.staff,'issue',{requestId:'staff',campaignId:c.id,owner:'owner',awardId:'a',trustedCode:'AABBCCDDEEFF0011'}),{code:'FORBIDDEN'});
  const wrong={id:'issuer',role:'lottery',campaignId:'different'};
  assert.throws(()=>f.center.dispatch(wrong,'issue',{requestId:'wrong',campaignId:c.id,owner:'owner',awardId:'a',trustedCode:'AABBCCDDEEFF0011'}),{code:'FORBIDDEN'});
});
test('physical award becomes expired at the fixed deadline without returning its quota',t=>{
  const f=fixture(t),c=f.create(),a=issue(f,c);f.setNow(Date.parse('2026-09-28T00:00:00+08:00'));
  assert.throws(()=>reserve(f,a.code),{code:'NOT_AVAILABLE'});
  assert.equal(f.center.dispatch(f.admin,'coupon',{id:a.id}).state,'EXPIRED');
  assert.equal(f.center.dispatch(f.admin,'campaigns')[0].issued,1);
});
test('physical migration may issue while redemption is held, and only admin can enable collection',t=>{
  const f=fixture(t),c=f.create({redemptionEnabled:false}),a=issue(f,c);
  assert.throws(()=>reserve(f,a.code),{code:'REDEMPTION_PAUSED'});
  assert.equal(f.center.dispatch(f.admin,'coupon',{id:a.id}).state,'AVAILABLE');
  assert.throws(()=>f.center.dispatch(f.staff,'set-campaign',{requestId:'staff-enable',id:c.id,enabled:true,redemptionEnabled:true}),{code:'FORBIDDEN'});
  f.center.dispatch(f.admin,'set-campaign',{requestId:'enable',id:c.id,enabled:true,redemptionEnabled:true});
  assert.equal(reserve(f,a.code).state,'RESERVED');
});
