import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCouponStore } = require('../coupons/store.cjs');
const { createPosFixture } = require('./helpers/posfixture.cjs');

// Cash coupons pinned to the lottery entry's 16-hex code: the winner's QR scans
// directly at the till (coupon-reserve) and deducts the face value from the total.
async function fixture(t, amountCents = 500, minimumCents = 0) {
  const pos = await createPosFixture(t);
  let now = Date.parse('2026-10-19T04:00:00Z');
  const center = await createCouponStore({ pool: pos.pool, ns: pos.ns, now: () => now });
  const admin = { id: 'admin', role: 'admin' };
  const cashier = { id: 'terminal1', role: 'cashier' };
  const campaign = await center.dispatch(admin, 'create-campaign', {
    requestId: 'campaign-1', name: '5元立减金', amountCents, minimumCents, quota: 10,
    startsAt: '2026-10-01T00:00:00+08:00', expiresAt: '2026-12-31T23:59:59+08:00' });
  const key = await center.dispatch(admin, 'create-key', { requestId: 'key-1', name: 'lottery-server', role: 'lottery', campaignId: campaign.id });
  const lottery = await center.authenticate(key.token);
  const issue = (override = {}, actor = lottery) => center.dispatch(actor, 'issue',
    { requestId: 'issue-1', campaignId: campaign.id, owner: 'winner-1', awardId: '0123456789ABCDEF', trustedCode: '0123456789ABCDEF', ...override });
  return { ...pos, center, admin, cashier, campaign, lottery, issue };
}

test('lottery-pinned cash coupon keeps the entry code, deducts face value and redeems once', async t => {
  const f = await fixture(t);
  const coupon = await f.issue();
  assert.equal(coupon.kind, 'cash');
  assert.equal(coupon.code, '0123456789ABCDEF');
  assert.equal(coupon.amountCents, 500);
  assert.equal(coupon.issuer, `campaign:${f.campaign.id}`);

  // Face value is capped by the payable amount, exactly like a regular cash coupon.
  const held = await f.center.dispatch(f.cashier, 'reserve', { requestId: 'hold-1', code: '0123456789ABCDEF', checkoutId: 'checkout-1', eligibleCents: 320 });
  assert.equal(held.state, 'RESERVED');
  assert.equal(held.reservation.discountCents, 320);
  await f.center.dispatch(f.cashier, 'prepare', { requestId: 'prepare-1', id: held.reservation.id, orderId: 'order-1', orderNo: 'POS-1', eligibleCents: 320, paidCents: 0 });
  const used = await f.center.dispatch(f.cashier, 'commit', { requestId: 'commit-1', id: held.reservation.id, orderId: 'order-1', paidCents: 0, paymentReference: 'ZERO:order-1' });
  assert.equal(used.state, 'REDEEMED');
  await assert.rejects(
    f.center.dispatch(f.cashier, 'reserve', { requestId: 'hold-2', code: '0123456789ABCDEF', checkoutId: 'checkout-2', eligibleCents: 1000 }),
    { code: 'NOT_AVAILABLE' });
});

test('pinned issuance is idempotent by award and code; conflicts are rejected', async t => {
  const f = await fixture(t);
  const coupon = await f.issue();
  assert.equal((await f.issue({ requestId: 'issue-retry' })).id, coupon.id);
  await assert.rejects(f.issue({ requestId: 'issue-other', owner: 'winner-2' }), { code: 'AWARD_CONFLICT' });
  await assert.rejects(f.issue({ requestId: 'issue-changed', trustedCode: 'FEDCBA9876543210' }), { code: 'AWARD_CONFLICT' });
  await assert.rejects(f.issue({ requestId: 'issue-dup', awardId: 'FEDCBA9876543210' }), { code: 'CODE_CONFLICT' });
  await assert.rejects(f.issue({ requestId: 'issue-bad', awardId: 'AAAAAAAAAAAAAAAA', trustedCode: 'not-hex' }), { code: 'INVALID_CODE' });
  assert.equal((await f.center.dispatch(f.admin, 'campaigns'))[0].issued, 1);
});

test('pinned cash coupons honour the minimum spend at reserve time', async t => {
  const f = await fixture(t, 3000, 10000);
  const coupon = await f.issue();
  assert.equal(coupon.minimumCents, 10000);
  await assert.rejects(
    f.center.dispatch(f.cashier, 'reserve', { requestId: 'hold-1', code: coupon.code, checkoutId: 'checkout-1', eligibleCents: 9999 }),
    { code: 'MINIMUM_NOT_MET' });
  const held = await f.center.dispatch(f.cashier, 'reserve', { requestId: 'hold-2', code: coupon.code, checkoutId: 'checkout-1', eligibleCents: 10000 });
  assert.equal(held.reservation.discountCents, 3000);
});

test('unpinned cash coupons keep generated LJC1 codes; expired pinned codes cannot be reserved', async t => {
  const f = await fixture(t);
  const plain = await f.issue({ requestId: 'issue-plain', awardId: 'plain-award', trustedCode: undefined });
  assert.match(plain.code, /^LJC1_[0-9A-F]{32}$/);
  const pinned = await f.issue({ requestId: 'issue-exp', awardId: 'EEEEEEEEEEEEEEEE', trustedCode: 'EEEEEEEEEEEEEEEE' });
  await f.center.dispatch(f.admin, 'set-deadline', { requestId: 'deadline', campaignIds: [f.campaign.id], redemptionEndsAt: '2026-10-19T13:00:00+08:00', reason: 'test' });
  const later = await createCouponStore({ pool: f.pool, ns: f.ns, now: () => Date.parse('2026-10-19T06:00:00Z') });
  await assert.rejects(
    later.dispatch(f.cashier, 'reserve', { requestId: 'hold-late', code: pinned.code, checkoutId: 'c-late', eligibleCents: 1000 }),
    { code: 'NOT_AVAILABLE' });
  assert.equal((await later.dispatch(f.admin, 'coupon', { id: pinned.id })).state, 'EXPIRED');
});
