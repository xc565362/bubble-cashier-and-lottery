import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {priceOrder,completeOrder} from '../src/orderLogic.js';
import {normalizeDrawRecords,drawRedemptionLabel} from '../src/lotteryRecords.js';
const require=createRequire(import.meta.url);
const {createFixture,STAFF,VISITOR}=require('../scripts/dual-lottery-fixture.cjs');
const {createCouponStore}=require('../coupons/store.cjs');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
async function settle(f,ledger,code) {
  const line=await f.payments.dispatch('coupon-reserve',{code,products:ledger.products,checkoutId:crypto.randomUUID(),eligibleCents:0,requestId:crypto.randomUUID()});
  const draft={id:crypto.randomUUID(),orderNo:'RECORDS-'+crypto.randomBytes(6).toString('hex'),method:'零元结算',...priceOrder([line])};
  const result=await f.payments.dispatch('coupon-zero',{draft});
  const next=completeOrder(ledger,result.draft);await f.payments.dispatch('coupon-zero-ack',{id:draft.id});
  return next;
}
test('both real lottery services persist wins and misses, show signed records, and reflect cashier redemption without H5 resync',async t=>{
  let scarfTicket=0;
  const f=await createFixture({randomIndex:()=>325,randomBps:()=>scarfTicket});t.after(async()=>await f.close());
  assert.equal((await f.payments.dispatch('lottery-records',{})).total,0);
  assert.equal((await f.payments.dispatch('scarf-records',{})).total,0);
  const original=await f.original.call('draw',{},VISITOR);
  const invitation=await f.scarf.call('grant',{},STAFF),scarf=await f.scarf.call('draw',{inviteCode:invitation.inviteCode},VISITOR);
  scarfTicket=9999;
  const missInvite=await f.scarf.call('grant',{},STAFF),loss=await f.scarf.call('draw',{inviteCode:missInvite.inviteCode},'oRecords_MissVisitor');
  assert.equal(loss.entry.outcome,'lost');
  assert.equal((await f.original.call('draw',{},VISITOR)).code,original.code);
  assert.equal((await f.scarf.call('draw',{inviteCode:invitation.inviteCode},VISITOR)).entry.code,scarf.entry.code);
  const originalKey=hash(f.original.campaign.id+':'+VISITOR).slice(0,32),scarfKey=hash(f.scarf.campaignId+':'+VISITOR);
  const originalBefore=f.original.store.get('entries',originalKey),scarfBefore=f.scarf.store.get('bubble_scarf_entries',scarfKey);
  const originalPage=normalizeDrawRecords(await f.payments.dispatch('lottery-records',{}),f.original.campaign.id);
  const scarfPage=normalizeDrawRecords(await f.payments.dispatch('scarf-records',{}),f.scarf.campaignId);
  assert.equal(originalPage.total,1);assert.equal(scarfPage.total,2);assert.equal(scarfPage.items.filter(row=>row.outcome==='lost').length,1);
  assert.equal(originalPage.items[0].redemption.status,'AVAILABLE');assert.equal(drawRedemptionLabel(originalPage.items[0]),'可使用');
  assert.equal(scarfPage.items.find(row=>row.outcome==='won').redemption.status,'AVAILABLE');
  for(const page of [originalPage,scarfPage])assert.doesNotMatch(JSON.stringify(page),new RegExp([VISITOR,original.code,scarf.entry.code].join('|')));
  assert.deepEqual(f.original.store.get('entries',originalKey),originalBefore);assert.deepEqual(f.scarf.store.get('bubble_scarf_entries',scarfKey),scarfBefore);
  const missPage=await f.payments.dispatch('scarf-records',{outcome:'lost'});assert.equal(missPage.total,1);assert.equal(missPage.items[0].redemption.status,'not_applicable');
  const first=await f.payments.dispatch('scarf-records',{limit:1}),second=await f.payments.dispatch('scarf-records',{limit:1,cursor:first.nextCursor});
  assert.equal(first.total,2);assert.notEqual(first.items[0].recordId,second.items[0].recordId);assert.equal(second.hasMore,false);
  let ledger={products:structuredClone(f.products),orders:[]};ledger=await settle(f,ledger,original.code);ledger=await settle(f,ledger,scarf.entry.code);
  assert.equal(ledger.orders.length,2);assert.equal(ledger.products.find(p=>p.sku==='BB250005').stock,199);assert.equal(ledger.products.find(p=>p.sku==='DEMO-SCARF').stock,199);
  // Customers have not reopened H5. Its cached draw status is still pending;
  // the dashboard nevertheless reads the actual center's completed redemption.
  assert.equal(f.original.store.get('entries',originalKey).status,'pending');assert.equal(f.scarf.store.get('bubble_scarf_entries',scarfKey).status,'pending');
  for(const [kind,campaignId] of [['lottery',f.original.campaign.id],['scarf',f.scarf.campaignId]]) {
    const page=normalizeDrawRecords(await f.payments.dispatch(kind+'-records',{outcome:'won'}),campaignId);
    assert.equal(page.items.length,1);assert.equal(page.items[0].redemption.status,'REDEEMED');assert.equal(drawRedemptionLabel(page.items[0]),'已核销');assert.ok(page.items[0].redemption.redeemedAt);
  }
  assert.deepEqual(f.original.store.get('entries',originalKey),originalBefore);assert.deepEqual(f.scarf.store.get('bubble_scarf_entries',scarfKey),scarfBefore);
  // Read through a newly opened independent SQLite connection, proving that
  // the coupon/redemption state is committed storage, not an in-memory UI flag.
  // Read through a newly opened independent store connection, proving that
  // the coupon/redemption state is committed storage, not an in-memory UI flag.
  const reopened=await createCouponStore({pool:f.pool,ns:f.ns,environment:'production'});
  const bindings=[{recordId:originalKey,...originalBefore.physicalCenter,couponId:originalBefore.physicalCouponId},{recordId:scarfKey,campaignId:scarfBefore.center.campaignId,owner:'scarf-'+scarfKey,awardId:'scarf-'+scarfKey,couponId:scarfBefore.couponId}].map(({recordId,campaignId,owner,awardId,couponId})=>({recordId,campaignId,owner,awardId,couponId}));
  const saved=await reopened.dispatch(f.admin,'lottery-record-status',{centerId:f.centerId,environment:'production',refs:bindings});
  assert.ok(saved.items.every(row=>row.state==='REDEEMED'));
  assert.equal(f.counters.blockedExternalRequests,0);
});
