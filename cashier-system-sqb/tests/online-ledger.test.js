import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createOnlineLedger } = require('../online/ledger.cjs');
const { buildPlan } = require('../payments/adjustments.cjs');
const { validateBusiness } = require('../payments/backup.cjs');
const { createService } = require('../payments/service.cjs');
const { createPosFixture } = require('./helpers/posfixture.cjs');
const admin = { userId: 'admin', sessionId: 'session-a', role: 'admin', displayName: '管理员甲' };
const other = { userId: 'other', sessionId: 'session-b', role: 'admin', displayName: '管理员乙' };
const cashier = { userId: 'cashier', sessionId: 'session-c', role: 'cashier', displayName: '收银员' };
const code = expected => error => error.code === expected;
const good = (id = 'p1', stock = 10) => ({ id, name: `商品${id}`, barcode: `bar-${id}`, sku: `sku-${id}`, group: '商品', productType: 'sale', originalPrice: 20, price: 10, couponAmount: 0, stock, giftEligible: false, imageUrl: 'https://example.test/product.jpg' });
const order = (product = good(), id = 'order-1', qty = 1) => ({ id, orderNo: `N-${id}`, items: [{ ...product, qty, discount: 0 }], method: '扫码收款', total: product.price * qty });
function fakeService() {
  const records = {}, reservations = new Map(), calls = [];
  let restoreStage = null;
  const state = { records, reservations, calls, failAck: false, failZeroAfterCommit: false, failCommitAfterApply: false,
    readOnlineState: () => structuredClone({ records: Object.values(records), restoreStage, couponRecords: [...reservations.values()] }),
    async dispatch(action, payload = {}) {
      calls.push({ action, payload: structuredClone(payload) });
      if (action === 'pending') return structuredClone(Object.values(records).filter(r => !r.acknowledged));
      if (action === 'query') return structuredClone(records[payload.id] || { id: payload.id, state: 'not-started' });
      if (action === 'start') {
        if (!records[payload.draft.id]) records[payload.draft.id] = { id: payload.draft.id, state: 'paid', acknowledged: false, orderSn: `SN-${payload.draft.id}`, amount: Math.round(payload.draft.total * 100), mode: 'test', identity: { check_sn: payload.draft.orderNo }, draft: { ...structuredClone(payload.draft), items: payload.draft.items.map(({ imageUrl, ...line }) => line) }, tenders: [], updatedAt: '2026-10-13T06:00:00.000Z' };
        return structuredClone(records[payload.draft.id]);
      }
      if (action === 'acknowledge') { if (state.onAck) state.onAck(payload.id); if (state.failAck) throw new Error('simulated journal write failure'); records[payload.id].acknowledged = true; return { ok: true }; }
      if (action === 'preview-adjustment') return buildPlan(records, { mode: 'test' }, payload.parentId, payload.request);
      if (action === 'start-adjustment') {
        if (!records[payload.request.id]) {
          const preview = await buildPlan(records, { mode: 'test' }, payload.parentId, payload.request);
          assert.equal(payload.digest, preview.digest);
          records[payload.request.id] = { id: payload.request.id, parentId: payload.parentId, kind: preview.plan.deltaCents < 0 ? 'refund' : preview.plan.deltaCents > 0 ? 'exchange-charge' : 'exchange-zero', state: preview.plan.deltaCents < 0 ? 'refunded' : preview.plan.deltaCents > 0 ? 'paid' : 'completed', plan: preview.plan, acknowledged: false, amount: Math.abs(preview.plan.deltaCents), orderSn: `SN-${payload.request.id}`, updatedAt: '2026-10-13T07:00:00.000Z', tenders: [], identity: {} };
        }
        return structuredClone(records[payload.request.id]);
      }
      if (action === 'coupon-reserve') {
        const p = payload.products.find(p => p.id === 'p1');
        const line = { ...p, productType: 'gift', price: 0, qty: 1, discount: 0, lineKey: 'lottery-gift:coupon-1', externalCoupon: { kind: 'physical', couponId: 'coupon-1', reservationId: 'reservation-1', centerId: 'test-center', environment: 'test', prizeId: 'scarf' } };
        reservations.set('reservation-1', { id: 'reservation-1', line, canRelease: true }); return line;
      }
      if (action === 'coupon-release') { reservations.delete(payload.id); return { ok: true }; }
      if (action === 'coupon-sync') return structuredClone([...reservations.values()]);
      if (action === 'coupon-zero') {
        const row = reservations.get('reservation-1'); row.zeroDraft = payload.draft; row.canRelease = false; row.redeemed = true;
        if (state.failZeroAfterCommit) { state.failZeroAfterCommit = false; throw new Error('simulated lost redemption response'); }
        return { draft: { ...structuredClone(payload.draft), items: payload.draft.items.map(({ imageUrl, ...p }) => p) }, coupon: { state: 'REDEEMED', redeemedAt: '2026-10-13T06:00:00.000Z' } };
      }
      if (action === 'coupon-zero-ack') { if (state.onZeroAck) state.onZeroAck(payload.id); if (state.failAck) throw new Error('simulated ack failure'); reservations.delete('reservation-1'); return { ok: true }; }
      if (action === 'coupon-fulfilment') return { redeemed: true };
      if (action === 'prepare-restore') { validateBusiness(payload.bundle, records); restoreStage = { token: 'restore-token', business: structuredClone(payload.bundle), records: structuredClone(records) }; return structuredClone(restoreStage); }
      if (action === 'commit-restore') { if (restoreStage) assert.equal(payload.token, restoreStage.token); restoreStage = null; if (state.failCommitAfterApply) { state.failCommitAfterApply = false; throw new Error('simulated response lost after journal restore'); } return { ok: true }; }
      if (action === 'abort-restore') { restoreStage = null; return { ok: true }; }
      if (action === 'export-backup') return structuredClone(payload.business);
      throw new Error(`unexpected fake service action: ${action}`);
    } };
  return state;
}
async function fixture(t, factory) {
  const pos = await createPosFixture(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-online-ledger-'));
  const service = factory ? factory(directory, pos.ns) : fakeService();
  let time = Date.parse('2026-10-13T06:00:00.000Z'), ledger = await createOnlineLedger({ pool: pos.pool, ns: pos.ns, service, now: () => time, leaseMs: 1000 }), sequence = 0;
  t.after(() => { ledger.close(); service.close?.(); const resolved = path.resolve(directory); assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase()); assert.match(path.basename(resolved), /^bubble-online-ledger-/); fs.rmSync(resolved, { recursive: true, force: true }); });
  return { service, get ledger() { return ledger; }, advance(ms) { time += ms; }, async reopen() { ledger.close(); ledger = await createOnlineLedger({ pool: pos.pool, ns: pos.ns, service, now: () => time, leaseMs: 1000 }); },
    acquire(who = admin, options) { return ledger.acquireLease(who, options); },
    async cmd(type, payload = {}, who = admin, options = {}) { return ledger.command({ type, payload, expectedRevision: (await ledger.snapshot(who)).revision, requestId: `request-${++sequence}`, ...options }, who); },
    async seed() { await this.acquire(); await this.cmd('product-save', { product: good() }); },
    async pay(id = 'order-1', qty = 1) { await this.cmd('payment-prepare', { draft: order(good(), id, qty) }); await ledger.paymentDispatch('start', { draft: { id }, code: 'test-only-no-network' }, admin); return this.cmd('payment-sync', { id }); } };
}

