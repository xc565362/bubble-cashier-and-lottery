import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createOnlineHandler, SECTION_KEYS, ROLE_GRANTS } = require('../online/http.cjs');
const { createAuthStore } = require('../online/auth.cjs');
const { createOnlineLedger } = require('../online/ledger.cjs');
const { createPosFixture } = require('./helpers/posfixture.cjs');

const PASSWORD = 'fixture-access-password-42';
const TERMINAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const good = (id = 'p1', stock = 10) => ({ id, name: `商品${id}`, barcode: `bar-${id}`, sku: `sku-${id}`, group: '商品', productType: 'sale', originalPrice: 20, price: 10, couponAmount: 0, stock, giftEligible: false, imageUrl: '' });
const order = (product, id, qty = 1) => ({ id, orderNo: `N-${id}`, items: [{ ...product, qty, discount: 0 }], method: '扫码收款', total: product.price * qty });

function fakeService() {
  const records = {}, reservations = new Map();
  return { records, reservations,
    readOnlineState: () => ({ records: Object.values(records), restoreStage: null, couponRecords: [...reservations.values()] }),
    async dispatch(action, payload = {}) {
      if (action === 'config') return { mode: 'test', ready: true, appid: 'app-1', brand_code: 'brand', store_sn: 'store', workstation_sn: 'ws', operator: 'op', gateway: 'https://gateway.example', notify_url: 'https://notify.example',
        merchantPublicKey: '-----BEGIN PUBLIC KEY-----\nMERCHANTPUBLIC\n-----END PUBLIC KEY-----\n', platformPublicKey: '-----BEGIN PUBLIC KEY-----\nPLATFORMPUBLIC\n-----END PUBLIC KEY-----\n',
        privateKey: '-----BEGIN PRIVATE KEY-----\nMERCHANTSECRET\n-----END PRIVATE KEY-----\n', keyFingerprint: 'merchant-fp', directory: '/secret/directory', connectionCheck: { ok: true } };
      if (action === 'check-connection') return { connected: true, mode: 'test' };
      if (action === 'event-redeem') return { redeemed: true, code: payload.code || '' };
      if (action === 'pending') return Object.values(records).filter(r => !r.acknowledged);
      if (action === 'query') return records[payload.id] || null;
      if (action === 'start') {
        if (!records[payload.draft.id]) records[payload.draft.id] = { id: payload.draft.id, state: 'paid', acknowledged: false, orderSn: `SN-${payload.draft.id}`, amount: Math.round(payload.draft.total * 100), mode: 'test', identity: { check_sn: payload.draft.orderNo }, draft: payload.draft, tenders: [], updatedAt: '2026-10-20T06:00:00.000Z' };
        return records[payload.draft.id];
      }
      if (action === 'acknowledge') { records[payload.id].acknowledged = true; return { ok: true }; }
      if (action === 'coupon-reserve') {
        const p = payload.products.find(p => p.id === 'p1');
        const line = { ...p, productType: 'gift', price: 0, qty: 1, discount: 0, lineKey: 'lottery-gift:coupon-1', externalCoupon: { kind: 'physical', couponId: 'coupon-1', reservationId: 'reservation-1', centerId: 'test-center', environment: 'test', prizeId: 'scarf' } };
        reservations.set('reservation-1', { id: 'reservation-1', line, canRelease: true });
        return line;
      }
      if (action === 'coupon-release') { reservations.delete(payload.id); return { ok: true }; }
      if (action === 'coupon-sync') return [...reservations.values()];
      if (action === 'coupon-zero') {
        const row = reservations.get('reservation-1'); row.zeroDraft = payload.draft; row.canRelease = false; row.redeemed = true;
        return { draft: { ...payload.draft, items: payload.draft.items.map(({ imageUrl, ...p }) => p) }, coupon: { state: 'REDEEMED', redeemedAt: '2026-10-20T06:00:00.000Z' } };
      }
      if (action === 'coupon-zero-ack') { reservations.delete('reservation-1'); return { ok: true }; }
      if (action === 'coupon-fulfilment') return { redeemed: false };
      throw new Error(`unexpected fake service action: ${action}`);
    } };
}

