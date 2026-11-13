import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { priceOrder, completeOrder } from '../src/orderLogic.js';
const require = createRequire(import.meta.url);
const { createOnlineHandler } = require('../online/http.cjs');
const { createAuthStore } = require('../online/auth.cjs');
const { createOnlineLedger } = require('../online/ledger.cjs');
const { createService } = require('../payments/service.cjs');
const { signedEnvelope } = require('../payments/litepos.cjs');
const { createCouponStore } = require('../coupons/store.cjs');
const { createActivityStore, createPrizeRedeemOnPaid } = require('../activities/store.cjs');
const { createServerProtector } = require('../online/secrets.cjs');
const { createPosFixture } = require('./helpers/posfixture.cjs');

const mockCode2session = async code => ({ openid: 'mock_' + crypto.createHash('sha256').update(String(code)).digest('hex').slice(0, 16) });

const GIFT = {
  id: 'gift-cap', name: '棒球帽', barcode: '690000000001', sku: 'CAP-01', group: '装备',
  imageUrl: 'https://img.example.com/cap.png', productType: 'gift', giftEligible: true,
  originalPrice: 0, price: 0, stock: 50, couponAmount: 0,
};
const SALE = {
  id: 'sale-tea', name: '柠檬茶', barcode: '690000000002', sku: 'TEA-01', group: '饮品',
  imageUrl: '', productType: 'sale', giftEligible: false, originalPrice: 0, price: 10, stock: 20, couponAmount: 0,
};
const SALE_GIFTABLE = {
  id: 'sale-hat', name: '渔夫帽', barcode: '690000000003', sku: 'HAT-01', group: '装备',
  imageUrl: '', productType: 'sale', giftEligible: true, originalPrice: 0, price: 39, stock: 15, couponAmount: 0,
};
const admin = { userId: 'admin', sessionId: 'session-a', role: 'admin', displayName: '管理员甲' };
const adminActor = { userId: 'admin-1', role: 'admin', displayName: '管理员' };
const couponAdmin = { id: 'administrator', role: 'admin' };
const terminal = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function fixture(t) {
  const pos = await createPosFixture(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-activity-prize-'));
  const protector = createServerProtector({ keyFile: path.join(directory, 'server.key') });
  let time = Date.now();
  const logs = [];
  const couponStore = await createCouponStore({ pool: pos.pool, ns: pos.ns, environment: 'development', now: () => time });
  const activityStore = createActivityStore({ pool: pos.pool, ns: pos.ns, couponStore, ...protector, code2session: mockCode2session, now: () => time, randomUnit: () => 0 });
  await pos.pool.query('INSERT IGNORE INTO pos_ledger (ns, id, revision, body) VALUES (?, 1, 0, ?)', [pos.ns, JSON.stringify({
    products: [GIFT, SALE, SALE_GIFTABLE], orders: [], heldCarts: [], paymentQr: '', promoRules: [],
    pendingPayment: null, pendingAdjustment: null, pendingZero: null, pendingRestore: null, pendingCouponReservation: null,
  })]);
  const campaign = await couponStore.dispatch(couponAdmin, 'create-campaign', {
    requestId: 'prize-checkout-campaign', name: '10元立减金', kind: 'cash', amountCents: 1000, minimumCents: 0, quota: 10,
    startsAt: new Date(time - 60000).toISOString(), expiresAt: new Date(time + 86400000).toISOString(),
  });
  const platform = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  let gatewayPaidOnPurchase = true;
  const sqbOrders = new Map();
  const service = createService({ directory: path.join(directory, 'payments'), couponStore, protect: protector.protect, unprotect: protector.unprotect,
    resolveTerminalIp: async () => '8.8.4.4',
    fetchFn: async (url, options) => {
      const parsed = new URL(url);
      const body = JSON.parse(options.body).request.body;
      if (parsed.pathname.endsWith('/purchase')) sqbOrders.set(body.check_sn, { amount: body.amount, paid: gatewayPaidOnPurchase });
      const order = sqbOrders.get(body.check_sn);
      assert.ok(order, `test gateway: unknown check_sn ${body.check_sn}`);
      const data = { ...body, amount: order.amount, currency: '156', order_sn: `MOCK-${body.check_sn}`, order_type: 1, order_status: order.paid ? 4 : 1,
        tenders: order.paid ? [{ tender_sn: 'MOCK-T', amount: order.amount, pay_status: 3, pay_time: new Date(time).toISOString() }] : [] };
      return new Response(signedEnvelope('response', { head: { appid: 'mock', sign_type: 'SHA256' }, body: { result_code: '200', biz_response: { result_code: '200', data } } }, platform.privateKey));
    },
    activityPrizeCheck: payload => activityStore.dispatch('activity-prize-check', payload),
    onOrderPaid: createPrizeRedeemOnPaid(activityStore.redeem, { log: message => logs.push(message) }) });
  await service.dispatch('generate-key');
  await service.dispatch('save-config', { mode: 'production', appid: 'mock', brand_code: 'MOCK', store_sn: 'mock', workstation_sn: '0', operator: 'QA', gateway: 'https://test.shouqianba.com', platformPublicKey: platform.publicKey });
  const ledger = await createOnlineLedger({ pool: pos.pool, ns: pos.ns, service, now: () => time, leaseMs: 1000 });
  const f = { ...pos, directory, protector, couponStore, activityStore, campaign, service, ledger, logs,
    advance: ms => { time += ms; }, now: () => time,
    setGatewayPaidOnPurchase: (value) => { gatewayPaidOnPurchase = value; },
    gatewayPay: (checkSn) => { const order = sqbOrders.get(checkSn); assert.ok(order, `no fake SQB order ${checkSn}`); order.paid = true; } };
  t.after(() => { ledger.close(); service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return f;
}

async function cmd(f, type, payload = {}, who = admin) {
  return f.ledger.command({ type, payload, expectedRevision: (await f.ledger.snapshot(who)).revision, requestId: `request-${crypto.randomUUID()}` }, who);
}

const makeActivity = async (f, over = {}) => f.activityStore.dispatch('activity-create', {
  config: {
    name: '赛场同行', title: '此刻在地', venue: 'Bubble展位', cashTerms: '', rulesText: '',
    startsAt: f.now() - 1000, endsAt: f.now() + 86400000, redeemEndsAt: f.now() + 86400000,
    prizes: [
      { id: 'cash10', kind: 'cash', couponCampaignId: f.campaign.id, qty: 1, probability: 1 },
      { id: 'cap', kind: 'physical', product: { id: 'gift-cap' }, qty: 1, probability: 1 },
    ],
    ...over,
  },
  state: 'active',
}, adminActor).then(r => r.activity);

const drawFor = async (f, id, code) => {
  const { token } = await f.activityStore.session(id, code);
  return f.activityStore.publicCall(id, 'draw', {}, { token });
};
// randomUnit: () => 0 always picks the FIRST prize with stock, so keep drawing
// with fresh participants until a physical-prize entry actually comes out.
const drawPhysical = async (f, activityId, participant) => {
  for (let i = 0; ; i++) {
    assert.ok(i < 6, 'physical prize should be winnable');
    const entry = await drawFor(f, activityId, `${participant}-${i}`);
    if (/^[0-9A-F]{16}$/.test(entry.code || '') && entry.checkoutCoupon === false) return entry;
  }
};
const prizeLine = (code, prizeName = '棒球帽') => ({ ...GIFT, qty: 1, discount: 0, source: 'prize', lineKey: `prize:${code}`, prize: { code, prizeName } });
const entryRow = async (f, code) => {
  const [rows] = await f.pool.query('SELECT data FROM pos_activity_entries WHERE ns = ? AND code = ?', [f.ns, code]);
  const value = rows[0].data;
  return typeof value === 'string' ? JSON.parse(value) : value;
};

async function httpFixture(t) {
  const f = await fixture(t);
  const auth = createAuthStore({ pool: f.pool, ns: f.ns });
  const owner = await auth.createInitialAdmin({ username: 'owner', password: 'fixture-admin-password', displayName: '测试管理员' });
  await auth.createUser({ username: 'till', password: 'fixture-staff-password', displayName: '台前提货员', role: 'cashier', grants: ['pos', 'events', 'orders'] }, owner);
  await auth.createUser({ username: 'eventsonly', password: 'fixture-staff-password', displayName: '活动专员', role: 'cashier', grants: ['events'] }, owner);
  fs.mkdirSync(path.join(f.directory, 'dist'));
  fs.writeFileSync(path.join(f.directory, 'dist/index.html'), '<h1>Login</h1>');
  const activities = { dispatch: (action, payload, actor) => f.activityStore.dispatch(action, payload, actor), publicHttp: null };
  let handler;
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  handler = createOnlineHandler({ auth, ledger: f.ledger, service: f.service, activities, publicOrigin: origin, staticRoot: path.join(f.directory, 'dist'), allowHttpLocal: true });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); auth.close(); });
  async function login(username, password) {
    const res = await fetch(origin + '/api/online/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(res.status, 200);
    const data = await res.json();
    return { data, cookie: res.headers.get('set-cookie').split(';')[0] };
  }
  async function api(session, action, payload = {}) {
    const res = await fetch(origin + '/api/sqb/' + action, { method: 'POST', headers: { Origin: origin, 'X-Terminal-Id': terminal, 'Content-Type': 'application/json',
      ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.data.csrfToken } : {}) }, body: JSON.stringify(payload) });
    return { status: res.status, body: await res.json() };
  }
  return { ...f, origin, login, api };
}

