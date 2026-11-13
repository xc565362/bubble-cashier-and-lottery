import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createOnlineHandler } = require('../online/http.cjs');
const { createAuthStore } = require('../online/auth.cjs');
const { createCouponStore } = require('../coupons/store.cjs');
const { createActivityStore } = require('../activities/store.cjs');
const { createActivityHttp } = require('../activities/http.cjs');
const { createServerProtector } = require('../online/secrets.cjs');
const { createPosFixture } = require('./helpers/posfixture.cjs');

const mockCode2session = async code => ({ openid: 'mock_' + crypto.createHash('sha256').update(String(code)).digest('hex').slice(0, 16) });

async function fixture(t) {
  const pos = await createPosFixture(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-activity-http-'));
  const auth = createAuthStore({ pool: pos.pool, ns: pos.ns });
  const admin = await auth.createInitialAdmin({ username: 'owner', password: 'fixture-admin-password', displayName: '测试管理员' });
  await auth.createUser({ username: 'staff', password: 'fixture-staff-password', displayName: '测试收银员', role: 'cashier' }, admin);
  await auth.createUser({ username: 'restricted', password: 'fixture-staff-password', displayName: '限制权限', role: 'cashier', grants: ['pos'] }, admin);
  fs.mkdirSync(path.join(dir, 'dist'));
  fs.writeFileSync(path.join(dir, 'dist/index.html'), '<h1>Login</h1>');
  const protector = createServerProtector({ keyFile: path.join(dir, 'server.key') });
  const couponStore = await createCouponStore({ pool: pos.pool, ns: pos.ns, environment: 'development' });
  await pos.pool.query('INSERT IGNORE INTO pos_ledger (ns, id, revision, body) VALUES (?, 1, 0, ?)', [pos.ns, JSON.stringify({ products: [
    { id: 'gift-cap', name: '棒球帽', barcode: '690000000001', sku: 'CAP-01', group: '装备', imageUrl: 'https://img.example.com/cap.png', productType: 'gift', giftEligible: true, originalPrice: 0, price: 0, stock: 50, couponAmount: 0 },
  ] })]);
  const campaign = await couponStore.dispatch({ id: 'administrator', role: 'admin' }, 'create-campaign', {
    requestId: 'activity-http-fixture-campaign', name: '10元立减金', kind: 'cash', amountCents: 1000, minimumCents: 0, quota: 10,
    startsAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  const store = createActivityStore({ pool: pos.pool, ns: pos.ns, couponStore, ...protector, code2session: mockCode2session, randomUnit: () => 0 });
  const activities = { dispatch: (action, payload, actor) => store.dispatch(action, payload, actor), publicHttp: createActivityHttp({ store }) };
  const service = { dispatch: async () => ({}), notification: async () => '{}' };
  const ledger = { snapshot: () => ({ revision: 0, ledger: { products: [], orders: [], heldCarts: [] } }), assertLease: () => {}, command: async () => ({}), paymentDispatch: async () => ({}) };
  let handler;
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  handler = createOnlineHandler({ auth, ledger, service, activities, publicOrigin: origin, staticRoot: path.join(dir, 'dist'), allowHttpLocal: true });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); auth.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const terminal = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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
  async function pub(route, { body, token, staffKey, method = 'POST' } = {}) {
    const res = await fetch(origin + route, { method, headers: { 'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(staffKey ? { 'X-Staff-Key': staffKey } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json(), headers: res.headers };
  }
  const activityConfig = (over = {}) => ({
    name: '赛场同行', title: '此刻在地', venue: 'Bubble展位', cashTerms: '每单限一张', rulesText: '',
    startsAt: Date.now() - 1000, endsAt: Date.now() + 86400000, redeemEndsAt: Date.now() + 86400000,
    prizes: [
      { id: 'cash10', kind: 'cash', couponCampaignId: campaign.id, qty: 1, probability: 1 },
      { id: 'cap', kind: 'physical', product: { id: 'gift-cap' }, qty: 1, probability: 1 },
    ],
    ...over,
  });
  return { ...pos, origin, login, api, pub, activityConfig, store, campaign, couponStore, protector };
}

test('activity admin actions enforce cashier session, admin role and events grant', async t => {
  const f = await fixture(t);
  const config = f.activityConfig();
  assert.equal((await f.api(null, 'activity-list', {})).status, 401);
  const admin = await f.login('owner', 'fixture-admin-password');
  const created = await f.api(admin, 'activity-create', { config, state: 'draft' });
  assert.equal(created.status, 200);
  assert.equal(created.body.ok, true);
  assert.equal(created.body.data.activity.state, 'draft');
  // Pool-based validation surfaces over the admin API with a clear Chinese error.
  const badCampaign = await f.api(admin, 'activity-create', { config: f.activityConfig({ prizes: [{ id: 'x', kind: 'cash', couponCampaignId: 'no-such-campaign', qty: 1, probability: 1 }] }), state: 'draft' });
  assert.equal(badCampaign.status, 400);
  assert.equal(badCampaign.body.code, 'CAMPAIGN_MISSING');
  assert.match(badCampaign.body.error, /所选优惠券不存在/);
  const freeAmount = await f.api(admin, 'activity-create', { config: f.activityConfig({ prizes: [{ id: 'x', name: 'x', kind: 'cash', amount: 10, qty: 1, probability: 1 }] }), state: 'draft' });
  assert.equal(freeAmount.status, 400);
  assert.equal(freeAmount.body.code, 'INVALID_CONFIG');
  assert.match(freeAmount.body.error, /面额由所选券活动决定/);
  const staff = await f.login('staff', 'fixture-staff-password');
  const restricted = await f.login('restricted', 'fixture-staff-password');
  // Staff with the default cashier template (events grant) may read...
  assert.equal((await f.api(staff, 'activity-list', {})).status, 200);
  assert.equal((await f.api(staff, 'activity-records', { id: created.body.data.activity.id })).status, 200);
  // ...but not mutate, which is admin-only.
  for (const action of ['activity-create', 'activity-update', 'activity-set-status', 'activity-export']) {
    assert.equal((await f.api(staff, action, { id: created.body.data.activity.id, config, state: 'active' })).status, 403, action);
  }
  // A cashier without the events grant is denied even the reads.
  for (const action of ['activity-list', 'activity-records', 'activity-lookup', 'activity-redeem']) {
    const res = await f.api(restricted, action, { id: created.body.data.activity.id, code: 'A1B2C3D4E5F60708' });
    assert.equal(res.status, 403, action);
    assert.equal(res.body.code, 'FORBIDDEN');
  }
  assert.equal((await f.api(restricted, 'coupon-pending', {})).status, 200, 'unrelated sections stay intact');
});

test('public H5 flow: session, state, atomic draw, staff lookup; paused blocks draws only', async t => {
  const f = await fixture(t);
  const admin = await f.login('owner', 'fixture-admin-password');
  const created = await f.api(admin, 'activity-create', { config: f.activityConfig({ staffKey: 'booth-key' }), state: 'active' });
  const id = created.body.data.activity.id;

  const login = await f.pub(`/activity/${id}/session`, { body: { code: 'wx-code-1' } });
  assert.equal(login.status, 200);
  assert.equal(login.body.ok, true);
  assert.equal(login.headers.get('access-control-allow-origin'), '*');
  const { token } = login.body.data;

  const state = await f.pub(`/activity/${id}/call`, { body: { action: 'state' }, token });
  assert.equal(state.body.data.campaign.id, id);
  assert.equal(state.body.data.drawsRemaining, 1);
  assert.equal(state.body.data.entry, null);

  const draw = await f.pub(`/activity/${id}/call`, { body: { action: 'draw' }, token });
  assert.equal(draw.status, 200);
  const entry = draw.body.data;
  assert.equal(entry.prize.id, 'cash10');
  assert.equal(entry.checkoutCoupon, true);
  assert.match(entry.code, /^[0-9A-F]{16}$/);
  const [tokens] = await f.pool.query('SELECT coupon_id FROM pos_coupon_tokens WHERE ns = ? AND token = ?', [f.ns, entry.code]);
  assert.equal(tokens.length, 1, 'coupon minted atomically with the entry');

  const again = await f.pub(`/activity/${id}/call`, { body: { action: 'draw' }, token });
  assert.equal(again.body.data.code, entry.code, 'double draw returns the stored entry');

  assert.equal((await f.pub(`/activity/${id}/call`, { body: { action: 'state' } })).body.code, 'AUTH_REQUIRED');
  const denied = await f.pub(`/activity/${id}/call`, { body: { action: 'lookup', payload: { code: entry.code } }, token });
  assert.equal(denied.status, 403);
  const staffLookup = await f.pub(`/activity/${id}/call`, { body: { action: 'lookup', payload: { code: entry.code } }, staffKey: 'booth-key' });
  assert.equal(staffLookup.status, 200);
  assert.equal(staffLookup.body.data.code, entry.code);

  const bad = await f.pub(`/activity/${crypto.randomUUID()}/session`, { body: { code: 'x' } });
  assert.equal(bad.status, 404);
  assert.equal((await f.pub(`/activity/${id}/unknown`, { body: {} })).status, 404);
  assert.equal((await f.pub(`/activity/${id}/state`, { method: 'GET' })).status, 404);
  assert.equal((await f.pub(`/activity/${id}/session`, { method: 'GET' })).status, 405);
  const options = await fetch(f.origin + `/activity/${id}/session`, { method: 'OPTIONS' });
  assert.equal(options.status, 204);
  assert.match(options.headers.get('access-control-allow-headers'), /Authorization/);

  const paused = await f.api(admin, 'activity-set-status', { id, state: 'paused' });
  assert.equal(paused.body.data.activity.state, 'paused');
  const latecomer = await f.pub(`/activity/${id}/session`, { body: { code: 'wx-code-late' } });
  const blockedDraw = await f.pub(`/activity/${id}/call`, { body: { action: 'draw' }, token: latecomer.body.data.token });
  assert.equal(blockedDraw.status, 410);
  assert.deepEqual(Object.keys(blockedDraw.body).sort(), ['code', 'error', 'message', 'ok']);
  assert.equal(blockedDraw.body.code, 'PAUSED');
  const pausedLogin = await f.pub(`/activity/${id}/session`, { body: { code: 'wx-code-2' } });
  assert.equal(pausedLogin.status, 200, 'winners can still sign in while paused');
  const pausedState = await f.pub(`/activity/${id}/call`, { body: { action: 'state' }, token });
  assert.equal(pausedState.body.data.entry.code, entry.code);

  const draft = (await f.api(admin, 'activity-create', { config: f.activityConfig(), state: 'draft' })).body.data.activity;
  assert.equal((await f.pub(`/activity/${draft.id}/session`, { body: { code: 'x' } })).status, 404);
});

test('a WeChat code2session rejection surfaces WX_LOGIN_FAILED, not opaque INTERNAL', async t => {
  const f = await fixture(t);
  const admin = await f.login('owner', 'fixture-admin-password');
  const created = await f.api(admin, 'activity-create', { config: f.activityConfig(), state: 'active' });
  const id = created.body.data.activity.id;
  // Same shape defaultCode2session throws when WeChat rejects the js_code (502 problem).
  const reject = async () => { const e = new Error('微信登录失败，请返回小程序重新进入'); e.code = 'WX_LOGIN_FAILED'; e.status = 502; throw e; };
  const store = createActivityStore({ pool: f.pool, ns: f.ns, couponStore: f.couponStore, ...f.protector, code2session: reject });
  const inner = createActivityHttp({ store });
  const server = http.createServer((req, res) => {
    const m = /^\/activity\/([0-9a-f-]{36})(\/.*)$/.exec(req.url || '');
    if (!m) { res.statusCode = 404; return res.end('{}'); }
    return inner(req, res, m[1], m[2], '127.0.0.1');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/activity/${id}/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'bad-code' }) });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'WX_LOGIN_FAILED');
  assert.match(body.error, /微信登录失败/);
});
