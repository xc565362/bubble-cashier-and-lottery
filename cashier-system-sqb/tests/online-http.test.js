import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createOnlineHandler } = require('../online/http.cjs');
const { createAuthStore } = require('../online/auth.cjs');

async function fixture(t, { leaseDenied = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-online-http-'));
  const auth = createAuthStore({ file: path.join(dir, 'accounts.sqlite') });
  const admin = await auth.createInitialAdmin({ username: 'owner', password: 'fixture-admin-password', displayName: '测试管理员' });
  const staff = await auth.createUser({ username: 'staff', password: 'fixture-staff-password', displayName: '测试收银员', role: 'cashier' }, admin);
  fs.mkdirSync(path.join(dir, 'dist')); fs.writeFileSync(path.join(dir, 'dist/index.html'), '<h1>Login</h1>');
  fs.writeFileSync(path.join(dir, 'outside.json'), '{"private":true}');
  const calls = [], actorCalls = [];
  const service = { dispatch: async (action, payload) => { calls.push({ action, payload }); return action === 'config' ? { ready: false, directory: dir } : { accepted: action }; }, notification: async raw => { calls.push({ raw }); return '{"signed":true}'; } };
  const ledger = { snapshot: actor => { actorCalls.push(actor); return { revision: 0, ledger: { products: [], orders: [], heldCarts: [] } }; },
    assertLease: () => { throw Object.assign(new Error('请先取得收银使用权'), { code: 'LEASE_REQUIRED', status: 409 }); },
    command: async (_, actor) => { actorCalls.push(actor); return { revision: 1 }; },
    paymentDispatch: async (action, payload, actor) => { actorCalls.push(actor); if (leaseDenied) throw Object.assign(new Error('请先取得收银使用权'), { code: 'LEASE_REQUIRED', status: 409 }); return { authoritative: true, action }; } };
  let handler;
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  handler = createOnlineHandler({ auth, ledger, service, publicOrigin: origin, staticRoot: path.join(dir, 'dist'), allowHttpLocal: true });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); auth.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const terminal = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  async function login(username = 'owner', password = 'fixture-admin-password') {
    const res = await fetch(origin + '/api/online/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(res.status, 200); const data = await res.json();
    return { data, cookie: res.headers.get('set-cookie').split(';')[0], header: res.headers.get('set-cookie') };
  }
  async function request(route, options = {}) {
    const { session, method = 'GET', body, csrf = true, requestOrigin = origin, terminalId = terminal } = options;
    const res = await fetch(origin + route, { method, headers: { ...(requestOrigin ? { Origin: requestOrigin } : {}), 'X-Terminal-Id': terminalId,
      ...(session ? { Cookie: session.cookie } : {}), ...(session && csrf ? { 'X-CSRF-Token': session.data.csrfToken } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, headers: res.headers, text: await res.text() };
  }
  return { origin, auth, admin, staff, calls, actorCalls, login, request, terminal };
}

test('online API fails closed without login and denies cross-origin and missing CSRF', async t => {
  const f = await fixture(t);
  for (const route of ['/api/online/ledger', '/api/online/users', '/api/sqb/save-config']) assert.equal((await f.request(route, { method: route.includes('sqb') ? 'POST' : 'GET', body: route.includes('sqb') ? {} : undefined })).status, 401);
  const session = await f.login();
  assert.match(session.header, /HttpOnly/); assert.match(session.header, /SameSite=Strict/); assert.ok(!session.cookie.includes(session.data.csrfToken));
  assert.equal((await f.request('/api/online/command', { session, method: 'POST', body: {}, csrf: false })).status, 403);
  assert.equal((await f.request('/api/online/command', { session, method: 'POST', body: {}, requestOrigin: 'https://untrusted.example' })).status, 403);
  assert.equal((await f.request('/api/online/ledger', { session, requestOrigin: 'https://untrusted.example' })).status, 403);
  assert.equal(f.calls.length, 0); assert.equal(f.actorCalls.length, 0);
});

test('staff cannot invoke administrative or arbitrary payment actions; financial calls go through ledger', async t => {
  const f = await fixture(t), session = await f.login('staff', 'fixture-staff-password');
  for (const action of ['save-config', 'export-credentials', 'coupon-create-key', 'lottery-update', 'scarf-update', 'coupon-bind-physical-products']) {
    assert.equal((await f.request('/api/sqb/' + action, { session, method: 'POST', body: {} })).status, 403, action);
  }
  assert.equal((await f.request('/api/sqb/prepare-restore', { session, method: 'POST', body: {} })).status, 404);
  const paid = await f.request('/api/sqb/start', { session, method: 'POST', body: { draft: { total: 0 } } });
  assert.equal(JSON.parse(paid.text).data.authoritative, true); assert.equal(f.calls.length, 0);
  const config = await f.request('/api/sqb/config', { session, method: 'POST', body: {} }); assert.equal(JSON.parse(config.text).data.directory, undefined);
});

test('draw and voucher reads work without the checkout lease while financial recovery stays locked', async t => {
  const f = await fixture(t, { leaseDenied: true }), session = await f.login();
  for (const action of ['lottery-records', 'scarf-records', 'coupon-campaigns', 'coupon-coupons', 'coupon-pending']) {
    const read = await f.request('/api/sqb/' + action, { session, method: 'POST', body: {} });
    assert.equal(read.status, 200, action); assert.equal(JSON.parse(read.text).data.accepted, action);
    assert.equal((await f.request('/api/sqb/' + action, { session, method: 'POST', body: {}, csrf: false })).status, 403, action);
    assert.equal((await f.request('/api/sqb/' + action, { session, method: 'POST', body: {}, requestOrigin: 'https://untrusted.example' })).status, 403, action);
    assert.equal((await f.request('/api/sqb/' + action, { method: 'POST', body: {} })).status, 401, action);
  }
  assert.equal(f.actorCalls.length, 0, 'read actions cannot acquire or mutate the financial ledger');
  for (const action of ['coupon-sync', 'coupon-release', 'coupon-zero', 'coupon-reserve']) {
    const mutate = await f.request('/api/sqb/' + action, { session, method: 'POST', body: {} });
    assert.equal(mutate.status, 409, action); assert.equal(JSON.parse(mutate.text).code, 'LEASE_REQUIRED');
  }
  const staff = await f.login('staff', 'fixture-staff-password');
  assert.equal((await f.request('/api/sqb/coupon-pending', { session: staff, method: 'POST', body: {} })).status, 200);
  for (const action of ['lottery-records', 'scarf-records', 'coupon-coupons']) {
    assert.equal((await f.request('/api/sqb/' + action, { session: staff, method: 'POST', body: {} })).status, 403);
  }
});

test('terminal ownership distinguishes tabs and single-field account PATCH works', async t => {
  const f = await fixture(t), session = await f.login();
  await f.request('/api/online/ledger', { session });
  await f.request('/api/online/ledger', { session, terminalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
  assert.notEqual(f.actorCalls[0].sessionId, f.actorCalls[1].sessionId);
  const updated = await f.request(`/api/online/users/${f.staff.id}`, { session, method: 'PATCH', body: { disabled: true } });
  assert.equal(updated.status, 200); assert.equal(JSON.parse(updated.text).user.disabled, true);
  const blocked = await f.request('/api/sqb/save-config', { session, method: 'POST', body: {} }); assert.equal(blocked.status, 409);
});

test('logout invalidates server session and responses are not cached', async t => {
  const f = await fixture(t), session = await f.login();
  const before = await f.request('/api/online/session', { session }); assert.equal(before.status, 200); assert.equal(before.headers.get('cache-control'), 'no-store');
  assert.equal((await f.request('/api/online/logout', { session, method: 'POST', body: {} })).status, 200);
  assert.equal((await f.request('/api/online/ledger', { session })).status, 401);
});

test('notification forwards exact signed bytes without session; static cannot expose server files', async t => {
  const f = await fixture(t), raw = '{ "body" : {"a": 1}, "signature": "fixture" }';
  const res = await fetch(f.origin + '/api/sqb/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw });
  assert.equal(res.status, 200); assert.equal(f.calls[0].raw, raw);
  assert.equal((await f.request('/online/auth.cjs')).status, 404);
  assert.equal((await f.request('/.env')).status, 404);
});

test('production origin must be HTTPS and sets secure host-only cookie', async t => {
  const f = await fixture(t);
  assert.throws(() => createOnlineHandler({ auth: f.auth, publicOrigin: 'http://example.com' }), /HTTPS/);
  const handler = createOnlineHandler({ auth: f.auth, ledger: {}, service: {}, publicOrigin: 'https://cashier.example.com' });
  const session = await f.auth.authenticate('owner', 'fixture-admin-password', { ip: 'test' });
  const req = Object.assign((async function* () { yield Buffer.from(JSON.stringify({ username: 'owner', password: 'fixture-admin-password' })); })(), {
    method: 'POST', url: '/api/online/login', headers: { host: 'cashier.example.com', origin: 'https://cashier.example.com', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' },
  });
  const headers = {}; const res = { setHeader: (key, value) => { headers[key] = value; }, end: () => {} };
  await handler(req, res);
  assert.match(headers['Set-Cookie'], /^__Host-bubble-online=/); assert.match(headers['Set-Cookie'], /; Secure$/); assert.ok(!headers['Set-Cookie'].includes('Domain='));
});