test('activity-prize-check routes cash vs physical over the staff API with 401/403/404/409', async t => {
  const f = await httpFixture(t);
  const activity = await makeActivity(f);
  const cash = await drawFor(f, activity.id, 'wx-cash');
  assert.equal(cash.checkoutCoupon, true);
  const physical = await drawPhysical(f, activity.id, 'wx-cap');

  assert.equal((await f.api(null, 'activity-prize-check', { code: physical.code })).status, 401, 'session required');
  const till = await f.login('till', 'fixture-staff-password');
  const eventsOnly = await f.login('eventsonly', 'fixture-staff-password');

  const asPhysical = await f.api(till, 'activity-prize-check', { code: physical.code });
  assert.equal(asPhysical.status, 200);
  assert.deepEqual(asPhysical.body.data, {
    kind: 'physical', entryCode: physical.code, prizeName: '棒球帽',
    product: { id: 'gift-cap', name: '棒球帽', sku: 'CAP-01', barcode: '690000000001' },
  });

  const asCash = await f.api(till, 'activity-prize-check', { code: cash.code });
  assert.equal(asCash.status, 200);
  assert.deepEqual(asCash.body.data, { kind: 'cash' }, 'cash entries keep the existing coupon-reserve path');

  const eventsDenied = await f.api(eventsOnly, 'activity-prize-check', { code: physical.code });
  assert.equal(eventsDenied.status, 403, 'till scan needs the pos grant, not only events');
  assert.equal(eventsDenied.body.code, 'FORBIDDEN');

  const unknown = await f.api(till, 'activity-prize-check', { code: 'A1B2C3D4E5F60708' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, 'NOT_FOUND');

  const redeemed = await f.api(till, 'activity-redeem', { code: physical.code });
  assert.equal(redeemed.status, 200);
  const again = await f.api(till, 'activity-prize-check', { code: physical.code });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'ALREADY_REDEEMED');
  assert.match(again.body.error, /已核销/);
});