test('online ledger starts empty, requires lease and admin for catalog, persists and blocks concurrent lease', async t => {
  const f = await fixture(t); assert.deepEqual((await f.ledger.snapshot()).ledger.products, []); assert.deepEqual((await f.ledger.snapshot()).ledger.orders, []);
  await assert.rejects(f.cmd('product-save', { product: good() }), code('LEASE_REQUIRED'));
  await f.acquire(cashier); await assert.rejects(f.cmd('product-save', { product: good() }, cashier), code('FORBIDDEN'));
  await assert.rejects(f.acquire(), code('LEASE_HELD')); await assert.rejects(f.acquire(cashier, { takeover: true }), code('FORBIDDEN'));
  await f.ledger.releaseLease(cashier); await f.seed(); await f.reopen(); assert.equal((await f.ledger.snapshot(admin)).ledger.products[0].stock, 10); assert.equal((await f.ledger.snapshot(admin)).lease.mine, true);
});

test('CAS serializes concurrent tabs and durable request ID retries cannot duplicate stock', async t => {
  const f = await fixture(t); await f.seed(); const revision = (await f.ledger.snapshot(admin)).revision;
  const input = { type: 'manual-complete', payload: { draft: order() }, expectedRevision: revision, requestId: 'stable-request' };
  const results = await Promise.allSettled([f.ledger.command(input, admin), f.cmd('product-save', { product: good('p2') }, admin, { expectedRevision: revision })]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'REVISION_CONFLICT');
  await f.reopen(); await f.ledger.command(input, admin); assert.equal((await f.ledger.snapshot()).ledger.orders.length, 1); assert.equal((await f.ledger.snapshot()).ledger.products[0].stock, 9);
  await assert.rejects(f.ledger.command({ ...input, payload: { draft: order(good(), 'other-order') } }, admin), code('REQUEST_CONFLICT'));
});

