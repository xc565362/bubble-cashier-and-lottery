import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { priceOrder, completeSqbOrder, reviseOrder } from '../src/orderLogic.js';
import { saleLines, remainingLines, adjustmentPlan, applyAdjustment, orderNet, financialEvents, financialExportRows } from '../src/afterSales.js';
const require = createRequire(import.meta.url);
const { createService } = require('../payments/service.cjs');
const { signedEnvelope, refundResultState } = require('../payments/litepos.cjs');
const { safeMessage } = require('../payments/diagnostics.cjs');
const platform = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const config = { mode: 'production', appid: 'mock', brand_code: 'MOCK', store_sn: 'mock-store', workstation_sn: '0', operator: 'Test', gateway: 'https://test.shouqianba.com', platformPublicKey: platform.publicKey };
const code = '130000000000000000';
const item = { id: 'p1', name: 'Product', barcode: 'ITEM-A', sku: 'A', price: 10, qty: 2, discount: 1, productType: 'sale', stock: 10 };
const gift = { id: 'g1', name: 'Gift', barcode: 'GIFT', price: 0, qty: 1, productType: 'gift', stock: 10 };
const coupon = { id: 'c1', name: 'Coupon', barcode: 'COUPON', price: 0, qty: 1, productType: 'coupon', couponAmount: 3, stock: 0 };
const replacement = { id: 'p2', name: 'Replacement', price: 25, qty: 1, discount: 0, productType: 'sale', stock: 10 };
const at = '2026-09-17T14:00:00+08:00';
const response = (data) => new Response(signedEnvelope('response', { head: { appid: config.appid, sign_type: 'SHA256' }, body: { result_code: '200', biz_response: { result_code: '200', data } } }, platform.privateKey));

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqb-refund-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const remote = new Map();
  const state = { refundStatus: 4, offline: false, external: false, rejectSignature: false, lostRefundResponse: false };
  const queryData = (body) => {
    const refund = body.amount < 0;
    const status = refund ? state.refundStatus : 4;
    return { ...body, order_sn: `SQB-${body.check_sn}`, order_type: refund ? 2 : 1, order_status: status, currency: '156',
      tenders: refund ? body.tenders.map((entry, index) => ({ ...entry, tender_sn: `RT-${body.check_sn}-${index}`, pay_status: status === 4 ? 5 : status === 6 ? 6 : status === 5 && index === 0 ? 5 : 4,
        internal_transaction_sn: `RS-${body.check_sn}-${index}`, paid_amount: entry.amount, collected_amount: entry.amount, pay_time: at, sub_tender_type: '302' }))
        : [{ tender_sn: `T-${body.check_sn}`, amount: body.amount, pay_status: 3, internal_transaction_sn: `S-${body.check_sn}`, sub_tender_type: '302', pay_time: at, paid_amount: body.amount, collected_amount: body.amount }] };
  };
  const fetchFn = async (url, options) => {
    const body = JSON.parse(options.body).request.body;
    const endpoint = url.slice(url.lastIndexOf('/') + 1);
    calls.push({ endpoint, body });
    if (state.offline) throw new TypeError('Network disconnected');
    if (endpoint === 'purchase') { remote.set(body.check_sn, body); return response(queryData(body)); }
    if (endpoint === 'refund') {
      const journal = JSON.parse(fs.readFileSync(path.join(directory, 'payments.json'), 'utf8'));
      assert.ok(Object.values(journal).some((record) => record.identity.check_sn === body.check_sn && record.state === 'pending'));
      assert.equal(body.tenders.every((entry) => entry.operation === '9' && entry.pay_status === '0'), true);
      remote.set(body.check_sn, body);
      if (state.lostRefundResponse) throw new TypeError('Response lost after remote acceptance');
      return response({ request_id: body.request_id, brand_code: body.brand_code, store_sn: body.store_sn, workstation_sn: body.workstation_sn, check_sn: body.check_sn, order_sn: `SQB-${body.check_sn}`, order_status: 4 });
    }
    if (endpoint === 'refunds-query') return response({ refund_orders: state.external ? [{ order_sn: 'UNRECORDED', amount: -100 }] : [] });
    if (endpoint === 'query') {
      const data = queryData(remote.get(body.check_sn));
      if (state.rejectSignature) return new Response((await response(data).text()).replace('"amount":"-', '"amount":"-9'));
      return response(data);
    }
    throw new Error(`Unexpected mock endpoint ${endpoint}`);
  };
  const options = { directory, fetchFn, resolveTerminalIp: async () => '8.8.4.4' };
  const service = createService(options);
  await service.dispatch('generate-key');
  await service.dispatch('save-config', config);
  const draft = { id: crypto.randomUUID(), orderNo: `POS${Date.now()}`, createdAt: at, method: '收钱吧', ...priceOrder([item, gift, coupon]) };
  const paid = await service.dispatch('start', { draft, code });
  const ledger = completeSqbOrder({ products: [item, gift, coupon, replacement], orders: [], pendingPayment: { draft } }, paid);
  await service.dispatch('acknowledge', { id: paid.id });
  return { service, options, directory, calls, remote, state, ledger, draft, paid };
}
const requestFor = (order, options = {}) => ({ id: crypto.randomUUID(), type: 'return', returns: remainingLines(order).filter((line) => line.productType !== 'gift').map((line) => ({ lineId: line.lineId, qty: line.qty, restockQty: line.qty })), ...options });
async function start(service, order, request = requestFor(order)) {
  const preview = await service.dispatch('preview-adjustment', { parentId: order.id, request });
  const payload = { parentId: order.id, request, digest: preview.digest, confirm: true, code };
  return { record: await service.dispatch('start-adjustment', payload), payload, preview };
}

