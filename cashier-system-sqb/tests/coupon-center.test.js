import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { priceOrder, reconcileStock, suspendBasket } from '../src/orderLogic.js';
const require = createRequire(import.meta.url);
const { createCouponStore } = require('../coupons/store.cjs');
const { createCouponBridge } = require('../coupons/bridge.cjs');
const { couponHttp } = require('../coupons/http.cjs');
const { createLotteryClient } = require('../coupons/lottery-client.cjs');
const { createService } = require('../payments/service.cjs');
const { signedEnvelope } = require('../payments/litepos.cjs');
const { createPosFixture } = require('./helpers/posfixture.cjs');
const admin = { id: 'admin', role: 'admin' };
const cashier = { id: 'terminal1', role: 'cashier' };
const uid = () => crypto.randomUUID();
async function fixture(t, options = {}) {
  const pos = await createPosFixture(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coupon-center-'));
  let time = Date.now();
  const store = await createCouponStore({ pool: pos.pool, ns: pos.ns, now: () => time, ...options });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const call = (action, input = {}, actor = admin) => store.dispatch(actor, action, { requestId: uid(), ...input });
  const campaign = await call('create-campaign', { name: 'Lottery discount', amountCents: 500, minimumCents: 0, quota: 2, startsAt: new Date(time - 1000).toISOString(), expiresAt: new Date(time + 86400000).toISOString() });
  const issue = (extra = {}, actor = admin) => call('issue', { campaignId: campaign.id, owner: 'customer-a', awardId: uid(), ...extra }, actor);
  const reserve = (coupon, extra = {}, actor = cashier) => call('reserve', { code: coupon.code, eligibleCents: 1000, checkoutId: uid(), ...extra }, actor);
  return { ...pos, directory, store, call, campaign, issue, reserve, advance: ms => { time += ms; } };
}

test('coupon issuance is idempotent by request and award; amounts, owner, quota and scope are immutable', async t => {
  const f = await fixture(t);
  const token = await f.call('create-key', { name: 'Lottery', role: 'lottery', campaignId: f.campaign.id });
  const lottery = await f.store.authenticate(token.token);
  const input = { requestId: 'req1', awardId: 'award1' };
  const a = await f.issue(input, lottery);
  assert.equal((await f.issue(input, lottery)).id, a.id);
  assert.equal((await f.issue({ awardId: 'award1' }, lottery)).id, a.id);
  await assert.rejects(f.issue({ ...input, owner: 'other' }, lottery), /不同内容/);
  await assert.rejects(f.issue({ awardId: 'award1', owner: 'other' }, lottery), /其他领取人/);
  await assert.rejects(f.call('coupon', { id: a.id, owner: 'other' }, lottery), /无权/);
  await assert.rejects(f.call('create-campaign', {}, lottery), /权限/);
  await assert.rejects(f.call('reserve', { code: a.code }, lottery), /权限/);
  assert.equal((await f.call('coupons', { owner: 'other' }, lottery)).total, 0);
  await f.issue({}, lottery);
  await assert.rejects(f.issue({}, lottery), /上限/);
  assert.equal((await f.call('campaigns'))[0].issued, 2);
  await assert.rejects(f.call('create-campaign', { startsAt: 'invalid', expiresAt: 'invalid' }), /时间/);
});

test('rotating scoped lottery credentials preserves award identity and customer access', async t => {
  const f = await fixture(t);
  const a = await f.call('create-key', { name: 'Old', role: 'lottery', campaignId: f.campaign.id });
  const coupon = await f.issue({ awardId: 'stable-award' }, await f.store.authenticate(a.token));
  await f.call('revoke-key', { id: a.id });
  await assert.rejects(f.store.authenticate(a.token), /停用/);
  const b = await f.call('create-key', { name: 'New', role: 'lottery', campaignId: f.campaign.id });
  const actor = await f.store.authenticate(b.token);
  assert.equal((await f.issue({ awardId: 'stable-award' }, actor)).id, coupon.id);
  assert.equal((await f.call('coupons', { owner: 'customer-a' }, actor)).total, 1);
  assert.ok(!JSON.stringify(await f.call('keys')).includes(b.token));
});

test('secret codes reject forgery; two database connections cannot reserve the same coupon', async t => {
  const f = await fixture(t);
  const coupon = await f.issue();
  await assert.rejects(f.reserve({ code: coupon.code.slice(0, -1) + (coupon.code.endsWith('A') ? 'B' : 'A') }), { code: 'INVALID_CODE' });
  const second = await createCouponStore({ pool: f.pool, ns: f.ns });
  await f.reserve(coupon);
  await assert.rejects(second.dispatch({ ...cashier, id: 'terminal2' }, 'reserve', { code: coupon.code, checkoutId: uid(), eligibleCents: 1000, requestId: uid() }), /占用/);
});

test('reserved coupons expire but payment-pending coupons never auto-release even beyond validity', async t => {
  const f = await fixture(t); const coupon = await f.issue();
  await f.reserve(coupon); f.advance(16 * 60000);
  const r = (await f.reserve(coupon)).reservation;
  await f.call('prepare', { id: r.id, orderId: 'order1', orderNo: 'POS1', eligibleCents: 1000, paidCents: 500 }, cashier);
  f.advance(2 * 86400000);
  assert.equal((await f.call('coupon', { id: coupon.id })).state, 'PAYMENT_PENDING');
  await assert.rejects(f.call('release', { id: r.id }, cashier), /支付结果未知/);
  await assert.rejects(f.call('commit', { id: r.id, orderId: 'wrong', paidCents: 500, paymentReference: 'SQB1' }, cashier), /不一致/);
  await f.call('commit', { id: r.id, orderId: 'order1', paidCents: 500, paymentReference: 'SQB1' }, cashier);
  assert.equal((await f.call('coupon', { id: coupon.id })).state, 'REDEEMED');
  await assert.rejects(f.call('release', { id: r.id, orderId: 'order1', outcome: 'failed' }, cashier), /已核销/);
});

test('discount cap, minimum spend and terminal binding are checked at prepare; only confirmed failure releases', async t => {
  const f = await fixture(t); const coupon = await f.issue();
  const r = (await f.reserve(coupon, { eligibleCents: 200 })).reservation;
  assert.equal(r.discountCents, 200);
  await assert.rejects(f.call('prepare', { id: r.id, orderId: 'o1', orderNo: 'p1', eligibleCents: 200, paidCents: 1 }, cashier), /不一致/);
  await assert.rejects(f.call('reservation', { id: r.id }, { ...cashier, id: 'terminal2' }), /其他收银终端/);
  await f.call('prepare', { id: r.id, orderId: 'o1', orderNo: 'p1', eligibleCents: 200, paidCents: 0 }, cashier);
  await f.call('release', { id: r.id, orderId: 'o1', outcome: 'failed' }, cashier);
  assert.equal((await f.call('coupon', { id: coupon.id })).state, 'AVAILABLE');
  const c = await f.call('create-campaign', { ...f.campaign, name: 'Min', minimumCents: 2000, quota: 1 });
  const minimum = await f.issue({ campaignId: c.id });
  await assert.rejects(f.reserve(minimum), /门槛/);
});

test('issuance retries show the latest state and no usable code after redemption; paused campaigns stop issuing only', async t => {
  const f = await fixture(t); const input = { requestId: 'issue1', awardId: 'award1' }; const coupon = await f.issue(input);
  await f.call('set-campaign', { id: f.campaign.id, enabled: false });
  await assert.rejects(f.issue(), /暂停/);
  const r = (await f.reserve(coupon)).reservation;
  await f.call('prepare', { id: r.id, orderId: 'o1', orderNo: 'p1', eligibleCents: 1000, paidCents: 500 }, cashier);
  await f.call('commit', { id: r.id, orderId: 'o1', paidCents: 500, paymentReference: 'sqb1' }, cashier);
  const retried = await f.issue(input);
  assert.equal(retried.state, 'REDEEMED'); assert.equal(retried.code, undefined);
});

test('lottery SDK retrieves only server-selected user coupons through authenticated HTTP; no browser or admin access', async t => {
  const f = await fixture(t); const adminToken = 'a'.repeat(64);
  const key = await f.call('create-key', { name: 'Backend', role: 'lottery', campaignId: f.campaign.id });
  const server = http.createServer(couponHttp(f.store, { adminToken }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = createLotteryClient({ baseUrl: 'https://coupons.example.com', campaignId: f.campaign.id, token: key.token,
    fetchFn: (url, opts) => fetch(`${base}${url.pathname}${url.search}`, opts) });
  const a = await client.issueForVerifiedAward({ owner: 'trusted-openid', awardId: 'verified-award' });
  assert.equal((await client.issueForVerifiedAward({ owner: 'trusted-openid', awardId: 'verified-award' })).id, a.id);
  assert.equal((await client.listForAuthenticatedOwner('trusted-openid')).total, 1);
  assert.equal((await client.listForAuthenticatedOwner('someone-else')).total, 0);
  assert.equal((await client.detailForAuthenticatedOwner('trusted-openid', a.id)).code, a.code);
  await assert.rejects(client.detailForAuthenticatedOwner('someone-else', a.id), /无权/);
  assert.equal((await fetch(`${base}/v1/campaigns`)).status, 401);
  assert.equal((await fetch(`${base}/v1/keys`, { headers: { Authorization: `Bearer ${key.token}` } })).status, 403);
  assert.equal((await fetch(`${base}/v1/campaigns`, { headers: { Authorization: `Bearer ${adminToken}`, Origin: 'https://evil.invalid' } })).status, 403);
  assert.ok(!JSON.stringify(await client.listForAuthenticatedOwner('trusted-openid')).includes(a.code));
});

async function bridgeFixture(t, amountCents = 500) {
  const pos = await createPosFixture(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coupon-bridge-'));
  const bridge = createCouponBridge({ directory, storeNs: pos.ns });
  t.after(async () => { await bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const c = await bridge.dispatch('create-campaign', { name: 'Discount', amountCents, minimumCents: 0, quota: 10, startsAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), requestId: uid() });
  const coupon = await bridge.dispatch('issue', { campaignId: c.id, owner: 'customer', awardId: uid(), requestId: uid() });
  const line = await bridge.dispatch('reserve', { code: coupon.code, checkoutId: uid(), eligibleCents: 1000, requestId: uid() });
  const product = { id: 'p1', name: 'Product', price: 10, qty: 1, stock: 3, productType: 'sale' };
  const draft = { id: uid(), orderNo: `POS${Date.now()}`, ...priceOrder([product, line]), method: '收钱吧' };
  return { bridge, line, draft, product, directory, coupon };
}

test('cashier bridge checks coupon integrity and environment; offline cleanup never needs product master entries', async t => {
  const f = await bridgeFixture(t);
  assert.equal(reconcileStock([f.product], [], f.draft.items)[0].stock, 2);
  assert.throws(() => suspendBasket({}, { items: f.draft.items }), /移除中奖券/);
  await assert.rejects(f.bridge.prepareDraft(f.draft, 'production'), /联调券/);
  await assert.rejects(f.bridge.prepareDraft({ ...f.draft, items: [f.product, { ...f.line, couponAmount: 99 }] }, 'test'), /修改/);
  await f.bridge.prepareDraft(f.draft, 'test');
  assert.equal((await f.bridge.dispatch('sync'))[0].coupon.state, 'PAYMENT_PENDING');
  await f.bridge.settle({ id: f.draft.id, draft: f.draft, state: 'paid', amount: 500, orderSn: 'MOCK-SQB' });
  assert.equal((await f.bridge.dispatch('coupon', { id: f.coupon.id })).state, 'REDEEMED');
  assert.equal(f.bridge.hasPending(), false);
});

test('zero settlement uses no payment gateway, stays recoverable until local order acknowledgement and rejects changed retries', async t => {
  const f = await bridgeFixture(t, 1000);
  const draft = { ...f.draft, method: '零元结算' };
  const result = await f.bridge.dispatch('zero', { draft });
  assert.equal(result.coupon.state, 'REDEEMED'); assert.equal(result.coupon.paymentReference, `ZERO:${draft.id}`);
  assert.equal(f.bridge.hasPending(), true);
  assert.equal((await f.bridge.dispatch('zero', { draft })).coupon.state, 'REDEEMED');
  await assert.rejects(f.bridge.dispatch('zero', { draft: { ...draft, orderNo: 'CHANGED' } }), /不一致/);
  await assert.rejects(f.bridge.dispatch('release', { id: f.line.externalCoupon.reservationId }), /零元结算/);
  assert.equal((await f.bridge.dispatch('sync'))[0].zeroDraft.id, draft.id);
  await f.bridge.dispatch('zero-ack', { id: draft.id });
  assert.equal(f.bridge.hasPending(), false);
});

test('production coupons reject test payment before locking an order and remain usable with production payment', async t => {
  const f = await fixture(t, { environment: 'production' });
  const adminToken = 'a'.repeat(64);
  const server = http.createServer(couponHttp(f.store, { adminToken }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const bridge = createCouponBridge({ directory: path.join(f.directory, 'pos'),
    fetchFn: (url, options) => fetch(`${base}${url.pathname}${url.search}`, options) });
  t.after(() => bridge.close());
  await bridge.dispatch('connect', { baseUrl: 'https://coupons.example.com', adminToken });
  const coupon = await f.issue();
  const line = await bridge.dispatch('reserve', { code: coupon.code, checkoutId: uid(), eligibleCents: 1000, requestId: uid() });
  const draft = { id: uid(), orderNo: 'PROD-TEST-GUARD', method: '收钱吧',
    ...priceOrder([{ id: 'p', name: 'Product', price: 10, qty: 1, productType: 'sale' }, line]) };
  await assert.rejects(bridge.prepareDraft(draft, 'test'), /正式.*测试/);
  assert.equal((await f.call('coupon', { id: coupon.id })).state, 'RESERVED');
  await bridge.prepareDraft(draft, 'production');
  assert.equal((await f.call('coupon', { id: coupon.id })).state, 'PAYMENT_PENDING');
});

test('verified SQB payment survives a lost cloud commit response and reconciles after cashier restart without charging again', async t => {
  const f = await fixture(t); const adminToken = 'a'.repeat(64);
  const server = http.createServer(couponHttp(f.store, { adminToken }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const platform = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  let purchases = 0; let loseCommit = true;
  const fetchFn = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'coupons.example.com') {
      const response = await fetch(`${base}${parsed.pathname}${parsed.search}`, options);
      if (parsed.pathname.endsWith('/commit') && loseCommit) { loseCommit = false; await response.text(); throw new TypeError('Simulated response loss after cloud commit'); }
      return response;
    }
    assert.ok(parsed.pathname.endsWith('/purchase')); purchases++;
    const body = JSON.parse(options.body).request.body;
    assert.equal(Number(body.amount), 500);
    const couponState = (await f.call('coupons')).items[0].state;
    assert.equal(couponState, 'PAYMENT_PENDING', 'Coupon must lock before moving money');
    const data = { ...body, order_sn: 'MOCK-PAID', order_type: 1, order_status: 4, tenders: [{ tender_sn: 'MOCK-T', amount: 500, pay_status: 3 }] };
    return new Response(signedEnvelope('response', { head: { appid: 'mock', sign_type: 'SHA256' }, body: { result_code: '200', biz_response: { result_code: '200', data } } }, platform.privateKey));
  };
  const directory = path.join(f.directory, 'cashier');
  let service = createService({ directory, fetchFn, resolveTerminalIp: async () => '8.8.4.4' });
  t.after(() => service.close());
  await service.dispatch('coupon-connect', { baseUrl: 'https://coupons.example.com', adminToken });
  await service.dispatch('generate-key');
  await service.dispatch('save-config', { mode: 'test', appid: 'mock', brand_code: 'MOCK', store_sn: 'mock', workstation_sn: '0', operator: 'QA', gateway: 'https://test.shouqianba.com', platformPublicKey: platform.publicKey });
  const issued = await service.dispatch('coupon-issue', { campaignId: f.campaign.id, owner: 'customer', awardId: 'award-service', requestId: uid() });
  const line = await service.dispatch('coupon-reserve', { code: issued.code, checkoutId: uid(), eligibleCents: 1000, requestId: uid() });
  const product = { id: 'p', name: 'Product', qty: 1, price: 10, stock: 2, productType: 'sale' };
  const draft = { id: uid(), orderNo: `POS${Date.now()}`, ...priceOrder([product, line]), method: '收钱吧' };
  const record = await service.dispatch('start', { draft, code: '130000000000000000', confirmTestPayment: true });
  assert.equal(record.state, 'paid'); assert.equal(purchases, 1);
  assert.equal((await f.call('coupon', { id: issued.id })).state, 'REDEEMED');
  const journal = JSON.parse(fs.readFileSync(path.join(directory, 'coupon-transactions.json'), 'utf8'));
  assert.equal(Object.values(journal)[0].finished, false);
  assert.match(Object.values(journal)[0].error, /同步未完成/);
  service.close(); service = createService({ directory, fetchFn, resolveTerminalIp: async () => '8.8.4.4' });
  assert.equal((await service.dispatch('query', { id: draft.id })).state, 'paid');
  assert.equal((await service.dispatch('coupon-sync')).length, 0); assert.equal(purchases, 1);
  await service.dispatch('acknowledge', { id: draft.id });
  await assert.rejects(service.dispatch('coupon-reserve', { code: issued.code, checkoutId: uid(), eligibleCents: 1000, requestId: uid() }), /已使用/);
  assert.ok(!fs.readFileSync(path.join(directory, 'payments.json'), 'utf8').includes('130000000000000000'));
});
