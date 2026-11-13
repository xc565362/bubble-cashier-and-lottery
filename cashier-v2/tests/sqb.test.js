import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { completeSqbOrder, priceOrder, orderSerial } from '../src/orderLogic.js';
const require = createRequire(import.meta.url);
const { createService } = require('../payments/service.cjs');
const { signedEnvelope, verifyEnvelope, resultState, purchaseBody, validateConfig } = require('../payments/litepos.cjs');
const { paymentMiddleware } = require('../payments/http.cjs');
const pair = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const platform = pair();
const config = { mode: 'production', appid: 'testapp', brand_code: '123', store_sn: 'STORE', workstation_sn: '0', operator: 'Test', gateway: 'https://test.shouqianba.com', platformPublicKey: platform.publicKey };
const item = { id: 'p1', barcode: '6900000000001', name: 'Test product', price: 9.9, qty: 2, discount: 0.1, productType: 'sale', stock: 8 };
const draft = () => ({ id: crypto.randomUUID(), orderNo: `POS${Date.now()}`, total: 19.7, items: [item], createdAt: new Date().toISOString(), method: '收钱吧' });
const code = '130000000000000000'; // Synthetic data; never sent to a real payment endpoint.
const responseData = (body, state = 4) => ({ brand_code: body.brand_code, store_sn: body.store_sn, workstation_sn: body.workstation_sn, check_sn: body.check_sn, order_sn: 'SQB_TEST_ORDER', order_type: 1, order_status: state, amount: 1970, currency: '156', tenders: [{ tender_sn: 'T_TEST', amount: 1970, pay_status: state === 4 ? 3 : state === 6 ? 7 : 2 }] });
const signResponse = (data) => signedEnvelope('response', { head: { appid: config.appid, sign_type: 'SHA256' }, body: { result_code: '200', biz_response: { result_code: '200', data } } }, platform.privateKey);
const missingResponse = () => signedEnvelope('response', { head: { appid: config.appid, sign_type: 'SHA256' }, body: { result_code: '200', biz_response: { result_code: '32005', error_code: 'ACQ.ORDER_NOT_FOUND' } } }, platform.privateKey);
async function fixture(t, fetchFn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqb-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const service = createService({ directory, fetchFn, resolveTerminalIp: async () => '8.8.4.4' });
  await service.dispatch('generate-key');
  await service.dispatch('save-config', config);
  return { service, directory };
}

test('RSA verifies exact formatted bytes and rejects tampering and wrong app', () => {
  const payload = '{ "head": {"appid":"testapp","sign_type":"SHA256"}, "body": {"text":"中文\\u4e2d"} }';
  const signature = crypto.sign('RSA-SHA256', Buffer.from(payload), platform.privateKey).toString('base64');
  const raw = `{"response":${payload},"signature":"${signature}"}`;
  assert.equal(verifyEnvelope(raw, 'response', platform.publicKey, config.appid).text, '中文中');
  assert.throws(() => verifyEnvelope(raw.replace('中文', '修改'), 'response', platform.publicKey, config.appid), /签名/);
  assert.throws(() => verifyEnvelope(raw, 'response', platform.publicKey, 'other'), /身份/);
});

test('configuration requires official HTTPS gateway and never treats a barcode or zero amount as payment', () => {
  for (const gateway of ['http://test.shouqianba.com', 'https://shouqianba.com.attacker.invalid', 'https://localhost', 'https://test.shouqianba.com/x']) assert.throws(() => validateConfig({ ...config, gateway }));
  assert.throws(() => purchaseBody(config, draft(), item.barcode), /商品条码/);
  assert.throws(() => purchaseBody(config, { ...draft(), total: 0 }, code), /大于 0/);
  const body = purchaseBody(config, draft(), code);
  assert.equal(body.scene, '12'); assert.equal(body.amount, '1970'); assert.equal(body.currency, '156');
});

test('result requires matching identity, amount, currency and successful tenders', () => {
  const body = purchaseBody(config, draft(), code);
  const record = { identity: { ...config, check_sn: body.check_sn }, amount: 1970 };
  const data = responseData(body);
  assert.equal(resultState(data, record), 'paid');
  assert.equal(resultState({ ...data, tenders: [] }, record), 'review');
  assert.equal(resultState(responseData(body, 2), record), 'pending');
  assert.equal(resultState(responseData(body, 6), record), 'failed');
  for (const change of [{ check_sn: 'wrong' }, { store_sn: 'wrong' }, { amount: 1 }, { currency: 'USD' }, { order_type: 2 }]) assert.throws(() => resultState({ ...data, ...change }, record));
});

