import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createApp } from '../server.mjs';
import { hashToken } from '../src/auth.js';
import { validateCouponCenterUrl, loadCouponBridgeConfig, createCouponIssuer } from '../src/coupons.js';

// Coupon-bridge tests. App-level cases run against the real MySQL from
// .env.local with randomized campaign ids (rows removed on teardown) and an
// in-process stub coupon center over loopback HTTP.
const STAFF_KEY = 'test-staff-key';

const silent = () => {};

test('coupon center URL requires https unless loopback', () => {
  assert.equal(validateCouponCenterUrl('https://coupons.example.com'), 'https://coupons.example.com');
  assert.equal(validateCouponCenterUrl('https://coupons.example.com/ignored-path'), 'https://coupons.example.com');
  assert.equal(validateCouponCenterUrl('http://127.0.0.1:3910'), 'http://127.0.0.1:3910');
  assert.equal(validateCouponCenterUrl('http://localhost:3910/'), 'http://localhost:3910');
  assert.throws(() => validateCouponCenterUrl('http://coupons.example.com'), /HTTPS/);
  assert.throws(() => validateCouponCenterUrl('https://user:pass@coupons.example.com'), /账号/);
  assert.throws(() => validateCouponCenterUrl('not a url'), /URL/);
});

test('bridge config: absent by default, env trio wins, bridge file carries per-prize grants', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.coupon-bridge.json');
  const logs = [];
  const log = message => logs.push(message);

  assert.equal(loadCouponBridgeConfig({ env: {}, file, campaignId: 'camp-1', log }), null);
  assert.equal(loadCouponBridgeConfig({ env: { COUPON_CENTER_URL: 'https://c.example.com' }, file, campaignId: 'camp-1', log }), null);
  assert.match(logs.at(-1), /必须同时设置/);

  const envConfig = loadCouponBridgeConfig({
    env: { COUPON_CENTER_URL: 'https://c.example.com', COUPON_LOTTERY_KEY: 'k', COUPON_CAMPAIGN_ID: 'cc-1' },
    file, campaignId: 'camp-1', log,
  });
  assert.deepEqual(envConfig, { url: 'https://c.example.com', grants: [{ prizeId: null, campaignId: 'cc-1', token: 'k' }] });
  assert.equal(loadCouponBridgeConfig({
    env: { COUPON_BRIDGE: 'off', COUPON_CENTER_URL: 'https://c.example.com', COUPON_LOTTERY_KEY: 'k', COUPON_CAMPAIGN_ID: 'cc-1' },
    file, campaignId: 'camp-1', log,
  }), null);

  const insecure = loadCouponBridgeConfig({
    env: { COUPON_CENTER_URL: 'http://c.example.com', COUPON_LOTTERY_KEY: 'k', COUPON_CAMPAIGN_ID: 'cc-1' },
    file, campaignId: 'camp-1', log,
  });
  assert.equal(insecure, null);

  fs.writeFileSync(file, JSON.stringify({
    version: 1, url: 'https://c.example.com', lotteryCampaignId: 'camp-1',
    grants: { cash5: { campaignId: 'cc-5', keyId: 'key-5', token: 't5' } },
  }));
  const fileConfig = loadCouponBridgeConfig({ env: {}, file, campaignId: 'camp-1', log });
  assert.deepEqual(fileConfig.grants, [{ prizeId: 'cash5', campaignId: 'cc-5', token: 't5' }]);

  assert.equal(loadCouponBridgeConfig({ env: {}, file, campaignId: 'other-campaign', log }), null);
  assert.match(logs.at(-1), /不符/);
  assert.ok(!logs.join('\n').includes('t5'), 'logs must never contain tokens');

  fs.writeFileSync(file, '{broken');
  assert.equal(loadCouponBridgeConfig({ env: {}, file, campaignId: 'camp-1', log }), null);
});

test('issuer: verifies the grant against the center and pins the entry code', async () => {
  const requests = [];
  const issuer = createCouponIssuer({
    url: 'http://127.0.0.1:3910',
    grants: [{ prizeId: 'cash5', campaignId: 'cc-5', token: 'lottery-token' }],
    log: silent,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/v1/campaigns')) {
        return Response.json({ ok: true, data: [{ id: 'cc-5', kind: 'cash', amountCents: 500, minimumCents: 200 }] });
      }
      const input = JSON.parse(options.body);
      return Response.json({ ok: true, data: { id: 'coupon-1', code: input.trustedCode, amountCents: 500, state: 'AVAILABLE' } });
    },
  });
  const prize = { id: 'cash5', kind: 'cash', amount: 5, minimumCents: 200 };
  const result = await issuer.issueEntry({ prize, owner: 'openid-1', code: '0123456789ABCDEF' });
  assert.equal(result.ok, true);
  assert.equal(requests[0].url, 'http://127.0.0.1:3910/v1/campaigns');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer lottery-token');
  const issue = requests[1];
  assert.equal(issue.url, 'http://127.0.0.1:3910/v1/coupons/issue');
  const body = JSON.parse(issue.options.body);
  assert.equal(body.campaignId, 'cc-5');
  assert.equal(body.owner, 'openid-1');
  assert.equal(body.awardId, '0123456789ABCDEF');
  assert.equal(body.trustedCode, '0123456789ABCDEF');
  assert.match(body.requestId, /^award:[0-9a-f]{64}$/);
  assert.equal(issuer.pendingCount(), 0);

  // Deterministic requestId: a retry carries the identical idempotency key.
  await issuer.issueEntry({ prize, owner: 'openid-1', code: '0123456789ABCDEF' });
  const retried = JSON.parse(requests.at(-1).options.body);
  assert.equal(retried.requestId, body.requestId);
});