test('server enforces catalog prices, stock, IDs, safe image size and rejects arbitrary ledger replacement', async t => {
  const f = await fixture(t); await f.seed();
  await assert.rejects(f.cmd('manual-complete', { draft: order({ ...good(), price: 1 }) }), code('PRICE_CHANGED'));
  await assert.rejects(f.cmd('manual-complete', { draft: order(good(), 'large-order', 11) }), code('INSUFFICIENT_STOCK'));
  await assert.rejects(f.cmd('replace', { products: [], orders: [] }), code('INVALID_COMMAND'));
  for (const imageUrl of ['javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'https://example.test/' + 'x'.repeat(2049), 'data:image/jpeg;base64,' + 'A'.repeat(2 * 1024 * 1024)]) await assert.rejects(f.cmd('product-save', { product: { ...good(), imageUrl } }), code('INVALID_INPUT'));
  await f.cmd('product-save', { product: { ...good(), imageUrl: 'data:image/jpeg;base64,/9j/' } });
  await assert.rejects(f.cmd('manual-complete', { draft: { ...order(), method: '收钱吧', payment: { provider: 'sqb', orderSn: 'forged' } } }), code('INVALID_INPUT'));
  assert.equal((await f.ledger.snapshot()).ledger.orders.length, 0);
});

test('hold/retrieve and manual revise/cancel are typed, no missing gift choices are silently lost', async t => {
  const f = await fixture(t); await f.seed(); const basket = { id: 'held-1', items: order().items, name: '暂存' };
  await assert.rejects(f.cmd('hold', { basket: { ...basket, giftChoiceQueue: [{ id: 'gift' }] } }), code('GIFT_CHOICE_REQUIRED'));
  await f.cmd('hold', { basket }); assert.equal((await f.ledger.snapshot()).ledger.products[0].stock, 10);
  const got = await f.cmd('retrieve', { id: 'held-1' }); assert.equal(got.extra.basket.items[0].price, 10); assert.equal(got.ledger.heldCarts.length, 0);
  await f.cmd('manual-complete', { draft: order(good(), 'manual-1', 2) }); assert.equal((await f.ledger.snapshot()).ledger.products[0].stock, 8);
  await f.cmd('order-revise', { id: 'manual-1', items: order().items }); assert.equal((await f.ledger.snapshot()).ledger.products[0].stock, 9);
  await f.cmd('order-revise', { id: 'manual-1', cancel: true }); assert.equal((await f.ledger.snapshot()).ledger.products[0].stock, 10);
});

test('payment prepare reserves ledger before dispatch; browser cannot substitute draft or paid record; ack follows commit', async t => {
  const f = await fixture(t); await f.seed();
  await assert.rejects(f.ledger.paymentDispatch('start', { draft: order() }, admin), code('PAYMENT_NOT_PREPARED'));
  await f.cmd('payment-prepare', { draft: order() });
  await assert.rejects(f.cmd('product-save', { product: good('p2') }), code('RECOVERY_REQUIRED'));
  await f.ledger.paymentDispatch('start', { draft: { id: 'order-1', total: 0.01, items: [] }, code: 'fake' }, admin);
  assert.equal(f.service.records['order-1'].amount, 1000);
  await assert.rejects(f.ledger.paymentDispatch('acknowledge', { id: 'order-1' }, admin), code('LEDGER_NOT_COMMITTED'));
  f.service.onAck = async key => assert.ok((await f.ledger.snapshot()).ledger.orders.some(o => o.id === key));
  await f.cmd('payment-sync', { id: 'order-1', record: { state: 'paid', amount: 1, orderSn: 'forged' } });
  assert.equal((await f.ledger.snapshot()).ledger.orders[0].payment.orderSn, 'SN-order-1'); assert.equal((await f.ledger.snapshot()).ledger.products[0].stock, 9);
  await f.cmd('payment-sync', { id: 'order-1' }); assert.equal((await f.ledger.snapshot()).ledger.orders.length, 1); assert.equal((await f.ledger.snapshot()).ledger.products[0].stock, 9);
});

test('expired owner retains pending; only explicit admin takeover and recovery may complete it', async t => {
  const f = await fixture(t); await f.seed(); await f.cmd('payment-prepare', { draft: order() });
  await f.ledger.paymentDispatch('start', { draft: { id: 'order-1' } }, admin); f.advance(2000);
  await assert.rejects(f.acquire(other), code('LEASE_HELD')); await f.acquire(other, { takeover: true });
  await assert.rejects(f.cmd('payment-sync', { id: 'order-1' }), code('LEASE_REQUIRED'));
  await assert.rejects(f.ledger.paymentDispatch('start', { draft: { id: 'order-1' } }, other), code('RECOVERY_REQUIRED'));
  const recovered = await f.cmd('recovery', {}, other); assert.equal(recovered.ledger.products[0].stock, 9); assert.equal(recovered.recoveryRequired, false);
});

test('durable acknowledgement outbox survives restart without applying paid order twice', async t => {
  const f = await fixture(t); await f.seed(); f.service.failAck = true; await f.pay();
  assert.equal((await f.ledger.snapshot()).recoveryRequired, true); assert.equal(f.service.records['order-1'].acknowledged, false);
  await f.reopen(); f.service.failAck = false; await f.cmd('recovery');
  assert.equal(f.service.records['order-1'].acknowledged, true); assert.equal((await f.ledger.snapshot()).ledger.products[0].stock, 9); assert.equal((await f.ledger.snapshot()).recoveryRequired, false);
});

test('only trusted failed or not-started payments can clear prepared intent', async t => {
  const f = await fixture(t); await f.seed(); await f.cmd('payment-prepare', { draft: order() }); await f.cmd('payment-clear', { id: 'order-1' }); assert.equal((await f.ledger.snapshot()).ledger.pendingPayment, null);
  await f.cmd('payment-prepare', { draft: order() }); await f.ledger.paymentDispatch('start', { draft: { id: 'order-1' } }, admin);
  f.service.records['order-1'].state = 'pending'; await assert.rejects(f.cmd('payment-clear', { id: 'order-1' }), code('PAYMENT_UNRESOLVED'));
  f.service.records['order-1'].state = 'failed'; await f.cmd('payment-clear', { id: 'order-1' }); assert.equal((await f.ledger.snapshot()).ledger.products[0].stock, 10);
});

test('trusted refund plan ignores display image difference and applies stock once', async t => {
  const f = await fixture(t); await f.seed(); await f.pay('order-1', 2);
  const request = { id: 'refund-1', type: 'return', returns: [{ lineId: 'order-1:0', qty: 1, restockQty: 1 }], reason: '测试退货' };
  await f.cmd('adjustment-prepare', { parentId: 'order-1', request, preview: { plan: { refundCents: 999999 } } });
  const prepared = (await f.ledger.snapshot()).ledger.pendingAdjustment; assert.equal(prepared.preview.plan.refundCents, 1000);
  await f.ledger.paymentDispatch('start-adjustment', { parentId: 'order-1', request: { ...request, returns: [{ lineId: 'order-1:0', qty: 200 }] }, digest: 'forged', confirm: true }, admin);
  await f.cmd('adjustment-sync', { id: 'refund-1', record: { state: 'refunded', amount: 5000 } });
  assert.equal((await f.ledger.snapshot()).ledger.products[0].stock, 9); assert.equal((await f.ledger.snapshot()).ledger.orders[0].afterSales.length, 1);
  await f.cmd('adjustment-sync', { id: 'refund-1' }); assert.equal((await f.ledger.snapshot()).ledger.products[0].stock, 9);
});

test('coupon reserve uses cloud catalog; zero response loss recovers exactly one redemption order and one stock change', async t => {
  const f = await fixture(t); await f.seed();
  const line = await f.ledger.paymentDispatch('coupon-reserve', { code: 'test-only', checkoutId: 'checkout-1', requestId: 'reserve-1', products: [{ ...good(), name: 'forged' }] }, admin);
  assert.equal(line.name, good().name); await assert.rejects(f.ledger.releaseLease(admin), code('AWARD_RESERVED'));
  await assert.rejects(f.cmd('product-save', { product: good() }), code('AWARD_RESERVED'));
  await assert.rejects(f.ledger.paymentDispatch('coupon-zero', { draft: {} }, admin), code('AWARD_RESERVED'));
  f.service.failZeroAfterCommit = true;
  await assert.rejects(f.cmd('zero-complete', { draft: { ...order(), id: 'zero-1', items: [line], total: 0 } }), /lost redemption response/);
  assert.equal((await f.ledger.snapshot()).ledger.products[0].stock, 10); assert.ok((await f.ledger.snapshot()).ledger.pendingZero);
  await f.reopen(); f.service.onZeroAck = async key => assert.ok((await f.ledger.snapshot()).ledger.orders.some(o => o.id === key));
  await f.cmd('recovery'); assert.equal((await f.ledger.snapshot()).ledger.orders.length, 1); assert.equal((await f.ledger.snapshot()).ledger.products[0].stock, 9); assert.equal((await f.ledger.snapshot()).ledger.pendingZero, null);
  await f.cmd('product-save', { product: { ...good(), stock: 9 } }); await f.ledger.releaseLease(admin);
});

test('coupon takeover can release orphan reservation while recovery blocks financial starts', async t => {
  const f = await fixture(t); await f.seed(); await f.ledger.paymentDispatch('coupon-reserve', { code: 'test', checkoutId: 'checkout-1', requestId: 'reserve-1' }, admin);
  f.advance(2000); await assert.rejects(f.acquire(other), code('LEASE_HELD')); await f.acquire(other, { takeover: true });
  await f.cmd('recovery', {}, other); assert.equal((await f.ledger.snapshot(other)).recoveryRequired, true);
  await f.ledger.paymentDispatch('coupon-sync', {}, other); await f.ledger.paymentDispatch('coupon-release', { id: 'reservation-1' }, other);
  await f.cmd('recovery', {}, other); assert.equal((await f.ledger.snapshot(other)).recoveryRequired, false);
});

test('initial import is empty-only, service validated, durable across lost commit response and cannot inject unsigned payment records', async t => {
  const f = await fixture(t); await f.acquire(); await f.cmd('settings-save', { paymentQr: '' });
  const bundle = { type: 'stall-cashier-backup', products: [good()], orders: [], heldCarts: [], paymentQr: '', promoRules: [] };
  f.service.failCommitAfterApply = true; await assert.rejects(f.cmd('initial-import', { bundle }), /lost after journal restore/);
  assert.ok((await f.ledger.snapshot()).ledger.pendingRestore); await f.reopen(); await f.cmd('recovery');
  assert.equal((await f.ledger.snapshot()).ledger.products.length, 1); assert.equal((await f.ledger.snapshot()).ledger.pendingRestore, null);
  await assert.rejects(f.cmd('initial-import', { bundle }), code('IMPORT_NOT_EMPTY'));
});

test('invalid import aborts prepared stage without trapping empty ledger in unrecoverable pending', async t => {
  const f = await fixture(t); await f.acquire();
  const bundle = { type: 'stall-cashier-backup', products: [{ ...good(), stock: -1 }], orders: [], heldCarts: [] };
  await assert.rejects(f.cmd('initial-import', { bundle }), code('INVALID_INPUT'));
  assert.equal((await f.ledger.snapshot()).ledger.pendingRestore, null); assert.equal(f.service.readOnlineState().restoreStage, null);
  await assert.rejects(f.cmd('initial-import', { bundle: { ...bundle, products: [], orders: [{ id: 'forged', payment: { provider: 'sqb' } }] } }), /匹配的支付记录/);
  await f.cmd('product-save', { product: good() }); assert.equal((await f.ledger.snapshot()).ledger.products.length, 1);
});

test('export ignores browser-supplied fabricated business ledger', async t => {
  const f = await fixture(t); await f.seed(); const exported = await f.ledger.paymentDispatch('export-backup', { business: { products: [], orders: [{ id: 'forged' }] } }, admin);
  assert.equal(exported.products.length, 1); assert.equal(exported.orders.length, 0);
});

test('replaying an older successful payment or refund never clears a different prepared operation', async t => {
  const f = await fixture(t); await f.seed(); await f.pay('paid-a', 2);
  await f.cmd('payment-prepare', { draft: order(good(), 'pending-b') });
  await f.cmd('payment-sync', { id: 'paid-a' }); assert.equal((await f.ledger.snapshot()).ledger.pendingPayment.draft.id, 'pending-b');
  await f.cmd('payment-clear', { id: 'pending-b' });
  const request = { id: 'refund-a', type: 'return', returns: [{ lineId: 'paid-a:0', qty: 1, restockQty: 1 }] };
  await f.cmd('adjustment-prepare', { parentId: 'paid-a', request }); await f.ledger.paymentDispatch('start-adjustment', { parentId: 'paid-a', request, confirm: true }, admin); await f.cmd('adjustment-sync', { id: 'refund-a' });
  await f.cmd('adjustment-prepare', { parentId: 'paid-a', request: { ...request, id: 'refund-b' } });
  await f.cmd('adjustment-sync', { id: 'refund-a' }); assert.equal((await f.ledger.snapshot()).ledger.pendingAdjustment.id, 'refund-b');
  assert.equal((await f.ledger.snapshot()).ledger.products[0].stock, 9);
});

test('real local coupon bridge safely releases expired reservation without stranding zero intent or reporting success', async t => {
  let clock = Date.parse('2026-10-13T06:00:00.000Z'); t.mock.method(Date, 'now', () => clock);
  const f = await fixture(t, (directory, storeNs) => createService({ directory: path.join(directory, 'payments'), fetchFn: async () => { throw new Error('network forbidden in local test'); }, storeNs }));
  await f.seed(); const uid = () => crypto.randomUUID();
  const campaign = await f.service.dispatch('coupon-create-campaign', { name: '测试券', amountCents: 1000, minimumCents: 0, quota: 10, startsAt: new Date(clock - 1000).toISOString(), expiresAt: new Date(clock + 86400000).toISOString(), requestId: uid() });
  const coupon = await f.service.dispatch('coupon-issue', { campaignId: campaign.id, owner: 'test-owner', awardId: uid(), requestId: uid() });
  const line = await f.ledger.paymentDispatch('coupon-reserve', { code: coupon.code, checkoutId: uid(), eligibleCents: 1000, requestId: uid() }, admin);
  clock += 16 * 60 * 1000; f.advance(16 * 60 * 1000); await f.acquire();
  const input = { type: 'zero-complete', payload: { draft: { ...order(), items: [...order().items, line], total: 0 } }, expectedRevision: (await f.ledger.snapshot()).revision, requestId: 'expired-zero-request' };
  await assert.rejects(f.ledger.command(input, admin), code('ZERO_CANCELLED'));
  assert.equal((await f.ledger.snapshot()).ledger.pendingZero, null); assert.equal((await f.ledger.snapshot()).ledger.orders.length, 0); assert.equal((await f.ledger.snapshot()).ledger.products[0].stock, 10);
  await assert.rejects(f.ledger.command(input, admin), code('ZERO_CANCELLED'));
  assert.equal((await f.service.dispatch('coupon-sync')).length, 0); await f.ledger.releaseLease(admin);
});

test('failed historical payment attempts without orders recover after initial import; unknown successful payments stay blocked', async t => {
  const f = await fixture(t); await f.acquire();
  f.service.records['old-failed'] = { id: 'old-failed', state: 'failed', acknowledged: false };
  await f.cmd('initial-import', { bundle: { type: 'stall-cashier-backup', products: [good()], orders: [], heldCarts: [] } });
  await f.cmd('recovery'); assert.equal(f.service.records['old-failed'].acknowledged, true); assert.equal((await f.ledger.snapshot()).ledger.orders.length, 0);
  f.service.records['unknown-paid'] = { id: 'unknown-paid', state: 'paid', acknowledged: false, orderSn: 'UNKNOWN' };
  await assert.rejects(f.cmd('recovery'), code('RECOVERY_MISMATCH')); assert.equal(f.service.records['unknown-paid'].acknowledged, false);
});

test('lease cannot be taken over while an asynchronous financial dispatch is in flight', async t => {
  const f = await fixture(t); await f.seed(); await f.cmd('payment-prepare', { draft: order() });
  const dispatch = f.service.dispatch; let resume, started;
  const began = new Promise(resolve => { started = resolve; }), hold = new Promise(resolve => { resume = resolve; });
  f.service.dispatch = async (action, payload) => { if (action === 'start') { started(); await hold; } return dispatch(action, payload); };
  const running = f.ledger.paymentDispatch('start', { draft: { id: 'order-1' } }, admin); await began;
  f.advance(2000); await assert.rejects(f.acquire(other, { takeover: true }), code('LEASE_BUSY')); resume(); await running;
  await f.acquire(other, { takeover: true }); await f.cmd('recovery', {}, other); assert.equal((await f.ledger.snapshot()).ledger.orders.length, 1);
});

test('real local service zero coupon flow uses trusted journal, commits inventory before acknowledgement and allows next sale', async t => {
  const f = await fixture(t, (directory, storeNs) => createService({ directory: path.join(directory, 'payments'), fetchFn: async () => { throw new Error('network forbidden in local test'); }, storeNs }));
  await f.seed(); const uid = () => crypto.randomUUID(), clock = Date.now();
  const campaign = await f.service.dispatch('coupon-create-campaign', { name: '测试零元券', amountCents: 1000, minimumCents: 0, quota: 10, startsAt: new Date(clock - 1000).toISOString(), expiresAt: new Date(clock + 86400000).toISOString(), requestId: uid() });
  const coupon = await f.service.dispatch('coupon-issue', { campaignId: campaign.id, owner: 'test-owner', awardId: uid(), requestId: uid() });
  const line = await f.ledger.paymentDispatch('coupon-reserve', { code: coupon.code, checkoutId: uid(), eligibleCents: 1000, requestId: uid() }, admin);
  await f.cmd('zero-complete', { draft: { ...order(), items: [...order().items, line], total: 0 } });
  assert.equal((await f.ledger.snapshot()).ledger.orders.length, 1); assert.equal((await f.ledger.snapshot()).ledger.products[0].stock, 9); assert.equal((await f.service.dispatch('coupon-sync')).length, 0);
  await f.cmd('manual-complete', { draft: order(good(), 'after-zero') }); assert.equal((await f.ledger.snapshot()).ledger.products[0].stock, 8);
});

test('lost coupon reserve response replays durable original request after restart without replacing checkout identity', async t => {
  const f = await fixture(t); await f.seed(); const dispatch = f.service.dispatch; let lose = true;
  f.service.dispatch = async (action, payload) => { const value = await dispatch(action, payload); if (action === 'coupon-reserve' && lose) { lose = false; throw new Error('simulated lost reserve response'); } return value; };
  const payload = { code: 'test-voucher', checkoutId: 'original-checkout', requestId: 'original-reserve', eligibleCents: 0 };
  await assert.rejects(f.ledger.paymentDispatch('coupon-reserve', payload, admin), /lost reserve response/);
  assert.equal((await f.ledger.snapshot()).ledger.pendingCouponReservation.input.requestId, payload.requestId);
  await assert.rejects(f.ledger.paymentDispatch('coupon-reserve', { ...payload, checkoutId: 'new-checkout' }, admin), code('RESERVATION_PENDING'));
  await f.reopen(); await f.cmd('recovery');
  const attempts = f.service.calls.filter(c => c.action === 'coupon-reserve'); assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0].payload, attempts[1].payload); assert.equal((await f.ledger.snapshot()).ledger.pendingCouponReservation, null);
  assert.equal(f.service.reservations.size, 1); await f.ledger.paymentDispatch('coupon-release', { id: 'reservation-1' }, admin); await f.ledger.releaseLease(admin);
});