test('coupon allocation conserves every cent and cumulative partial returns never exceed original net', () => {
  const order = { id: 'O', items: [{ ...item, price: 0.01, qty: 3, discount: 0 }, { ...replacement, price: 0.02 }, { ...coupon, couponAmount: 0.01 }], afterSales: [] };
  assert.equal(saleLines(order).reduce((sum, line) => sum + line.netCents, 0), 4);
  let total = 0;
  for (let i = 0; i < 3; i++) {
    const plan = adjustmentPlan(order, { id: `R${i}`, type: 'return', returns: [{ lineId: 'O:0', qty: 1, restockQty: 1 }] });
    total += plan.refundCents; order.afterSales.push({ plan });
  }
  assert.equal(total, saleLines(order)[0].netCents);
  assert.throws(() => adjustmentPlan(order, { id: 'R4', type: 'return', returns: [{ lineId: 'O:0', qty: 1, restockQty: 1 }] }), /不存在/);
});

test('refund POST acknowledgement is not success; confirmed query commits exact stock once and leaves gifts out', async (t) => {
  const f = await fixture(t);
  const { record, payload } = await start(f.service, f.ledger.orders[0]);
  assert.equal(record.state, 'pending');
  assert.equal(record.amount, 1600);
  assert.equal(f.calls.find((call) => call.endpoint === 'refund').body.amount, '-1600');
  assert.throws(() => applyAdjustment(f.ledger, record), /尚未确认/);
  await assert.rejects(f.service.dispatch('acknowledge', { id: record.id }), /未确定/);
  const final = await f.service.dispatch('query', { id: record.id });
  assert.equal(final.state, 'refunded');
  const next = applyAdjustment(f.ledger, final);
  assert.equal(next.products.find((p) => p.id === item.id).stock, 10);
  assert.equal(next.products.find((p) => p.id === gift.id).stock, 9);
  assert.equal(next.orders[0].total, 16);
  assert.equal(orderNet(next.orders[0]), 0);
  assert.deepEqual(applyAdjustment(next, final), next);
  assert.equal((await f.service.dispatch('start-adjustment', payload)).state, 'refunded');
  assert.equal(f.calls.filter((call) => call.endpoint === 'refund').length, 1);
  await assert.rejects(f.service.dispatch('start-adjustment', { ...payload, digest: 'altered' }), /已用于/);
});