test('issuer: face-value mismatch blocks issuance, failures are tracked and recover', async () => {
  let behavior = 'mismatch';
  const issueCalls = [];
  const issuer = createCouponIssuer({
    url: 'http://127.0.0.1:3910',
    grants: [{ prizeId: null, campaignId: 'cc-1', token: 't' }],
    log: silent,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/v1/campaigns')) {
        return Response.json({ ok: true, data: [{ id: 'cc-1', kind: 'cash', amountCents: behavior === 'mismatch' ? 999 : 500, minimumCents: 0 }] });
      }
      issueCalls.push(JSON.parse(options.body));
      if (behavior === 'down') throw new TypeError('fetch failed');
      if (behavior === 'wrong-code') return Response.json({ ok: true, data: { id: 'c', code: 'FEDCBA9876543210' } });
      return Response.json({ ok: true, data: { id: 'c', code: '0123456789ABCDEF' } });
    },
  });
  const prize = { id: 'cash5', kind: 'cash', amount: 5 };

  // The center campaign holds a different face value: never issue into it.
  const mismatch = await issuer.issueEntry({ prize, owner: 'o', code: '0123456789ABCDEF' });
  assert.equal(mismatch.ok, false);
  assert.equal(issueCalls.length, 0);
  assert.equal(issuer.isFailed('0123456789ABCDEF'), true);

  // Network failure after a good verification: entry kept, pending counted.
  behavior = 'down';
  const issuer2 = createCouponIssuer({
    url: 'http://127.0.0.1:3910', grants: [{ prizeId: null, campaignId: 'cc-1', token: 't' }], log: silent,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/v1/campaigns')) return Response.json({ ok: true, data: [{ id: 'cc-1', kind: 'cash', amountCents: 500, minimumCents: 0 }] });
      issueCalls.push(JSON.parse(options.body));
      if (behavior === 'down') throw new TypeError('fetch failed');
      return Response.json({ ok: true, data: { id: 'c', code: JSON.parse(options.body).trustedCode } });
    },
  });
  assert.equal((await issuer2.issueEntry({ prize, owner: 'o', code: 'AAAAAAAAAAAAAAAA' })).ok, false);
  assert.equal(issuer2.pendingCount(), 1);
  behavior = 'up';
  assert.equal((await issuer2.issueEntry({ prize, owner: 'o', code: 'AAAAAAAAAAAAAAAA' })).ok, true);
  assert.equal(issuer2.pendingCount(), 0);

  // A center that returns a different code than pinned is treated as failure.
  behavior = 'wrong-code';
  const issuer3 = createCouponIssuer({
    url: 'http://127.0.0.1:3910', grants: [{ prizeId: null, campaignId: 'cc-1', token: 't' }], log: silent,
    fetchImpl: async url => url.endsWith('/v1/campaigns')
      ? Response.json({ ok: true, data: [{ id: 'cc-1', kind: 'cash', amountCents: 500, minimumCents: 0 }] })
      : Response.json({ ok: true, data: { id: 'c', code: 'FEDCBA9876543210' } }),
  });
  assert.equal((await issuer3.issueEntry({ prize, owner: 'o', code: 'BBBBBBBBBBBBBBBB' })).ok, false);
  assert.equal(issuer3.isFailed('BBBBBBBBBBBBBBBB'), true);
});

// ---------- app-level integration with an in-process stub coupon center ----------