test('Chinese business day rolls over at Shanghai midnight rather than UTC midnight', async t => {
  const f = await fixture(t); await f.seed(); f.advance(10 * 60 * 60 * 1000 - 60000);
  await f.cmd('manual-complete', { draft: order(good(), 'before-midnight') }).catch(async error => { if (error.code !== 'LEASE_REQUIRED') throw error; await f.acquire(); await f.cmd('manual-complete', { draft: order(good(), 'before-midnight') }); });
  assert.equal((await f.ledger.snapshot()).ledger.orders[0].day, '2026-10-13');
  f.advance(120000); await f.acquire(); await f.cmd('manual-complete', { draft: order(good(), 'after-midnight') });
  assert.equal((await f.ledger.snapshot()).ledger.orders[0].day, '2026-10-14'); assert.match((await f.ledger.snapshot()).ledger.orders[0].createdAt, /^2026-10-13T16:01/);
});

test('promotion periods entered as local date-time use Shanghai time on the server and enforce gift quantities', async t => {
  const f = await fixture(t); await f.seed(); const gift = { ...good('gift-1'), productType: 'gift', price: 0, giftEligible: true };
  await f.cmd('product-save', { product: gift });
  await f.cmd('settings-save', { promoRules: [{ id: 'rule-1', enabled: true, mode: 'choice', mainProductIds: ['p1'], gifts: [{ productId: 'gift-1', qty: 1 }], startAt: '2026-10-13T13:00', endAt: '2026-10-13T15:00' }] });
  const item = { ...gift, qty: 1, source: 'promo', promoRuleId: 'rule-1', discount: 0 };
  await assert.rejects(f.cmd('manual-complete', { draft: { ...order(), items: [...order().items, { ...item, qty: 2 }] } }), code('INVALID_PROMO'));
  await f.cmd('manual-complete', { draft: { ...order(), items: [...order().items, item] } });
  assert.equal((await f.ledger.snapshot()).ledger.products.find(p => p.id === gift.id).stock, 9);
});

test('definitive expired or paused coupon rejection clears reserve intent without releasing any other voucher', async t => {
  const f = await fixture(t); await f.seed(); const dispatch = f.service.dispatch;
  for (const reason of ['EXPIRED', 'REDEMPTION_PAUSED']) {
    f.service.dispatch = async (action, payload) => { if (action === 'coupon-reserve') throw Object.assign(new Error('test rejection'), { code: reason }); return dispatch(action, payload); };
    await assert.rejects(f.ledger.paymentDispatch('coupon-reserve', { code: 'test-voucher', checkoutId: `checkout-${reason}`, requestId: `request-${reason}`, eligibleCents: 0 }, admin), code(reason));
    assert.equal((await f.ledger.snapshot()).ledger.pendingCouponReservation, null); assert.equal((await f.ledger.snapshot()).recoveryRequired, false);
  }
  assert.equal(f.service.calls.filter(c => c.action === 'coupon-release').length, 0);
});