test('activity-prize-check answers 410 EXPIRED after the redemption deadline and is guarded during unresolved payments', async t => {
  const f = await fixture(t);
  const activity = await makeActivity(f, { redeemEndsAt: f.now() + 1000 });
  const entry = await drawPhysical(f, activity.id, 'wx-cap');
  const before = await f.activityStore.dispatch('activity-prize-check', { code: entry.code }, adminActor);
  assert.equal(before.kind, 'physical');
  f.advance(2000);
  await assert.rejects(f.activityStore.dispatch('activity-prize-check', { code: entry.code }, adminActor),
    error => error.code === 'EXPIRED' && error.status === 410);

  // Unresolved-payment guard, same as coupon-reserve: a paid-but-unacknowledged
  // record blocks the till scan until the payment is synced.
  const g = await fixture(t);
  const active = await makeActivity(g);
  const pending = await drawPhysical(g, active.id, 'wx-guard');
  await cmd(g, 'payment-prepare', { draft: { id: 'guard-order', orderNo: 'N-guard', method: '收钱吧', items: [{ ...SALE, qty: 1, discount: 0 }], total: 10 } });
  await g.ledger.paymentDispatch('start', { draft: { id: 'guard-order' }, code: '130000000000000000' }, admin);
  await assert.rejects(g.service.dispatch('activity-prize-check', { code: pending.code }), /请先核对当前收退款/);
  await cmd(g, 'payment-sync', { id: 'guard-order' });
  const after = await g.service.dispatch('activity-prize-check', { code: pending.code });
  assert.equal(after.kind, 'physical');
});

