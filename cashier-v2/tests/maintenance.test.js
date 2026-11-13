import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createOnlineLedger } = require('../online/ledger.cjs');
const { createPosFixture } = require('./helpers/posfixture.cjs');

const admin = { userId: 'admin', sessionId: 'session-a', role: 'admin', displayName: '管理员甲' };
const cashier = { userId: 'cashier', sessionId: 'session-c', role: 'cashier', displayName: '收银员' };
const code = expected => error => error.code === expected;

function fakeService() {
  const calls = [];
  return {
    calls,
    readOnlineState: () => structuredClone({ records: [], restoreStage: null, couponRecords: [] }),
    async dispatch(action, payload = {}) {
      calls.push({ action, payload: structuredClone(payload) });
      if (action === 'coupon-release') return { ok: true };
      throw new Error(`unexpected fake service action: ${action}`);
    },
  };
}

async function fixture(t) {
  const pos = await createPosFixture(t);
  const service = fakeService();
  let time = Date.parse('2026-11-12T06:00:00.000Z');
  const ledger = await createOnlineLedger({ pool: pos.pool, ns: pos.ns, service, now: () => time, leaseMs: 1000 });
  t.after(() => ledger.close());
  return { pos, service, ledger, advance(ms) { time += ms; } };
}

async function seedLedgerBody(pos, ns) {
  // Fresh namespace: create the ledger row with one paid, one cancelled order
  // and one stale award reservation, exactly the residue the page must surface.
  const ledger = {
    products: [], orders: [
      { id: 'order-paid', orderNo: 'N-PAID', items: [], method: '扫码收款', total: 100, status: '已收款', payment: { orderSn: 'SN-1' }, createdAt: '2026-11-12T00:00:00.000Z' },
      { id: 'order-cancelled', orderNo: 'N-CANCELLED', items: [], method: '扫码收款', total: 0, status: '已取消', payment: {}, createdAt: '2026-11-12T01:00:00.000Z' },
    ], heldCarts: [], paymentQr: {}, promoRules: [],
  };
  await pos.pool.query('INSERT INTO pos_ledger(ns, id, revision, body) VALUES(?, 1, 1, ?) ON DUPLICATE KEY UPDATE revision = 1, body = VALUES(body)', [ns, JSON.stringify(ledger)]);
  await pos.pool.query('INSERT INTO pos_awards(ns, id, owner, line) VALUES(?, ?, ?, ?)', [ns, 'award-stale', 'session-x', JSON.stringify({ id: 'external-coupon-1', name: '测试奖品', productType: 'coupon' })]);
}

test('maintenance scan surfaces hanging residue and admin tools clear exactly the safe parts', async t => {
  const f = await fixture(t);
  await seedLedgerBody(f.pos, f.pos.ns);

  const scan = await f.ledger.paymentDispatch('maintenance-scan', {}, admin);
  assert.equal(scan.hangingOrders.length, 1);
  assert.equal(scan.hangingOrders[0].id, 'order-cancelled');
  assert.equal(scan.awardReservations.length, 1);
  assert.equal(scan.awardReservations[0].name, '测试奖品');
  assert.equal(scan.latch.recoveryRequired, true); // stale award raises the latch

  // Paid orders are refused.
  await assert.rejects(f.ledger.paymentDispatch('maintenance-remove-order', { id: 'order-paid' }, admin), /已取消/);

  // The cancelled order is removed and the scan reflects it.
  const afterRemove = await f.ledger.paymentDispatch('maintenance-remove-order', { id: 'order-cancelled' }, admin);
  assert.equal(afterRemove.hangingOrders.length, 0);
  const [rows] = await f.pos.pool.query('SELECT body FROM pos_ledger WHERE ns = ? AND id = 1', [f.pos.ns]);
  const body = typeof rows[0].body === 'string' ? JSON.parse(rows[0].body) : rows[0].body;
  assert.deepEqual(body.orders.map(o => o.id), ['order-paid']);

  // Releasing the stale award calls the coupon bridge and deletes the row.
  const released = await f.ledger.paymentDispatch('maintenance-release-award', { id: 'award-stale' }, admin);
  assert.equal(released.awardRowsRemoved, 1);
  assert.ok(f.service.calls.some(c => c.action === 'coupon-release' && c.payload.id === 'award-stale'));
  const [awards] = await f.pos.pool.query('SELECT COUNT(*) n FROM pos_awards WHERE ns = ?', [f.pos.ns]);
  assert.equal(awards[0].n, 0);

  // Non-admin cannot use the tools (checked last: the pipe is session-scoped,
  // so expire the admin's pipe first so the cashier reaches the role gate).
  f.advance(2000);
  await assert.rejects(f.ledger.paymentDispatch('maintenance-scan', {}, cashier), code('FORBIDDEN'));
  await assert.rejects(f.ledger.paymentDispatch('maintenance-remove-order', { id: 'order-paid' }, cashier), code('FORBIDDEN'));
});
