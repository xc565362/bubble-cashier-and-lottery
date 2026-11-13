import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCouponStore } = require('../coupons/store.cjs');
const { createPosFixture } = require('./helpers/posfixture.cjs');
const admin = { id: 'admin', role: 'admin' };
const cashier = { id: 'cashier', role: 'cashier' };
async function fixture(t) {
  const pos = await createPosFixture(t);
  let store = await createCouponStore({ pool: pos.pool, ns: pos.ns });
  const call = (action, input = {}, actor = admin) => store.dispatch(actor, action, { requestId: crypto.randomUUID(), ...input });
  const campaign = await call('create-campaign', { name: 'Voucher', amountCents: 1000, minimumCents: 0, quota: 100, startsAt: new Date(Date.now() - 10000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() });
  const issue = (input = {}) => call('issue', { campaignId: campaign.id, owner: 'owner', awardId: crypto.randomUUID(), ...input });
  const reserve = (c, checkoutId = crypto.randomUUID()) => call('reserve', { code: c.code, checkoutId, eligibleCents: 5000 }, cashier);
  const prepare = (c, orderId = crypto.randomUUID()) => call('prepare', { id: c.reservation.id, orderId, orderNo: orderId, eligibleCents: 5000, paidCents: 4000 }, cashier);
  const commit = (c, paymentReference) => call('commit', { id: c.reservation.id, orderId: c.reservation.orderId, paidCents: 4000, paymentReference }, cashier);
  return { ...pos, call, issue, reserve, prepare, commit, async restart() { store = await createCouponStore({ pool: pos.pool, ns: pos.ns }); } };
}

test('short secret survives restart, is independent of public ID and is hidden outside authorized available detail', async t => {
  const f = await fixture(t), c = await f.issue({ awardId: 'one-award' });
  assert.match(c.code, /^LJC1_[0-9A-F]{32}$/);
  assert.notEqual(c.code.slice(5), c.id.replaceAll('-', '').toUpperCase());
  await assert.rejects(f.reserve({ code: `LJC1_${c.id.replaceAll('-', '').toUpperCase()}` }));
  assert.ok(!JSON.stringify(await f.call('coupons')).includes(c.code));
  await f.restart();
  assert.equal((await f.issue({ awardId: 'one-award' })).code, c.code);
  assert.equal((await f.call('coupon', { id: c.id })).code, c.code);
  const pending = await f.prepare(await f.reserve(c));
  assert.ok(!JSON.stringify(await f.call('coupon', { id: c.id })).includes(c.code));
  await f.commit(pending, 'paid-once');
  await f.restart();
  assert.equal((await f.call('coupon', { id: c.id })).code, undefined);
  await assert.rejects(f.reserve(c), { code: 'NOT_AVAILABLE' });
});

test('historical signed QR tokens remain valid after lazy mapping migration and restart', async t => {
  const f = await fixture(t), c = await f.issue();
  const [identityRows] = await f.pool.query('SELECT data FROM pos_coupon_meta WHERE ns = ? AND id = ?', [f.ns, 'identity']);
  const identity = JSON.parse(typeof identityRows[0].data === 'string' ? identityRows[0].data : JSON.stringify(identityRows[0].data));
  // Simulate a pre-upgrade record with no token mapping row.
  await f.pool.query('DELETE FROM pos_coupon_tokens WHERE ns = ? AND coupon_id = ?', [f.ns, c.id]);
  const oldCode = `LJC1_${c.id.replaceAll('-', '')}_${crypto.createHmac('sha256', identity.secret).update(c.id).digest('base64url').slice(0, 24)}`;
  await f.restart();
  const migrated = await f.call('coupon', { id: c.id });
  assert.match(migrated.code, /^LJC1_[0-9A-F]{32}$/);
  await f.restart();
  assert.equal((await f.call('coupon', { id: c.id })).code, migrated.code);
  const r = await f.reserve({ code: oldCode });
  await f.commit(await f.prepare(r), 'legacy-payment');
  await assert.rejects(f.reserve(migrated), { code: 'NOT_AVAILABLE' });
});

test('one checkout cannot occupy two coupons, but an explicitly released unpaid checkout can switch coupons', async t => {
  const f = await fixture(t), a = await f.issue(), b = await f.issue();
  const held = await f.reserve(a, 'checkout');
  await assert.rejects(f.reserve(b, 'checkout'), { code: 'CHECKOUT_CONFLICT' });
  await f.call('release', { id: held.reservation.id }, cashier);
  const pending = await f.prepare(await f.reserve(b, 'checkout'), 'order');
  await assert.rejects(f.call('release', { id: pending.reservation.id, orderId: 'order', outcome: 'unknown' }, cashier), { code: 'PAYMENT_UNKNOWN' });
  await assert.rejects(f.reserve(a, 'checkout'), { code: 'CHECKOUT_CONFLICT' });
  await f.commit(pending, 'payment');
  await assert.rejects(f.reserve(a, 'checkout'), { code: 'CHECKOUT_CONFLICT' });
});

test('an order and provider payment reference cannot redeem a second coupon', async t => {
  const f = await fixture(t), a = await f.prepare(await f.reserve(await f.issue()), 'same-order'), b = await f.reserve(await f.issue());
  await assert.rejects(f.prepare(b, 'same-order'), { code: 'ORDER_CONFLICT' });
  const preparedB = await f.prepare(b, 'different-order');
  await f.commit(a, 'provider-ref');
  await assert.rejects(f.commit(preparedB, 'provider-ref'), { code: 'PAYMENT_CONFLICT' });
  assert.equal((await f.call('coupon', { id: b.id })).state, 'PAYMENT_PENDING');
});

test('MySQL unique keys themselves prevent conflicting checkout, order and payment claims', async t => {
  const f = await fixture(t), a = await f.prepare(await f.reserve(await f.issue(), 'checkout-a'), 'order-a'), b = await f.reserve(await f.issue(), 'checkout-b');
  await f.commit(a, 'payment-a');
  const duplicate = error => error.code === 'ER_DUP_ENTRY';
  const update = (jsonPath, value) => f.pool.query('UPDATE pos_coupons SET data = JSON_SET(data, ?, ?) WHERE ns = ? AND id = ?', [jsonPath, value, f.ns, b.id]);
  await assert.rejects(update('$.reservation.checkoutId', 'checkout-a'), duplicate);
  await f.prepare(b, 'order-b');
  await assert.rejects(update('$.reservation.orderId', 'order-a'), duplicate);
  await assert.rejects(f.pool.query("UPDATE pos_coupons SET data = JSON_SET(data, '$.state', 'REDEEMED', '$.paymentReference', 'payment-a') WHERE ns = ? AND id = ?", [f.ns, b.id]), duplicate);
  assert.equal((await f.call('coupon', { id: b.id })).state, 'PAYMENT_PENDING');
});

test('failed token mapping creation rolls back issuance, quota, and idempotency so retry can safely issue', async t => {
  const f = await fixture(t);
  // Reject token inserts for this namespace only, mirroring a lost write.
  const trigger = `pos_tok_rej_${f.ns}`.slice(0, 64);
  await f.pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON pos_coupon_tokens FOR EACH ROW IF NEW.ns = '${f.ns}' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fixture mapping failure'; END IF`);
  try {
    await assert.rejects(f.issue({ awardId: 'retry-award', requestId: 'retry-request' }), /fixture mapping failure/);
    assert.equal((await f.call('coupons')).total, 0);
    assert.equal((await f.call('campaigns'))[0].issued, 0);
  } finally {
    await f.pool.query(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  const c = await f.issue({ awardId: 'retry-award', requestId: 'retry-request' });
  assert.match(c.code, /^LJC1_[0-9A-F]{32}$/);
  assert.equal((await f.call('campaigns'))[0].issued, 1);
});