test('partial refund followed by later gift recovery only restocks the actually returned quantity', async (t) => {
  const f = await fixture(t);
  let order = f.ledger.orders[0];
  const request = requestFor(order, { returns: [{ lineId: `${order.id}:0`, qty: 1, restockQty: 0 }] });
  const { record } = await start(f.service, order, request);
  const final = await f.service.dispatch('query', { id: record.id });
  assert.equal(final.amount, 800);
  let ledger = applyAdjustment(f.ledger, final);
  assert.equal(ledger.products[0].stock, 8);
  await f.service.dispatch('acknowledge', { id: record.id });
  order = ledger.orders[0];
  const giftRequest = requestFor(order, { returns: [{ lineId: `${order.id}:1`, qty: 1, restockQty: 1 }] });
  const zero = await start(f.service, order, giftRequest);
  assert.equal(zero.record.state, 'completed');
  ledger = applyAdjustment(ledger, zero.record);
  assert.equal(ledger.products[1].stock, 10);
  assert.equal(orderNet(ledger.orders[0]), 8);
});

test('higher-price exchange charges only difference, and its later cancellation refunds original plus top-up tenders', async (t) => {
  const f = await fixture(t);
  const order = f.ledger.orders[0];
  const exchange = await start(f.service, order, requestFor(order, { type: 'exchange', newItems: [replacement] }));
  assert.equal(exchange.record.kind, 'exchange-charge');
  assert.equal(exchange.record.amount, 900);
  assert.equal(exchange.record.state, 'paid');
  let ledger = applyAdjustment(f.ledger, exchange.record);
  assert.equal(orderNet(ledger.orders[0]), 25);
  assert.equal(ledger.products.find((p) => p.id === replacement.id).stock, 9);
  await f.service.dispatch('acknowledge', { id: exchange.record.id });
  const returned = await start(f.service, ledger.orders[0]);
  assert.deepEqual(returned.record.allocations.map((p) => p.amount), [1600, 900]);
  const final = await f.service.dispatch('query', { id: returned.record.id });
  assert.equal(final.state, 'refunded');
  ledger = applyAdjustment(ledger, final);
  assert.equal(orderNet(ledger.orders[0]), 0);
  assert.equal(ledger.products.find((p) => p.id === replacement.id).stock, 10);
});

test('equal-price exchange uses no money-moving request and insufficient stock cannot mutate the ledger', async (t) => {
  const f = await fixture(t);
  const value = await start(f.service, f.ledger.orders[0], requestFor(f.ledger.orders[0], { type: 'exchange', newItems: [{ ...replacement, price: 16 }] }));
  assert.equal(value.record.kind, 'exchange-zero');
  assert.equal(f.calls.filter((call) => ['refund', 'purchase'].includes(call.endpoint)).length, 1);
  const original = JSON.stringify(f.ledger);
  assert.throws(() => applyAdjustment({ ...f.ledger, products: f.ledger.products.map((p) => ({ ...p, stock: 0 })) }, value.record), /库存不足/);
  assert.equal(JSON.stringify(f.ledger), original);
});

test('unknown refund survives restart, rejects new charges and backup, and repeated queries never repeat refund', async (t) => {
  const f = await fixture(t);
  const value = await start(f.service, f.ledger.orders[0]);
  f.state.offline = true;
  assert.equal((await f.service.dispatch('query', { id: value.record.id })).state, 'pending');
  await assert.rejects(f.service.dispatch('export-backup', { business: {} }), /完成/);
  const restarted = createService(f.options);
  await assert.rejects(restarted.dispatch('start', { draft: { ...f.draft, id: crypto.randomUUID() }, code }), /未处理/);
  assert.equal((await restarted.dispatch('pending'))[0].id, value.record.id);
  f.state.offline = false;
  assert.equal((await restarted.dispatch('query', { id: value.record.id })).state, 'refunded');
  assert.equal(f.calls.filter((call) => call.endpoint === 'refund').length, 1);
});

test('external refund, merchant mismatch, stale confirmation or no consent never sends a refund', async (t) => {
  const f = await fixture(t);
  const request = requestFor(f.ledger.orders[0]);
  const p = await f.service.dispatch('preview-adjustment', { parentId: f.draft.id, request });
  const payload = { parentId: f.draft.id, request, digest: p.digest, confirm: true };
  await assert.rejects(f.service.dispatch('start-adjustment', { ...payload, confirm: false }), /确认/);
  await assert.rejects(f.service.dispatch('start-adjustment', { ...payload, digest: 'bad' }), /变化/);
  f.state.external = true;
  await assert.rejects(f.service.dispatch('start-adjustment', payload), /未登记/);
  await f.service.dispatch('save-config', { ...config, store_sn: 'another' });
  await assert.rejects(f.service.dispatch('start-adjustment', payload), /不一致/);
  assert.equal(f.calls.filter((call) => call.endpoint === 'refund').length, 0);
});