async function fixture(t) {
  const pos = await createPosFixture(t);
  const auth = createAuthStore({ pool: pos.pool, ns: pos.ns });
  const service = fakeService();
  const ledger = await createOnlineLedger({ pool: pos.pool, ns: pos.ns, service });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-online-access-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>cashier</h1>');
  const admin = await auth.createInitialAdmin({ username: 'owner', password: PASSWORD, displayName: '店长' });
  let handler;
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  handler = createOnlineHandler({ auth, ledger, service, publicOrigin: origin, staticRoot: dir, allowHttpLocal: true });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); ledger.close(); auth.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  async function login(username, password = PASSWORD) {
    const res = await fetch(origin + '/api/online/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(res.status, 200, `${username} login`);
    const data = await res.json();
    return { user: data.user, csrfToken: data.csrfToken, cookie: res.headers.get('set-cookie').split(';')[0] };
  }
  async function api(session, route, { method = 'GET', body, terminal = TERMINAL } = {}) {
    const res = await fetch(origin + route, { method, headers: { Origin: origin, 'X-Terminal-Id': terminal,
      ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  }
  async function command(session, type, payload = {}, { requestId } = {}) {
    const snap = await api(session, '/api/online/ledger');
    return api(session, '/api/online/command', { method: 'POST', body: { type, payload, expectedRevision: snap.json.revision, requestId: requestId || crypto.randomUUID() } });
  }
  async function addProduct() {
    const owner = await login('owner');
    const saved = await command(owner, 'product-save', { product: good() });
    assert.equal(saved.status, 200, 'seed product');
    return owner;
  }
  return { pos, auth, ledger, service, admin, login, api, command, addProduct };
}

test('user model carries effective grants: templates, custom grants, redeemer role and validation', async t => {
  const f = await fixture(t);
  const owner = await f.login('owner');
  assert.deepEqual(owner.user.grants, [...SECTION_KEYS]);
  const cashier = await f.auth.createUser({ username: 'cashier1', password: PASSWORD, displayName: '收银员甲', role: 'cashier' }, f.admin);
  assert.deepEqual(cashier.grants, ROLE_GRANTS.cashier);
  const redeemer = await f.auth.createUser({ username: 'redeemer1', password: PASSWORD, displayName: '核销员甲', role: 'redeemer' }, f.admin);
  assert.deepEqual(redeemer.grants, ['events', 'coupons', 'orders']);
  const limited = await f.auth.createUser({ username: 'limited1', password: PASSWORD, displayName: '受限收银员', role: 'cashier', grants: ['pos', 'pos', 'orders'] }, f.admin);
  assert.deepEqual(limited.grants, ['pos', 'orders'], 'custom grants stored de-duplicated');
  await assert.rejects(f.auth.createUser({ username: 'badgrants', password: PASSWORD, role: 'cashier', grants: ['pos', 'vault'] }, f.admin), error => error.code === 'INVALID_GRANTS');
  const adminGranted = await f.auth.createUser({ username: 'secondadmin', password: PASSWORD, role: 'admin', grants: ['pos'] }, f.admin);
  assert.deepEqual(adminGranted.grants, [...SECTION_KEYS], 'admin grants are never stored');
  const session = await f.login('limited1');
  assert.deepEqual(session.user.grants, ['pos', 'orders']);
  const sessionRead = await f.api(session, '/api/online/session');
  assert.deepEqual(sessionRead.json.user.grants, ['pos', 'orders']);
  const users = await f.api(owner, '/api/online/users');
  assert.deepEqual(users.json.users.find(u => u.username === 'redeemer1').grants, ['events', 'coupons', 'orders']);
  const updated = await f.api(owner, `/api/online/users/${cashier.id}`, { method: 'PATCH', body: { grants: ['orders'] } });
  assert.equal(updated.status, 200); assert.deepEqual(updated.json.user.grants, ['orders']);
  const reset = await f.api(owner, `/api/online/users/${cashier.id}`, { method: 'PATCH', body: { grants: null } });
  assert.deepEqual(reset.json.user.grants, ROLE_GRANTS.cashier, 'null grants fall back to the role template');
  const invalid = await f.api(owner, `/api/online/users/${cashier.id}`, { method: 'PATCH', body: { grants: ['vault'] } });
  assert.equal(invalid.status, 400); assert.equal(invalid.json.code, 'INVALID_GRANTS');
});

test('section enforcement gates commands and SQB actions for cashier and redeemer', async t => {
  const f = await fixture(t);
  const owner = await f.addProduct();
  await f.auth.createUser({ username: 'cashier1', password: PASSWORD, displayName: '收银员甲', role: 'cashier' }, f.admin);
  await f.auth.createUser({ username: 'redeemer1', password: PASSWORD, displayName: '核销员甲', role: 'redeemer' }, f.admin);
  const cashier = await f.login('cashier1'), redeemer = await f.login('redeemer1');
  const denied = await f.command(cashier, 'product-save', { product: good('p2') });
  assert.equal(denied.status, 403); assert.equal(denied.json.code, 'FORBIDDEN'); assert.equal(denied.json.error, '没有该模块权限');
  const settings = await f.command(cashier, 'settings-save', { promoRules: [] });
  assert.equal(settings.status, 200, 'cashier template includes settings');
  const redeemerStart = await f.api(redeemer, '/api/sqb/start', { method: 'POST', body: { draft: { id: 'x' } } });
  assert.equal(redeemerStart.status, 403); assert.equal(redeemerStart.json.code, 'FORBIDDEN');
  const redeemerSync = await f.api(redeemer, '/api/sqb/coupon-sync', { method: 'POST', body: {} });
  assert.equal(redeemerSync.status, 200, 'redeemer may sync coupon reservations');
  const cashierSync = await f.api(cashier, '/api/sqb/coupon-sync', { method: 'POST', body: {} });
  assert.equal(cashierSync.status, 403, 'cashier template has no coupons section');
  const redeem = await f.api(redeemer, '/api/sqb/event-redeem', { method: 'POST', body: { code: 'event-code' } });
  assert.equal(redeem.status, 200); assert.equal(redeem.json.data.redeemed, true);
  const cashierCheck = await f.api(cashier, '/api/sqb/check-connection', { method: 'POST', body: {} });
  assert.equal(cashierCheck.status, 200, 'check-connection is a staff-readable probe'); assert.equal(cashierCheck.json.data.connected, true);
  const redeemerCheck = await f.api(redeemer, '/api/sqb/check-connection', { method: 'POST', body: {} });
  assert.equal(redeemerCheck.status, 200);
  await f.auth.updateUser((await f.api(owner, '/api/online/users')).json.users.find(u => u.username === 'cashier1').id, { grants: ['pos', 'products'] }, f.admin);
  const granted = await f.command(cashier, 'product-save', { product: good('p2') });
  assert.equal(granted.status, 200, 'same session picks up newly granted section live');
});

test('transaction pipe is implicit, first-come first-served, and auto-releases on terminal states', async t => {
  const f = await fixture(t);
  await f.addProduct();
  await f.auth.createUser({ username: 'cashier1', password: PASSWORD, displayName: '收银员甲', role: 'cashier' }, f.admin);
  await f.auth.createUser({ username: 'cashier2', password: PASSWORD, displayName: '收银员乙', role: 'cashier' }, f.admin);
  const a = await f.login('cashier1'), b = await f.login('cashier2');
  const prepared = await f.command(a, 'payment-prepare', { draft: order(good(), 'pipe-order') });
  assert.equal(prepared.status, 200, 'first pipe command takes the pipe implicitly');
  assert.equal((await f.api(a, '/api/online/ledger')).json.lease.held, true);
  const busy = await f.command(b, 'payment-prepare', { draft: order(good(), 'other-order') });
  assert.equal(busy.status, 409); assert.equal(busy.json.code, 'PIPE_BUSY'); assert.equal(busy.json.error, '另一位同事正在收款，请稍候');
  assert.equal(busy.json.data.holder.displayName, '收银员甲'); assert.equal(busy.json.data.holder.orderId, 'pipe-order'); assert.ok(busy.json.data.holder.since > 0);
  const started = await f.api(a, '/api/sqb/start', { method: 'POST', body: { draft: { id: 'pipe-order' }, code: 'test-only', confirmTestPayment: true } });
  assert.equal(started.status, 200);
  const synced = await f.command(a, 'payment-sync', { id: 'pipe-order' });
  assert.equal(synced.status, 200);
  assert.equal((await f.api(a, '/api/online/ledger')).json.lease.held, false, 'finishing the payment frees the pipe');
  const retry = await f.command(b, 'payment-prepare', { draft: order(good(), 'other-order') });
  assert.equal(retry.status, 200, 'colleague can pipe after auto-release');
  const cleared = await f.command(b, 'payment-clear', { id: 'other-order' });
  assert.equal(cleared.status, 200); assert.equal((await f.api(b, '/api/online/ledger')).json.lease.held, false);
  const manual = await f.command(a, 'manual-complete', { draft: { ...order(good(), 'manual-order'), method: '扫码收款' } });
  assert.equal(manual.status, 200); assert.equal((await f.api(a, '/api/online/ledger')).json.lease.held, false, 'manual completion releases immediately');
});

test('non-admin snapshots expose only own orders and own held carts, completions stamp the operator', async t => {
  const f = await fixture(t);
  const owner = await f.addProduct();
  await f.auth.createUser({ username: 'cashier1', password: PASSWORD, displayName: '收银员甲', role: 'cashier' }, f.admin);
  await f.auth.createUser({ username: 'cashier2', password: PASSWORD, displayName: '收银员乙', role: 'cashier' }, f.admin);
  const a = await f.login('cashier1'), b = await f.login('cashier2');
  assert.equal((await f.command(a, 'manual-complete', { draft: { ...order(good(), 'order-a'), method: '扫码收款' } })).status, 200);
  assert.equal((await f.command(b, 'manual-complete', { draft: { ...order(good(), 'order-b'), method: '扫码收款' } })).status, 200);
  const snapA = (await f.api(a, '/api/online/ledger')).json.ledger, snapB = (await f.api(b, '/api/online/ledger')).json.ledger;
  assert.deepEqual(snapA.orders.map(o => o.id), ['order-a']); assert.deepEqual(snapB.orders.map(o => o.id), ['order-b']);
  const snapAdmin = (await f.api(owner, '/api/online/ledger')).json.ledger;
  assert.deepEqual(snapAdmin.orders.map(o => o.id).sort(), ['order-a', 'order-b']);
  assert.equal(snapAdmin.orders.find(o => o.id === 'order-a').operatorId, a.user.id);
  assert.equal(snapAdmin.orders.find(o => o.id === 'order-b').operatorId, b.user.id);
  const heldByA = await f.command(a, 'hold', { basket: { id: 'cart-a', name: '甲的挂单', items: order(good(), 'held-draft').items } });
  assert.equal(heldByA.status, 200);
  assert.equal((await f.api(a, '/api/online/ledger')).json.ledger.heldCarts.length, 1);
  assert.equal((await f.api(b, '/api/online/ledger')).json.ledger.heldCarts.length, 0, 'held carts are scoped to their owner');
  assert.equal((await f.api(owner, '/api/online/ledger')).json.ledger.heldCarts.length, 1);
  const steal = await f.command(b, 'retrieve', { id: 'cart-a' });
  assert.equal(steal.status, 403); assert.equal(steal.json.error, '只能取出自己的挂单');
  // Legacy carts without an owner stay visible to admins only.
  const [rows] = await f.pos.pool.query('SELECT body FROM pos_ledger WHERE ns = ? AND id = 1', [f.pos.ns]);
  const body = JSON.parse(rows[0].body); delete body.heldCarts[0].ownerId;
  await f.pos.pool.query('UPDATE pos_ledger SET body = ? WHERE ns = ? AND id = 1', [JSON.stringify(body), f.pos.ns]);
  assert.equal((await f.api(a, '/api/online/ledger')).json.ledger.heldCarts.length, 0, 'unowned legacy carts are hidden from staff');
  assert.equal((await f.api(owner, '/api/online/ledger')).json.ledger.heldCarts.length, 1);
  // SQB completion and coupon zero completion both stamp the acting operator.
  assert.equal((await f.command(a, 'payment-prepare', { draft: order(good(), 'sqb-order') })).status, 200);
  assert.equal((await f.api(a, '/api/sqb/start', { method: 'POST', body: { draft: { id: 'sqb-order' }, code: 'test', confirmTestPayment: true } })).status, 200);
  assert.equal((await f.command(a, 'payment-sync', { id: 'sqb-order' })).status, 200);
  const reserved = await f.api(b, '/api/sqb/coupon-reserve', { method: 'POST', body: { code: 'prize-code', checkoutId: 'checkout-1', requestId: 'reserve-1', eligibleCents: 0 } });
  assert.equal(reserved.status, 200);
  const zero = await f.command(b, 'zero-complete', { draft: { id: 'zero-order', orderNo: 'N-zero-order', items: [reserved.json.data], total: 0 } });
  assert.equal(zero.status, 200); assert.equal((await f.api(b, '/api/online/ledger')).json.lease.held, false);
  const finalAdmin = (await f.api(owner, '/api/online/ledger')).json.ledger;
  assert.equal(finalAdmin.orders.find(o => o.id === 'sqb-order').operatorId, a.user.id);
  assert.equal(finalAdmin.orders.find(o => o.id === 'zero-order').operatorId, b.user.id);
  assert.deepEqual((await f.api(a, '/api/online/ledger')).json.ledger.orders.map(o => o.id).sort(), ['order-a', 'sqb-order']);
});

test('config read strips key material and masks the platform verify key', async t => {
  const f = await fixture(t);
  await f.auth.createUser({ username: 'cashier1', password: PASSWORD, displayName: '收银员甲', role: 'cashier' }, f.admin);
  const cashier = await f.login('cashier1');
  const res = await f.api(cashier, '/api/sqb/config', { method: 'POST', body: {} });
  assert.equal(res.status, 200);
  const data = res.json.data;
  assert.equal(data.directory, undefined);
  assert.equal(data.merchantPublicKey.includes('MERCHANTPUBLIC'), true, 'merchant public key stays copyable for 收钱吧 setup');
  assert.deepEqual(Object.keys(data.platformPublicKey).sort(), ['fingerprint', 'length', 'present']);
  assert.equal(data.platformPublicKey.present, true); assert.match(data.platformPublicKey.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(data.platformPublicKey.length > 0);
  assert.equal(data.ready, true); assert.equal(data.appid, 'app-1'); assert.deepEqual(data.connectionCheck, { ok: true });
  assert.equal(res.text.includes('MERCHANTSECRET'), false, 'merchant private key never leaves the server');
  assert.equal(res.text.includes('PLATFORMPUBLIC'), false, 'platform key is masked to presence and fingerprint');
  assert.equal(res.text.includes('PRIVATE KEY'), false);
});