test('double scan sends one purchase, persists before network, and stores no payment code', async (t) => {
  let calls = 0;
  let directory;
  const fixtureValue = await fixture(t, async (url, options) => {
    calls++;
    const request = JSON.parse(options.body).request;
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'payments.json'), 'utf8'));
    assert.equal(Object.values(saved)[0].state, 'pending');
    assert.ok(!JSON.stringify(saved).includes(code));
    assert.equal(request.body.dynamic_id, code);
    assert.equal(request.body.amount, '1970');
    return new Response(signResponse(responseData(request.body)));
  });
  directory = fixtureValue.directory;
  const d = draft();
  const [a, b] = await Promise.all([fixtureValue.service.dispatch('start', { draft: d, code }), fixtureValue.service.dispatch('start', { draft: d, code })]);
  assert.equal(calls, 1);
  const paid = await fixtureValue.service.dispatch('query', { id: d.id });
  assert.equal(paid.state, 'paid'); assert.equal(calls, 1);
  assert.equal((await fixtureValue.service.dispatch('start', { draft: d, code })).state, 'paid');
  assert.ok([a.state, b.state].includes('paid'));
  assert.ok(!fs.readFileSync(path.join(directory, 'payments.json'), 'utf8').includes(code));
});

test('timeout remains unresolved across restart; querying cannot initiate another charge', async (t) => {
  const { service, directory } = await fixture(t, async () => { throw new TypeError('network failed'); });
  const d = draft();
  const pending = await service.dispatch('start', { draft: d, code });
  assert.equal(pending.state, 'pending');
  await assert.rejects(service.dispatch('acknowledge', { id: d.id }), /未确定/);
  await assert.rejects(service.dispatch('start', { draft: draft(), code }), /未处理/);
  await assert.rejects(service.dispatch('save-config', config), /对账/);
  let queried = 0;
  const restarted = createService({ directory, resolveTerminalIp: async () => '8.8.4.4', fetchFn: async (url, options) => {
    assert.ok(url.endsWith('/sales/query')); queried++;
    const body = JSON.parse(options.body).request.body;
    assert.equal(body.dynamic_id, undefined);
    return new Response(signResponse(responseData(body)));
  } });
  assert.equal((await restarted.dispatch('pending')).length, 1);
  assert.equal((await restarted.dispatch('query', { id: d.id })).state, 'paid');
  assert.equal(queried, 1);
});

test('missing order needs verified observations, explicit confirmation and a fresh query; journal survives restart', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let purchases = 0;
  let queries = 0;
  const fetchFn = async (url) => {
    if (url.endsWith('/purchase')) { purchases++; throw new TypeError('offline'); }
    assert.ok(url.endsWith('/query')); queries++;
    return new Response(missingResponse());
  };
  const { service, directory } = await fixture(t, fetchFn);
  const d = draft();
  await service.dispatch('start', { draft: d, code });
  const first = await service.dispatch('query', { id: d.id });
  assert.equal(first.state, 'pending'); assert.equal(first.missingOrder.count, 1);
  await assert.rejects(service.dispatch('resolve-missing-payment', { id: d.id, confirmNotCharged: true }), /暂不能结束/);
  t.mock.timers.tick(121000);
  const restarted = createService({ directory, resolveTerminalIp: async () => '8.8.4.4', fetchFn });
  assert.equal((await restarted.dispatch('query', { id: d.id })).state, 'pending');
  await assert.rejects(restarted.dispatch('acknowledge', { id: d.id }), /未确定/);
  await assert.rejects(restarted.dispatch('resolve-missing-payment', { id: d.id }), /确认本笔未扣款/);
  const results = await Promise.all([1, 2].map(() => restarted.dispatch('resolve-missing-payment', { id: d.id, confirmNotCharged: true })));
  assert.equal(queries, 3); assert.equal(purchases, 1);
  for (const result of results) {
    assert.equal(result.state, 'failed'); assert.equal(result.acknowledged, false);
    assert.equal(result.resolution.type, 'confirmed-unpaid-order-not-found');
    assert.equal(result.resolution.queryCount, 3);
    assert.equal(result.notSubmitted, undefined);
  }
  await restarted.dispatch('acknowledge', { id: d.id });
  assert.equal((await restarted.dispatch('pending')).length, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'payments.json')))[d.id];
  assert.equal(saved.draft.items[0].stock, item.stock);
  assert.ok(saved.resolution); assert.ok(!JSON.stringify(saved).includes(code));
  assert.equal((await restarted.dispatch('start', { draft: d, code })).state, 'failed');
  assert.equal(purchases, 1);
});