test('concurrent different adjustments cannot submit two refunds against the same balance', async (t) => {
  const f = await fixture(t);
  const order = f.ledger.orders[0];
  const a = requestFor(order); const b = requestFor(order);
  const pa = await f.service.dispatch('preview-adjustment', { parentId: order.id, request: a });
  const pb = await f.service.dispatch('preview-adjustment', { parentId: order.id, request: b });
  const results = await Promise.allSettled([f.service.dispatch('start-adjustment', { parentId: order.id, request: a, digest: pa.digest, confirm: true }), f.service.dispatch('start-adjustment', { parentId: order.id, request: b, digest: pb.digest, confirm: true })]);
  assert.equal(results.filter((p) => p.status === 'fulfilled').length, 1);
  assert.equal(f.calls.filter((call) => call.endpoint === 'refund').length, 1);
});

test('refund validation rejects changed identity, currency, amounts and duplicated tender allocations', async (t) => {
  const f = await fixture(t);
  const { record } = await start(f.service, f.ledger.orders[0]);
  const tender = { tender_sn: 'R-T', original_tender_sn: record.allocations[0].tenderSn, amount: -1600, pay_status: 5 };
  const data = { ...record.identity, order_sn: record.orderSn, order_type: 2, amount: -1600, currency: '156', order_status: 4, tenders: [tender] };
  assert.equal(refundResultState(data, record), 'refunded');
  for (const change of [{ store_sn: 'other' }, { order_sn: 'other' }, { amount: -1 }, { currency: 'USD' }, { tenders: [tender, tender] }]) assert.throws(() => refundResultState({ ...data, ...change }, record));
  assert.equal(refundResultState({ ...data, order_status: 5 }, record), 'review');
  assert.equal(refundResultState({ ...data, order_status: 6, tenders: [{ ...tender, pay_status: 6 }] }, record), 'failed');
});

test('refund failure does not restore stock and cannot change original payment through legacy editing', async (t) => {
  const f = await fixture(t);
  const { record } = await start(f.service, f.ledger.orders[0]);
  f.state.refundStatus = 6;
  const failed = await f.service.dispatch('query', { id: record.id });
  assert.equal(failed.state, 'failed');
  assert.throws(() => applyAdjustment(f.ledger, failed), /尚未/);
  assert.throws(() => reviseOrder(f.ledger, f.draft.id, [], true), /原路退换货/);
});

test('CSV preserves child sale lines and records later refunds on their actual date, not the sale date', async (t) => {
  const f = await fixture(t);
  const { record } = await start(f.service, f.ledger.orders[0]);
  const final = await f.service.dispatch('query', { id: record.id });
  final.tenders.forEach((tender) => { tender.payTime = '2026-09-18T11:00:00+08:00'; });
  const ledger = applyAdjustment(f.ledger, final);
  assert.deepEqual(financialEvents(ledger.orders[0]).map((event) => event.amount), [16, -16]);
  const all = financialExportRows(ledger.orders);
  assert.equal(all.slice(1).reduce((sum, row) => sum + Math.round(row[15] * 100), 0), 0);
  const nextDay = financialExportRows(ledger.orders, '2026-09-18');
  assert.equal(nextDay.slice(1).reduce((sum, row) => sum + row[15], 0), -16);
  assert.equal(nextDay[1][23], '退回商品');
  assert.equal(nextDay[1][27], 2);
});