test('redeem-on-paid fires on confirmed payment, flips the entry once, decrements stock, and is double-fire safe', async t => {
  const f = await fixture(t);
  const activity = await makeActivity(f);
  const entry = await drawPhysical(f, activity.id, 'wx-cap');
  const line = prizeLine(entry.code);
  const priced = priceOrder([{ ...SALE, qty: 1, discount: 0 }, line]);
  assert.equal(priced.total, 10, 'prize line prices as ¥0 and does not change order math');
  assert.equal(priced.items.find(item => item.prize)?.lineTotal, 0);

  await cmd(f, 'payment-prepare', { draft: { id: 'order-prize', orderNo: 'N-prize', method: '收钱吧', ...priced } });
  const record = await f.ledger.paymentDispatch('start', { draft: { id: 'order-prize' }, code: '130000000000000000' }, admin);
  assert.equal(record.state, 'paid');
  assert.equal((await entryRow(f, entry.code)).status, 'pending', 'not redeemed before the order commits');

  await cmd(f, 'payment-sync', { id: 'order-prize' });
  const after = await entryRow(f, entry.code);
  assert.equal(after.status, 'redeemed');
  assert.equal(after.redeemedBy, 'cashier:管理员甲');

  const snapshot = (await f.ledger.snapshot(admin)).ledger;
  const order = snapshot.orders.find(o => o.id === 'order-prize');
  assert.ok(order.items.some(item => item.prize?.code === entry.code), 'prize tag survives into the committed order');
  assert.equal(snapshot.products.find(p => p.id === 'sale-tea').stock, 19);
  assert.equal(snapshot.products.find(p => p.id === 'gift-cap').stock, 49, 'prize stock decrements through the normal order flow');
  assert.deepEqual(f.logs, []);

  // Re-sync (recovery) and a direct re-fire are both absorbed by idempotent redeem.
  await cmd(f, 'payment-sync', { id: 'order-prize' });
  await f.service.notifyOrderPaid(order, admin);
  assert.equal((await entryRow(f, entry.code)).status, 'redeemed');
  assert.equal((await entryRow(f, entry.code)).redeemedAt, after.redeemedAt, 'redeemed exactly once');
  assert.deepEqual(f.logs, [], 'ALREADY_REDEEMED is swallowed, never logged as a failure');
});

test('redeem-on-paid fires on zero-amount settlement for a prize-only order', async t => {
  const f = await fixture(t);
  const activity = await makeActivity(f);
  const entry = await drawPhysical(f, activity.id, 'wx-cap');
  await cmd(f, 'manual-complete', { draft: { id: 'order-zero', orderNo: 'N-zero', method: '零元结算', items: [prizeLine(entry.code)], total: 0 } });
  const after = await entryRow(f, entry.code);
  assert.equal(after.status, 'redeemed');
  assert.equal(after.redeemedBy, 'cashier:管理员甲');
  const snapshot = (await f.ledger.snapshot(admin)).ledger;
  assert.equal(snapshot.products.find(p => p.id === 'gift-cap').stock, 49);
  assert.deepEqual(f.logs, []);
  const order = snapshot.orders.find(o => o.id === 'order-zero');
  await f.service.notifyOrderPaid(order, admin);
  assert.equal((await entryRow(f, entry.code)).redeemedAt, after.redeemedAt, 'double-fire safe on zero settle too');
  assert.deepEqual(f.logs, []);
});

test('可售可赠 products redeem as free prize lines: zero total, stock decrements', async t => {
  const f = await fixture(t);
  const activity = await makeActivity(f);
  const entry = await drawPhysical(f, activity.id, 'wx-hat');
  // The till forces prize lines to gift/¥0 regardless of the catalog price —
  // the client sends the sale product with a hacked price/type, and the
  // server must canonicalize it the same way instead of PRICE_CHANGED.
  const tillLine = { ...SALE_GIFTABLE, qty: 1, productType: 'gift', price: 0, discount: 0, source: 'prize', lineKey: `prize:${entry.code}`, prize: { code: entry.code, prizeName: '渔夫帽' } };
  await cmd(f, 'manual-complete', { draft: { id: 'order-hat', orderNo: 'N-hat', method: '零元结算', items: [tillLine], total: 0 } });
  const snapshot = (await f.ledger.snapshot(admin)).ledger;
  const order = snapshot.orders.find(o => o.id === 'order-hat');
  assert.equal(order.total, 0, 'prize line contributes nothing despite the ¥39 catalog price');
  const line = order.items.find(item => item.prize?.code === entry.code);
  assert.equal(line.productType, 'gift');
  assert.equal(line.price, 0);
  assert.equal(line.catalogProduct?.price, 39, 'original sale terms preserved for aftersales');
  assert.equal(snapshot.products.find(p => p.id === 'sale-hat').stock, 14, 'stock still decrements');
  assert.equal((await entryRow(f, entry.code)).status, 'redeemed');
});