test('unverified errors, other errors and network loss cannot unlock a missing order', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  for (const outcome of ['network', 'forged', 'wrong-app', 'other-error', 'http-error']) {
    let finalQuery = false;
    const { service } = await fixture(t, async (url) => {
      if (url.endsWith('/purchase')) throw new TypeError('offline');
      if (!finalQuery) return new Response(missingResponse());
      if (outcome === 'network') throw new TypeError('offline');
      if (outcome === 'http-error') return new Response('offline', { status: 503 });
      if (outcome === 'forged') return new Response(missingResponse().replace('32005', '32006'));
      return new Response(signedEnvelope('response', { head: { appid: outcome === 'wrong-app' ? 'other' : config.appid, sign_type: 'SHA256' },
        body: { result_code: '200', biz_response: { result_code: '400', error_code: outcome === 'other-error' ? 'ILLEGAL_SIGN' : 'ACQ.ORDER_NOT_FOUND' } } }, platform.privateKey));
    });
    const d = draft();
    await service.dispatch('start', { draft: d, code });
    await service.dispatch('query', { id: d.id });
    t.mock.timers.tick(121000);
    await service.dispatch('query', { id: d.id });
    finalQuery = true;
    await assert.rejects(service.dispatch('resolve-missing-payment', { id: d.id, confirmNotCharged: true }), /不能结束收款/);
    const [record] = await service.dispatch('pending');
    assert.equal(record.state, 'pending'); assert.equal(record.missingOrder, null); assert.equal(record.resolution, undefined);
  }
});

test('fresh-query payment success wins over manual non-payment confirmation', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let paid = false;
  const { service } = await fixture(t, async (url, options) => {
    if (url.endsWith('/purchase')) throw new TypeError('offline');
    return new Response(paid ? signResponse(responseData(JSON.parse(options.body).request.body)) : missingResponse());
  });
  const d = draft();
  await service.dispatch('start', { draft: d, code });
  await service.dispatch('query', { id: d.id });
  t.mock.timers.tick(121000);
  await service.dispatch('query', { id: d.id });
  paid = true;
  const record = await service.dispatch('resolve-missing-payment', { id: d.id, confirmNotCharged: true });
  assert.equal(record.state, 'paid'); assert.equal(record.resolution, undefined);
});

test('known remote orders, refunds and stale or short observations cannot use missing-order recovery', async (t) => {
  const { canResolveMissingPayment } = require('../payments/recovery.cjs');
  const now = Date.now();
  const record = { state: 'pending', createdAt: new Date(now - 180000).toISOString(),
    missingOrder: { credentialId: 'c', count: 4, firstCheckedAt: new Date(now - 120000).toISOString(), lastCheckedAt: new Date(now).toISOString() } };
  assert.equal(canResolveMissingPayment(record, 'c', now), true);
  for (const change of [{ orderSn: 'known' }, { remoteOrderSeenAt: record.createdAt }, { parentId: 'parent' }, { kind: 'refund' },
    { tenders: [{}] }, { state: 'review' }, { state: 'paid' }, { acknowledged: true }, { createdAt: 'invalid' }, { createdAt: new Date(now).toISOString() },
    { missingOrder: { ...record.missingOrder, count: 1 } }, { missingOrder: { ...record.missingOrder, credentialId: 'other' } },
    { missingOrder: { ...record.missingOrder, firstCheckedAt: new Date(now - 1000).toISOString() } }]) {
    assert.equal(canResolveMissingPayment({ ...record, ...change }, 'c', now), false);
  }
  assert.equal(canResolveMissingPayment(record, 'c', now + 61000), false);
});