test('signed complete backup migrates journal and business data; tampering and rollback are rejected', async (t) => {
  const f = await fixture(t);
  const business = { type: 'stall-cashier-backup', products: f.ledger.products, orders: f.ledger.orders, heldCarts: [], promoRules: [], paymentQr: '' };
  const backup = await f.service.dispatch('export-backup', { business });
  assert.equal(backup.type, 'stall-cashier-signed-backup');
  assert.ok(!JSON.stringify(backup).includes('PRIVATE KEY'));
  assert.ok(!JSON.stringify(backup).includes(code));
  await assert.rejects(f.service.dispatch('prepare-restore', { bundle: { ...backup, content: backup.content.replace('Product', 'Tampered') } }), /签名/);
  const stage = await f.service.dispatch('prepare-restore', { bundle: backup });
  assert.deepEqual(stage.business, JSON.parse(JSON.stringify(business)));
  await assert.rejects(f.service.dispatch('start', { draft: { ...f.draft, id: crypto.randomUUID() }, code }), /未处理/);
  const restarted = createService(f.options);
  assert.equal((await restarted.dispatch('restore-status')).token, stage.token);
  await restarted.dispatch('commit-restore', { token: stage.token });
  assert.equal(await restarted.dispatch('restore-status'), null);
  const value = await start(restarted, f.ledger.orders[0]);
  await restarted.dispatch('query', { id: value.record.id });
  await restarted.dispatch('acknowledge', { id: value.record.id });
  await assert.rejects(restarted.dispatch('prepare-restore', { bundle: backup }), /早于/);
  await assert.rejects(restarted.dispatch('prepare-restore', { bundle: business }), /新版完整/);
});

test('diagnostics omit payment codes, private keys and customer identifiers', async (t) => {
  const f = await fixture(t);
  await start(f.service, f.ledger.orders[0]);
  const diagnostic = JSON.stringify(await f.service.dispatch('diagnostics'));
  assert.ok(!diagnostic.includes(code));
  assert.ok(!diagnostic.includes('dynamic_id'));
  assert.ok(!diagnostic.includes('PRIVATE KEY'));
  assert.equal(safeMessage('code 130000000000000000'), 'code [号码已隐藏]');
});

test('lost refund POST response recovers by querying its persisted check number after restart', async (t) => {
  const f = await fixture(t);
  f.state.lostRefundResponse = true;
  const value = await start(f.service, f.ledger.orders[0]);
  assert.equal(value.record.state, 'pending');
  assert.equal(value.record.notSubmitted, undefined);
  const restarted = createService(f.options);
  const result = await restarted.dispatch('query', { id: value.record.id });
  assert.equal(result.state, 'refunded');
  assert.equal(f.calls.filter((call) => call.endpoint === 'refund').length, 1);
});

test('multi-tender partial refund remains unresolved and does not restock any items', async (t) => {
  const f = await fixture(t);
  const ex = await start(f.service, f.ledger.orders[0], requestFor(f.ledger.orders[0], { type: 'exchange', newItems: [replacement] }));
  const ledger = applyAdjustment(f.ledger, ex.record);
  await f.service.dispatch('acknowledge', { id: ex.record.id });
  const refund = await start(f.service, ledger.orders[0]);
  f.state.refundStatus = 5;
  const result = await f.service.dispatch('query', { id: refund.record.id });
  assert.equal(result.state, 'review');
  assert.throws(() => applyAdjustment(ledger, result), /尚未确认/);
  await assert.rejects(f.service.dispatch('acknowledge', { id: result.id }), /未确定/);
});

test('new-machine restore requires matching encrypted credentials and retains refundable journal', async (t) => {
  const f = await fixture(t);
  const business = { type: 'stall-cashier-backup', products: f.ledger.products, orders: f.ledger.orders, heldCarts: [] };
  const archive = await f.service.dispatch('export-backup', { business });
  const password = 'synthetic-test-password';
  const credentials = await f.service.dispatch('export-credentials', { password });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqb-new-machine-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = createService({ ...f.options, directory });
  await assert.rejects(target.dispatch('prepare-restore', { bundle: archive }), /原电脑/);
  await target.dispatch('import-credentials', { bundle: credentials, password });
  const stage = await target.dispatch('prepare-restore', { bundle: archive });
  await target.dispatch('commit-restore', { token: stage.token });
  const preview = await target.dispatch('preview-adjustment', { parentId: f.draft.id, request: requestFor(stage.business.orders[0]) });
  assert.equal(preview.plan.refundCents, 1600);
  assert.equal((await target.dispatch('pending')).length, 0);
});
