import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCouponStore } = require('../coupons/store.cjs');
const admin = { id: 'admin', role: 'admin' };
const cashier = { id: 'cashier', role: 'cashier' };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'barcode-center-'));
  const file = path.join(directory, 'center.sqlite');
  let store = createCouponStore({ file });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const call = (action, input = {}, actor = admin) => store.dispatch(actor, action, { requestId: crypto.randomUUID(), ...input });
  const campaign = call('create-campaign', { name: 'Voucher', amountCents: 1000, minimumCents: 0, quota: 100, startsAt: new Date(Date.now() - 10000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() });
  const issue = (input = {}) => call('issue', { campaignId: campaign.id, owner: 'owner', awardId: crypto.randomUUID(), ...input });
  const reserve = (c, checkoutId = crypto.randomUUID()) => call('reserve', { code: c.code, checkoutId, eligibleCents: 5000 }, cashier);
  const prepare = (c, orderId = crypto.randomUUID()) => call('prepare', { id: c.reservation.id, orderId, orderNo: orderId, eligibleCents: 5000, paidCents: 4000 }, cashier);
  const commit = (c, paymentReference) => call('commit', { id: c.reservation.id, orderId: c.reservation.orderId, paidCents: 4000, paymentReference }, cashier);
  return { file, call, issue, reserve, prepare, commit, restart() { store.close(); store = createCouponStore({ file }); } };
}

test('short secret survives restart, is independent of public ID and is hidden outside authorized available detail', t => {
  const f = fixture(t), c = f.issue({ awardId: 'one-award' });
  assert.match(c.code, /^LJC1_[0-9A-F]{32}$/);
  assert.notEqual(c.code.slice(5), c.id.replaceAll('-', '').toUpperCase());
  assert.throws(() => f.reserve({ code: `LJC1_${c.id.replaceAll('-', '').toUpperCase()}` }));
  assert.ok(!JSON.stringify(f.call('coupons')).includes(c.code));
  f.restart();
  assert.equal(f.issue({ awardId: 'one-award' }).code, c.code);
  assert.equal(f.call('coupon', { id: c.id }).code, c.code);
  const pending = f.prepare(f.reserve(c));
  assert.ok(!JSON.stringify(f.call('coupon', { id: c.id })).includes(c.code));
  f.commit(pending, 'paid-once');
  f.restart();
  assert.equal(f.call('coupon', { id: c.id }).code, undefined);
  assert.throws(() => f.reserve(c), { code: 'NOT_AVAILABLE' });
});

test('historical signed QR tokens remain valid after lazy mapping migration and restart', t => {
  const f = fixture(t), c = f.issue();
  const db = new DatabaseSync(f.file);
  const identity = JSON.parse(db.prepare("SELECT data FROM meta WHERE id='identity'").get().data);
  // Simulate a pre-upgrade database with no token mapping table.
  db.exec('DROP TABLE IF EXISTS coupon_tokens'); db.close();
  const oldCode = `LJC1_${c.id.replaceAll('-', '')}_${crypto.createHmac('sha256', identity.secret).update(c.id).digest('base64url').slice(0, 24)}`;
  f.restart();
  const migrated = f.call('coupon', { id: c.id });
  assert.match(migrated.code, /^LJC1_[0-9A-F]{32}$/);
  f.restart();
  assert.equal(f.call('coupon', { id: c.id }).code, migrated.code);
  const r = f.reserve({ code: oldCode });
  f.commit(f.prepare(r), 'legacy-payment');
  assert.throws(() => f.reserve(migrated), { code: 'NOT_AVAILABLE' });
});

test('one checkout cannot occupy two coupons, but an explicitly released unpaid checkout can switch coupons', t => {
  const f = fixture(t), a = f.issue(), b = f.issue();
  const held = f.reserve(a, 'checkout');
  assert.throws(() => f.reserve(b, 'checkout'), { code: 'CHECKOUT_CONFLICT' });
  f.call('release', { id: held.reservation.id }, cashier);
  const pending = f.prepare(f.reserve(b, 'checkout'), 'order');
  assert.throws(() => f.call('release', { id: pending.reservation.id, orderId: 'order', outcome: 'unknown' }, cashier), { code: 'PAYMENT_UNKNOWN' });
  assert.throws(() => f.reserve(a, 'checkout'), { code: 'CHECKOUT_CONFLICT' });
  f.commit(pending, 'payment');
  assert.throws(() => f.reserve(a, 'checkout'), { code: 'CHECKOUT_CONFLICT' });
});

test('an order and provider payment reference cannot redeem a second coupon', t => {
  const f = fixture(t), a = f.prepare(f.reserve(f.issue()), 'same-order'), b = f.reserve(f.issue());
  assert.throws(() => f.prepare(b, 'same-order'), { code: 'ORDER_CONFLICT' });
  const preparedB = f.prepare(b, 'different-order');
  f.commit(a, 'provider-ref');
  assert.throws(() => f.commit(preparedB, 'provider-ref'), { code: 'PAYMENT_CONFLICT' });
  assert.equal(f.call('coupon', { id: b.id }).state, 'PAYMENT_PENDING');
});

test('SQLite itself prevents conflicting checkout, order and payment claims from a second connection', t => {
  const f = fixture(t), a = f.prepare(f.reserve(f.issue(), 'checkout-a'), 'order-a'), b = f.reserve(f.issue(), 'checkout-b');
  f.commit(a, 'payment-a');
  const db = new DatabaseSync(f.file);
  try {
    const update = (jsonPath, value) => db.prepare('UPDATE coupons SET data=json_set(data,?,?) WHERE id=?').run(jsonPath, value, b.id);
    assert.throws(() => update('$.reservation.checkoutId', 'checkout-a'), /UNIQUE constraint/);
    f.prepare(b, 'order-b');
    assert.throws(() => update('$.reservation.orderId', 'order-a'), /UNIQUE constraint/);
    assert.throws(() => db.prepare("UPDATE coupons SET data=json_set(data,'$.state','REDEEMED','$.paymentReference','payment-a') WHERE id=?").run(b.id), /UNIQUE constraint/);
    assert.equal(f.call('coupon', { id: b.id }).state, 'PAYMENT_PENDING');
  } finally { db.close(); }
});

test('failed token mapping creation rolls back issuance, quota, and idempotency so retry can safely issue', t => {
  const f = fixture(t), db = new DatabaseSync(f.file);
  try {
    db.exec("CREATE TRIGGER reject_mapping BEFORE INSERT ON coupon_tokens BEGIN SELECT RAISE(ABORT,'fixture mapping failure'); END;");
    assert.throws(() => f.issue({ awardId: 'retry-award', requestId: 'retry-request' }), /fixture mapping failure/);
    assert.equal(f.call('coupons').total, 0);
    assert.equal(f.call('campaigns')[0].issued, 0);
    db.exec('DROP TRIGGER reject_mapping');
    const c = f.issue({ awardId: 'retry-award', requestId: 'retry-request' });
    assert.match(c.code, /^LJC1_[0-9A-F]{32}$/);
    assert.equal(f.call('campaigns')[0].issued, 1);
  } finally { db.close(); }
});