test('orphan sweep commits a paid payment whose checkout was abandoned', async t => {
  const f = await fixture(t);
  f.setGatewayPaidOnPurchase(false);
  // A plain sale order — the orphan sweep is payment-generic.
  await cmd(f, 'payment-prepare', { draft: { id: 'order-orphan', orderNo: 'N-orphan', method: '收钱吧', items: [{ ...SALE, qty: 2, discount: 0 }], total: 20 } });
  const started = await f.ledger.paymentDispatch('start', { draft: { id: 'order-orphan' }, code: '130000000000000000' }, admin);
  assert.equal(started.state, 'pending', 'SQB created the order unpaid');
  // The checkout is abandoned mid-flight — today's manual rescue did exactly
  // this: pendingPayment dropped while the record lives on at SQB.
  await f.pool.query('UPDATE pos_ledger SET body = JSON_SET(body, "$.pendingPayment", NULL) WHERE ns = ? AND id = 1', [f.ns]);
  assert.ok(!(await f.ledger.snapshot(admin)).ledger.orders.some(o => o.id === 'order-orphan'), 'not committed after abandonment');
  // The customer completes payment on the orphaned SQB order.
  f.gatewayPay('N-orphan');
  assert.equal(await f.ledger.sweepOrphans(), true);
  const snapshot = (await f.ledger.snapshot(admin)).ledger;
  const order = snapshot.orders.find(o => o.id === 'order-orphan');
  assert.ok(order, 'orphan sweep committed the paid order');
  assert.equal(order.status, '已收款');
  assert.equal(order.total, 20);
  assert.equal(order.operatorId, 'system');
  assert.equal(snapshot.products.find(p => p.id === 'sale-tea').stock, 18, 'stock decremented by the late commit');
});

test('prize tags are validated server-side: bad shape rejected, wrong product kind rejected, cash codes cannot ride a prize line', async t => {
  const f = await fixture(t);
  const activity = await makeActivity(f);
  const cash = await drawFor(f, activity.id, 'wx-cash');
  assert.equal(cash.checkoutCoupon, true);
  const physical = await drawFor(f, activity.id, 'wx-cap');
  assert.equal(physical.checkoutCoupon, false);

  await assert.rejects(cmd(f, 'manual-complete', { draft: { id: 'bad-1', orderNo: 'NB1', method: '零元结算',
    items: [{ ...GIFT, qty: 1, discount: 0, source: 'prize', lineKey: 'prize:XYZ', prize: { code: 'XYZ', prizeName: '' } }], total: 0 } }),
    error => error.code === 'INVALID_INPUT');
  await assert.rejects(cmd(f, 'manual-complete', { draft: { id: 'bad-2', orderNo: 'NB2', method: '零元结算',
    items: [{ ...SALE, qty: 1, discount: 0, source: 'prize', lineKey: `prize:${physical.code}`, prize: { code: physical.code, prizeName: 'x' } }], total: 0 } }),
    /抽奖奖品固定为一件赠品/);

  // A cash (checkout-coupon) code smuggled onto a gift line must not throw into
  // the response path; it is logged loudly and the order still commits.
  await cmd(f, 'manual-complete', { draft: { id: 'bad-3', orderNo: 'NB3', method: '零元结算', items: [prizeLine(cash.code, '10元立减金')], total: 0 } });
  assert.equal(f.logs.length, 1, 'cash codes on prize lines are logged, not thrown');
  assert.match(f.logs[0], new RegExp(cash.code));
  assert.equal((await f.ledger.snapshot(admin)).ledger.orders.some(o => o.id === 'bad-3'), true);
  assert.equal((await entryRow(f, physical.code)).status, 'pending', 'unrelated entries untouched');
});

test('order math is unchanged when no prize lines are present', async t => {
  const plain = priceOrder([{ ...SALE, qty: 2, discount: 3 }]);
  assert.deepEqual(plain, {
    items: [{ ...SALE, qty: 2, price: 10, discount: 3, lineTotal: 17 }],
    subtotal: 20, discount: 3, couponDiscount: 0, total: 17,
  });
  const f = await fixture(t);
  await cmd(f, 'manual-complete', { draft: { id: 'plain-1', orderNo: 'NP1', method: '扫码收款', items: [{ ...SALE, qty: 2, discount: 3 }], total: 17 } });
  const ledger = (await f.ledger.snapshot(admin)).ledger;
  assert.equal(ledger.orders[0].total, 17);
  assert.equal(ledger.products.find(p => p.id === 'sale-tea').stock, 18);
  assert.equal(ledger.products.find(p => p.id === 'gift-cap').stock, 50);
  assert.deepEqual(f.logs, [], 'no prize lines, no redemption traffic');
  // completeOrder stays pure and race-free for ordinary carts.
  const done = completeOrder({ products: [SALE], orders: [] }, { id: 'pure-1', orderNo: 'PURE1', method: '扫码收款', items: [{ ...SALE, qty: 1, discount: 0 }] });
  assert.equal(done.products[0].stock, 19);
});