test('a late verified success after manual resolution reopens reconciliation instead of hiding behind acknowledgement', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { service } = await fixture(t, async (url) => {
    if (url.endsWith('/purchase')) throw new TypeError('offline');
    return new Response(missingResponse());
  });
  const d = draft();
  await service.dispatch('start', { draft: d, code });
  await service.dispatch('query', { id: d.id });
  t.mock.timers.tick(121000);
  await service.dispatch('query', { id: d.id });
  await service.dispatch('resolve-missing-payment', { id: d.id, confirmNotCharged: true });
  await service.dispatch('acknowledge', { id: d.id });
  const notification = signedEnvelope('request', { head: { appid: config.appid, sign_type: 'SHA256' }, body: responseData(purchaseBody(config, d, code)) }, platform.privateKey);
  await service.notification(notification);
  const [record] = await service.dispatch('pending');
  assert.equal(record.state, 'paid'); assert.equal(record.acknowledged, false);
  assert.equal(record.missingOrder, null); assert.ok(record.resolution);
});

test('acknowledgement cannot overwrite a concurrent verified success', async (t) => {
  const { service } = await fixture(t, async (_, options) => new Response(signResponse(responseData(JSON.parse(options.body).request.body, 6))));
  const d = draft();
  assert.equal((await service.dispatch('start', { draft: d, code })).state, 'failed');
  const acknowledging = service.dispatch('acknowledge', { id: d.id });
  const notification = signedEnvelope('request', { head: { appid: config.appid, sign_type: 'SHA256' }, body: responseData(purchaseBody(config, d, code)) }, platform.privateKey);
  const notifying = service.notification(notification);
  await assert.rejects(acknowledging, /资金状态已更新/);
  await notifying;
  const [record] = await service.dispatch('pending');
  assert.equal(record.state, 'paid'); assert.equal(record.acknowledged, false);
});

test('forged, rejected, mismatched or partial responses never become paid', async (t) => {
  for (const kind of ['forged', 'amount', 'partial', 'rejected']) {
    const { service } = await fixture(t, async (_, options) => {
      const data = responseData(JSON.parse(options.body).request.body);
      let raw;
      if (kind === 'amount') data.amount = 1;
      if (kind === 'partial') data.order_status = 5;
      if (kind === 'rejected') raw = signedEnvelope('response', { head: { appid: config.appid, sign_type: 'SHA256' }, body: { result_code: '400', error_code: 'ILLEGAL_SIGN' } }, platform.privateKey);
      else raw = signResponse(data);
      if (kind === 'forged') raw = raw.replace('1970', '1971');
      return new Response(raw);
    });
    assert.notEqual((await service.dispatch('start', { draft: draft(), code })).state, 'paid');
  }
});

test('signed callbacks are durable, idempotent, acknowledged by signature and cannot downgrade paid', async (t) => {
  const { service } = await fixture(t, async () => { throw new TypeError('offline'); });
  const d = draft();
  await service.dispatch('start', { draft: d, code });
  const body = responseData(purchaseBody(config, d, code));
  const notify = (data) => signedEnvelope('request', { head: { appid: config.appid, sign_type: 'SHA256' }, body: data }, platform.privateKey);
  const ack = await service.notification(notify(body));
  const publicKey = (await service.dispatch('config')).merchantPublicKey;
  assert.equal(verifyEnvelope(ack, 'response', publicKey, config.appid).result_code, '200');
  await service.notification(notify(body));
  await service.notification(notify({ ...body, order_status: 2 }));
  assert.equal((await service.dispatch('query', { id: d.id })).state, 'paid');
  await assert.rejects(service.notification(notify({ ...body, amount: 1 })), /金额/);
  assert.equal((await service.dispatch('pending')).length, 1);
});

