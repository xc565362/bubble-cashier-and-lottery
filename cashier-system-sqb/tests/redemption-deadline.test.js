import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCouponStore } = require('../coupons/store.cjs');
const { campaign } = require('../lottery-backend/config.js');
const cutoff = Date.parse('2026-09-27T18:00:00+08:00');
const iso = new Date(cutoff).toISOString();
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadline-'));
  let time = cutoff - 1000;
  const file = path.join(dir, 'coupons.sqlite');
  const stores = [];
  const open = () => { const s = createCouponStore({ file, now: () => time }); stores.push(s); return s; };
  const store = open(), admin = { id: 'admin', role: 'admin' }, cashier = { id: 'cashier', role: 'cashier' };
  const call = (action, input = {}, actor = admin) => store.dispatch(actor, action, { requestId: crypto.randomUUID(), ...input });
  t.after(() => { for (const s of stores) s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const create = (kind = 'cash') => call('create-campaign', { name: 'Fixture', kind, amountCents: kind === 'cash' ? 500 : 0, minimumCents: 0, quota: 10,
    ...(kind === 'physical' ? { physical: { prizeId: 'cap', quantity: 1 } } : {}), startsAt: '2026-09-16T16:00:00.000Z', expiresAt: '2026-09-27T16:00:00.000Z' });
  const set = (ids, extra = {}) => call('set-deadline', { campaignIds: ids, redemptionEndsAt: iso, reason: 'User confirmed event close', ...extra });
  const issue = c => call('issue', { campaignId: c.id, owner: 'owner', awardId: crypto.randomUUID(), ...(c.kind === 'physical' ? { trustedCode: crypto.randomBytes(8).toString('hex').toUpperCase() } : {}) });
  return { store, open, call, create, set, issue, cashier, setNow: n => { time = n; } };
}

test('production draw and redemption cutoffs are September 27 18:00 Beijing, with old binding expiry intact', () => {
  assert.equal(campaign.endsAt, cutoff); assert.equal(campaign.redemptionEndsAt, cutoff);
  assert.equal(campaign.redeemEndsAt, Date.parse('2026-09-28T00:00:00+08:00'));
});

test('deadline is admin-only, atomic across campaigns, idempotent and cannot extend or target unknown campaigns', t => {
  const f = fixture(t), a = f.create(), b = f.create('physical');
  const before = f.call('campaigns');
  assert.throws(() => f.call('set-deadline', { campaignIds: [a.id], redemptionEndsAt: iso, reason: 'Denied' }, f.cashier), { code: 'FORBIDDEN' });
  for (const ids of [[a.id, 'missing'], [a.id, a.id], []]) assert.throws(() => f.set(ids));
  for (const value of ['bad', '2026-09-16T16:00:00.000Z', '2026-09-28T16:00:00.000Z']) assert.throws(() => f.set([a.id, b.id], { redemptionEndsAt: value }));
  assert.deepEqual(f.call('campaigns'), before);
  const requestId = crypto.randomUUID();
  const result = f.set([a.id, b.id], { requestId });
  assert.deepEqual(f.set([a.id, b.id], { requestId }), result);
  assert.throws(() => f.set([a.id, b.id], { requestId, reason: 'Changed' }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => f.set([a.id], { redemptionEndsAt: '2026-09-27T11:00:00.000Z' }), { code: 'INVALID_TIME' });
  assert.equal(f.call('events').filter(e => e.action === 'set-deadline').length, 2);
});

for (const kind of ['cash', 'physical']) {
  test(`${kind}: existing codes and amounts survive deadline changes; new issuance and use stop exactly at cutoff`, t => {
    const f = fixture(t), c = f.create(kind), a = f.issue(c);
    f.set([c.id]);
    const current = f.call('coupon', { id: a.id });
    assert.equal(current.code, a.code); assert.equal(current.expiresAt, a.expiresAt);
    assert.equal(current.amountCents, a.amountCents); assert.equal(current.redemptionEndsAt, iso);
    f.setNow(cutoff - 1);
    const held = f.call('reserve', { code: a.code, checkoutId: 'before', eligibleCents: kind === 'cash' ? 1000 : 0 });
    f.call('release', { id: held.reservation.id });
    f.setNow(cutoff);
    assert.throws(() => f.call('reserve', { code: a.code, checkoutId: 'late', eligibleCents: kind === 'cash' ? 1000 : 0 }), { code: 'NOT_AVAILABLE' });
    assert.throws(() => f.issue(c), { code: 'INACTIVE' });
    const expired = f.call('coupon', { id: a.id });
    assert.equal(expired.state, 'EXPIRED'); assert.equal(expired.code, undefined);
    assert.equal(f.open().dispatch({ id: 'admin', role: 'admin' }, 'campaigns')[0].redemptionEndsAt, iso);
    assert.equal(f.call('campaigns')[0].issued, 1);
  });

  test(`${kind}: pending payment may finish but unprepared reservations cannot start checkout at cutoff`, t => {
    const f = fixture(t), c = f.create(kind), a = f.issue(c), b = f.issue(c);
    f.set([c.id]);
    const eligibleCents = kind === 'cash' ? 1000 : 0, paidCents = kind === 'cash' ? 500 : 0;
    const held = f.call('reserve', { code: a.code, checkoutId: 'held', eligibleCents });
    const pending = f.call('reserve', { code: b.code, checkoutId: 'paying', eligibleCents });
    f.call('prepare', { id: pending.reservation.id, orderId: 'paying', orderNo: 'POS', eligibleCents, paidCents });
    f.setNow(cutoff);
    assert.throws(() => f.call('prepare', { id: held.reservation.id, orderId: 'late', orderNo: 'LATE', eligibleCents, paidCents }), { code: 'EXPIRED' });
    assert.equal(f.call('release', { id: held.reservation.id }).state, 'EXPIRED');
    assert.equal(f.call('reservation', { id: pending.reservation.id }).state, 'PAYMENT_PENDING');
    assert.throws(() => f.call('release', { id: pending.reservation.id, orderId: 'paying', outcome: 'unknown' }), { code: 'PAYMENT_UNKNOWN' });
    const commit = { id: pending.reservation.id, orderId: 'paying', paidCents, paymentReference: 'fixture-paid' };
    assert.equal(f.call('commit', commit).state, 'REDEEMED');
    assert.equal(f.call('commit', commit).state, 'REDEEMED');
    assert.equal(f.call('coupons', { state: 'REDEEMED' }).total, 1);
  });
}

test('unrelated campaigns are unaffected and unsuccessful pending payment releases to expired', t => {
  const f = fixture(t), targeted = f.create(), unrelated = f.create(), a = f.issue(targeted), b = f.issue(unrelated);
  f.set([targeted.id]);
  const held = f.call('reserve', { code: a.code, checkoutId: 'failing', eligibleCents: 1000 });
  f.call('prepare', { id: held.reservation.id, orderId: 'failing', orderNo: 'POS', eligibleCents: 1000, paidCents: 500 });
  f.setNow(cutoff);
  assert.equal(f.call('release', { id: held.reservation.id, orderId: 'failing', outcome: 'failed' }).state, 'EXPIRED');
  assert.equal(f.call('reserve', { code: b.code, checkoutId: 'unrelated', eligibleCents: 1000 }).state, 'RESERVED');
});