async function stubCenter(t, { token = 'test-lottery-key', campaignId = 'stub-campaign', amountCents = 500, minimumCents = 0 } = {}) {
  const coupons = new Map();
  const issueCalls = [];
  const state = { failNext: 0 };
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { ok: false, code: 'UNAUTHORIZED', error: '凭证无效' });
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/v1/campaigns') {
      return send(200, { ok: true, data: [{ id: campaignId, kind: 'cash', name: '5元立减金', amountCents, minimumCents, quota: 100, issued: coupons.size, enabled: true, startsAt: '2026-01-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z' }] });
    }
    if (req.method === 'POST' && url.pathname === '/v1/coupons/issue') {
      const input = JSON.parse(await new Promise(resolve => { let s = ''; req.on('data', c => s += c); req.on('end', () => resolve(s)); }));
      issueCalls.push(input);
      if (state.failNext > 0) { state.failNext--; return send(500, { ok: false, code: 'INJECTED', error: '注入的发券失败' }); }
      if (coupons.has(input.awardId)) return send(200, { ok: true, data: coupons.get(input.awardId) });
      const coupon = {
        id: 'coupon-' + (coupons.size + 1), campaignId: input.campaignId, kind: 'cash', amountCents, minimumCents,
        owner: input.owner, issuer: 'campaign:' + input.campaignId, awardId: input.awardId,
        state: 'AVAILABLE', code: input.trustedCode, environment: 'production', reservation: null,
      };
      coupons.set(input.awardId, coupon);
      return send(200, { ok: true, data: coupon });
    }
    return send(404, { ok: false, code: 'NOT_FOUND', error: '接口不存在' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, coupons, issueCalls, state, campaignId, token };
}

function couponConfig(id, overrides = {}) {
  return {
    id, name: '券联动测试', active: true,
    startsAt: '2026-01-01T00:00:00+08:00', endsAt: '2027-01-01T00:00:00+08:00',
    redeemEndsAt: '2027-01-01T00:00:00+08:00',
    ...overrides,
  };
}