test('verified payment commits inventory once; pending and different receipts cannot', () => {
  const d = draft();
  const record = { id: d.id, identity: { check_sn: d.orderNo }, state: 'paid', orderSn: 'SQB1', amount: 1970, tenders: [] };
  const ledger = { products: [item], orders: [], pendingPayment: { draft: d } };
  assert.throws(() => completeSqbOrder(ledger, { ...record, state: 'pending' }), /尚未/);
  assert.throws(() => completeSqbOrder(ledger, { ...record, amount: 1 }), /匹配/);
  const paid = completeSqbOrder(ledger, record);
  assert.equal(paid.products[0].stock, 6); assert.equal(paid.orders[0].payment.orderSn, 'SQB1');
  assert.equal(paid.pendingPayment, null);
  assert.deepEqual(completeSqbOrder(paid, record), paid);
  assert.throws(() => completeSqbOrder(paid, { ...record, orderSn: 'other' }), /不一致/);
});

test('HTTP management rejects cross-origin calls and non-JSON forms', async (t) => {
  let calls = 0;
  const middleware = paymentMiddleware({ dispatch: async () => { calls++; return {}; } });
  const server = http.createServer((req, res) => middleware(req, res, () => res.end('ok')));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  for (const origin of ['https://evil.example', 'null', '']) {
    const response = await fetch(`${url}/api/sqb/config`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' });
    assert.equal(response.status, 400);
  }
  const good = await fetch(`${url}/api/sqb/config`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: '{}' });
  assert.equal(good.status, 200); assert.equal(calls, 1);
});

test('notification claims use verified amount and survive repeats, callbacks and restart', async (t) => {
  const { service, directory } = await fixture(t, async (_, options) => {
    const data = responseData(JSON.parse(options.body).request.body);
    data.tenders[0].internal_transaction_sn = '00000012345678901234567890';
    return new Response(signResponse(data));
  });
  await assert.rejects(service.dispatch('claim-payment-notification', { id: 'unknown', amount: 100 }), /未确认/);
  const d = draft();
  const paid = await service.dispatch('start', { draft: d, code });
  const notice = await service.dispatch('claim-payment-notification', { id: d.id, amount: 1 });
  assert.equal(notice.title, '收款成功');
  assert.match(notice.body, /19\.70 元/);
  assert.match(notice.body, /00000012345678901234567890/);
  assert.equal(await service.dispatch('claim-payment-notification', { id: d.id }), null);
  const restarted = createService({ directory, fetchFn: async () => { throw new Error('No network needed'); } });
  assert.equal(await restarted.dispatch('claim-payment-notification', { id: d.id }), null);
  const ledger = completeSqbOrder({ products: [item], orders: [], pendingPayment: { draft: d } }, paid);
  assert.equal(orderSerial(ledger.orders[0]), '00000012345678901234567890');
  assert.equal(ledger.orders[0].orderNo, d.orderNo);
});

test('pending and failed payments never claim success notifications', async (t) => {
  for (const state of [2, 6]) {
    const { service } = await fixture(t, async (_, options) => new Response(signResponse(responseData(JSON.parse(options.body).request.body, state))));
    const d = draft();
    await service.dispatch('start', { draft: d, code });
    await assert.rejects(service.dispatch('claim-payment-notification', { id: d.id }), /未确认/);
  }
});

test('coupon discount is charged and committed exactly once without coupon stock changes', async (t) => {
  const coupon = { id: 'coupon', name: 'Five off', barcode: '69-COUPON', productType: 'coupon', price: 0, qty: 1, couponAmount: 5, stock: 0 };
  let calls = 0;
  const { service } = await fixture(t, async (_, options) => {
    calls++;
    const body = JSON.parse(options.body).request.body;
    assert.equal(body.amount, '1470');
    const data = responseData(body);
    data.amount = 1470; data.tenders[0].amount = 1470;
    data.tenders[0].internal_transaction_sn = 'SQB_COUPON_RECEIPT';
    return new Response(signResponse(data));
  });
  const d = { ...draft(), ...priceOrder([item, coupon]) };
  const paid = await service.dispatch('start', { draft: d, code });
  const ledger = completeSqbOrder({ products: [item, coupon], orders: [], pendingPayment: { draft: d } }, paid);
  assert.equal(ledger.orders[0].total, 14.7);
  assert.equal(ledger.products[0].stock, 6);
  assert.equal(ledger.products[1].stock, 0);
  assert.equal(await service.dispatch('start', { draft: d, code }), paid);
  assert.equal(calls, 1);
  const changed = { ...d, ...priceOrder([item, { ...coupon, couponAmount: 6 }]) };
  await assert.rejects(service.dispatch('start', { draft: changed, code }), /不能修改/);
});