async function startApp(t, config, couponEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lottery-coupon-test-'));
  const configPath = path.join(dir, 'campaign.config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const app = await createApp({
    configPath,
    bridgeFile: path.join(dir, 'no-bridge.json'),
    env: { ...process.env, STAFF_KEY, WX_MOCK: '1', COUPON_CENTER_URL: '', COUPON_LOTTERY_KEY: '', COUPON_CAMPAIGN_ID: '', ...couponEnv },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const sessionHashes = [];
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    await app.pool.query('DELETE FROM hd_entries WHERE campaign_id = ?', [config.id]);
    await app.pool.query('DELETE FROM hd_prizes WHERE campaign_id = ?', [config.id]);
    await app.pool.query('DELETE FROM hd_campaigns WHERE id = ?', [config.id]);
    if (sessionHashes.length) {
      await app.pool.query(`DELETE FROM hd_sessions WHERE token_hash IN (${sessionHashes.map(() => '?').join(',')})`, sessionHashes);
    }
    await app.pool.end();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { ...app, base, sessionHashes };
}

async function login(ctx, code) {
  const res = await fetch(ctx.base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  const body = await res.json();
  if (body?.data?.token) ctx.sessionHashes.push(hashToken(body.data.token));
  return body.data.token;
}

async function call(ctx, action, payload = {}, { token, staffKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (staffKey !== undefined) headers['X-Staff-Key'] = staffKey;
  const res = await fetch(ctx.base + '/api/call', { method: 'POST', headers, body: JSON.stringify({ action, payload }) });
  return { status: res.status, body: await res.json() };
}

test('cash win mints a coupon pinned to the entry code; booth redeem is refused', async t => {
  const stub = await stubCenter(t, { amountCents: 500, minimumCents: 200 });
  const campaignId = 'test-' + crypto.randomBytes(6).toString('hex');
  const ctx = await startApp(t, couponConfig(campaignId, {
    prizes: [{ id: 'cash5', name: '5元立减金', kind: 'cash', amount: 5, minimumCents: 200, qty: 3, probability: 1 }],
  }), { COUPON_CENTER_URL: stub.base, COUPON_LOTTERY_KEY: stub.token, COUPON_CAMPAIGN_ID: stub.campaignId });
  assert.equal(ctx.couponsEnabled, true);

  const token = await login(ctx, 'cash-winner');
  const drawn = await call(ctx, 'draw', {}, { token });
  assert.equal(drawn.body.ok, true);
  const entry = drawn.body.data;
  assert.equal(entry.prize.id, 'cash5');
  assert.equal(entry.checkoutCoupon, true);
  assert.equal(entry.status, 'pending');
  assert.equal(entry.minimumGoodsAmountCents, 200);
  assert.match(entry.code, /^[0-9A-F]{16}$/);

  // The stub center now holds a coupon whose code IS the entry code.
  assert.equal(stub.issueCalls.length, 1);
  assert.equal(stub.issueCalls[0].trustedCode, entry.code);
  assert.equal(stub.issueCalls[0].awardId, entry.code);
  assert.equal(stub.coupons.get(entry.code).amountCents, 500);
  assert.equal(stub.coupons.get(entry.code).minimumCents, 200);
  assert.match(stub.coupons.get(entry.code).owner, /^mock_[0-9a-f]{16}$/);

  // Repeat draw: same entry, no second issuance (no known failure).
  const again = await call(ctx, 'draw', {}, { token });
  assert.equal(again.body.data.code, entry.code);
  assert.equal(stub.issueCalls.length, 1);

  // Booth redemption of a checkout coupon is refused (it settles at the till).
  const redeem = await call(ctx, 'redeem', { code: entry.code }, { staffKey: STAFF_KEY });
  assert.equal(redeem.status, 409);
  assert.equal(redeem.body.code, 'CHECKOUT_COUPON');
});

test('physical prizes never reach the coupon center; disabled bridge keeps booth mode', async t => {
  const stub = await stubCenter(t);
  const campaignId = 'test-' + crypto.randomBytes(6).toString('hex');
  const ctx = await startApp(t, couponConfig(campaignId, {
    prizes: [{ id: 'cap', name: '棒球帽', kind: 'physical', qty: 2, probability: 1 }],
  }), { COUPON_CENTER_URL: stub.base, COUPON_LOTTERY_KEY: stub.token, COUPON_CAMPAIGN_ID: stub.campaignId });

  const token = await login(ctx, 'physical-winner');
  const drawn = await call(ctx, 'draw', {}, { token });
  assert.equal(drawn.body.data.prize.id, 'cap');
  assert.equal(drawn.body.data.checkoutCoupon, false);
  assert.equal(stub.issueCalls.length, 0);
  const redeem = await call(ctx, 'redeem', { code: drawn.body.data.code }, { staffKey: STAFF_KEY });
  assert.equal(redeem.body.ok, true);

  // No bridge at all: cash prizes stay booth-redeemed and the retry action
  // reports the bridge as disabled.
  const plainId = 'test-' + crypto.randomBytes(6).toString('hex');
  const plain = await startApp(t, couponConfig(plainId, {
    prizes: [{ id: 'cash5', name: '5元立减金', kind: 'cash', amount: 5, qty: 1, probability: 1 }],
  }));
  assert.equal(plain.couponsEnabled, false);
  const plainToken = await login(plain, 'plain-winner');
  const plainDraw = await call(plain, 'draw', {}, { token: plainToken });
  assert.equal(plainDraw.body.data.checkoutCoupon, false);
  assert.equal(plainDraw.body.data.minimumGoodsAmountCents, null);
  const retry = await call(plain, 'retry-coupon-issue', {}, { staffKey: STAFF_KEY });
  assert.equal(retry.body.data.enabled, false);
});

test('failed issuance never loses the draw; staff retry recovers it exactly once', async t => {
  const stub = await stubCenter(t);
  const campaignId = 'test-' + crypto.randomBytes(6).toString('hex');
  const ctx = await startApp(t, couponConfig(campaignId, {
    prizes: [{ id: 'cash5', name: '5元立减金', kind: 'cash', amount: 5, qty: 2, probability: 1 }],
  }), { COUPON_CENTER_URL: stub.base, COUPON_LOTTERY_KEY: stub.token, COUPON_CAMPAIGN_ID: stub.campaignId });

  stub.state.failNext = 1;
  const token = await login(ctx, 'unlucky-winner');
  const drawn = await call(ctx, 'draw', {}, { token });
  assert.equal(drawn.body.ok, true, 'draw succeeds even when issuance fails');
  assert.equal(drawn.body.data.status, 'issuing');
  assert.equal(drawn.body.data.checkoutCoupon, true);
  const code = drawn.body.data.code;
  assert.equal(stub.coupons.has(code), false);

  const records = await fetch(ctx.base + '/api/admin/records', { headers: { 'X-Staff-Key': STAFF_KEY } });
  assert.equal((await records.json()).data.summary.couponIssuesPending, 1);

  const denied = await call(ctx, 'retry-coupon-issue', {}, {});
  assert.equal(denied.status, 401);
  const retry = await call(ctx, 'retry-coupon-issue', {}, { staffKey: STAFF_KEY });
  assert.deepEqual(retry.body.data, { enabled: true, checked: 1, confirmed: 1, failed: 0, pending: 0 });
  assert.equal(stub.coupons.get(code).code, code);

  // The winner's next state poll shows a usable coupon; a second sweep changes nothing.
  const state = await call(ctx, 'state', {}, { token });
  assert.equal(state.body.data.entry.status, 'pending');
  const again = await call(ctx, 'retry-coupon-issue', {}, { staffKey: STAFF_KEY });
  assert.equal(again.body.data.confirmed, 1);
  assert.equal(stub.coupons.size, 1);
  const recordsAfter = await fetch(ctx.base + '/api/admin/records', { headers: { 'X-Staff-Key': STAFF_KEY } });
  assert.equal((await recordsAfter.json()).data.summary.couponIssuesPending, 0);
});
