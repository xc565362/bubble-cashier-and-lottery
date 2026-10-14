import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../server.mjs';
import { hashToken } from '../src/auth.js';

// Runs against the real MySQL configured in .env.local (loaded by npm test via
// --env-file-if-exists). Each server instance uses a randomized campaign id and
// removes all of its rows (entries, prizes, campaign, sessions) on teardown.
const STAFF_KEY = 'test-staff-key';

function makeConfig(id, overrides = {}) {
  return {
    id, name: '测试活动', active: true,
    startsAt: '2026-01-01T00:00:00+08:00', endsAt: '2027-01-01T00:00:00+08:00',
    prizes: [
      { id: 'a', name: 'A奖', kind: 'cash', amount: 5, qty: 1, probability: 1 },
      { id: 'b', name: 'B奖', kind: 'physical', qty: 1, probability: 1 },
    ],
    ...overrides,
  };
}

async function startServer(configOverrides = {}, env = {}) {
  const campaignId = 'test-' + crypto.randomBytes(6).toString('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lottery-test-'));
  const configPath = path.join(dir, 'campaign.config.json');
  fs.writeFileSync(configPath, JSON.stringify(makeConfig(campaignId, configOverrides)));
  const app = await createApp({
    configPath,
    env: { ...process.env, STAFF_KEY, WX_MOCK: '1', ...env },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const sessionHashes = [];
  const close = async () => {
    await new Promise(resolve => app.server.close(resolve));
    await app.pool.query('DELETE FROM hd_entries WHERE campaign_id = ?', [campaignId]);
    await app.pool.query('DELETE FROM hd_prizes WHERE campaign_id = ?', [campaignId]);
    await app.pool.query('DELETE FROM hd_campaigns WHERE id = ?', [campaignId]);
    if (sessionHashes.length) {
      await app.pool.query(
        `DELETE FROM hd_sessions WHERE token_hash IN (${sessionHashes.map(() => '?').join(',')})`,
        sessionHashes);
    }
    await app.pool.end();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { base, campaignId, configPath, ...app, sessionHashes, close };
}

async function login(ctx, code) {
  const res = await fetch(ctx.base + '/api/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
  });
  const body = await res.json();
  if (body?.data?.token) ctx.sessionHashes.push(hashToken(body.data.token));
  return { status: res.status, body };
}

async function call(ctx, action, payload = {}, { token, staffKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (staffKey !== undefined) headers['X-Staff-Key'] = staffKey;
  const res = await fetch(ctx.base + '/api/call', {
    method: 'POST', headers, body: JSON.stringify({ action, payload }),
  });
  return { status: res.status, body: await res.json() };
}

async function drawAs(ctx, userCode) {
  const { body } = await login(ctx, userCode);
  const token = body.data.token;
  const result = await call(ctx, 'draw', {}, { token });
  return { token, ...result };
}

test('mock login issues a 24h session; state requires auth', async t => {
  const ctx = await startServer();
  t.after(ctx.close);
  const { status, body } = await login(ctx, 'alice-mock-code');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.match(body.data.token, /^[0-9a-f]{64}$/);
  assert.ok(body.data.expiresAt > Date.now() + 23 * 60 * 60 * 1000);
  assert.ok(body.data.expiresAt <= Date.now() + 24 * 60 * 60 * 1000);

  const state = await call(ctx, 'state', {}, { token: body.data.token });
  assert.equal(state.body.ok, true);
  assert.equal(state.body.data.entry, null);
  assert.equal(state.body.data.campaign.id, ctx.campaignId);
  assert.equal(state.body.data.inventory.total, 2);

  const anon = await call(ctx, 'state');
  assert.equal(anon.status, 401);
  assert.equal(anon.body.code, 'AUTH_REQUIRED');
});

test('mock login maps distinct codes to distinct users', async t => {
  const ctx = await startServer();
  t.after(ctx.close);
  const a = await login(ctx, 'user-code-one');
  const b = await login(ctx, 'user-code-two');
  const ia = await call(ctx, 'identity', {}, { token: a.body.data.token });
  const ib = await call(ctx, 'identity', {}, { token: b.body.data.token });
  assert.notEqual(ia.body.data.openId, ib.body.data.openId);
  assert.match(ia.body.data.openId, /^mock_[0-9a-f]{16}$/);
});

test('10 concurrent draws for one user return the same entry and decrement stock once', async t => {
  const ctx = await startServer();
  t.after(ctx.close);
  const { body } = await login(ctx, 'concurrent-user');
  const token = body.data.token;
  const results = await Promise.all(Array.from({ length: 10 }, () => call(ctx, 'draw', {}, { token })));
  for (const r of results) assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const codes = new Set(results.map(r => r.body.data.code));
  assert.equal(codes.size, 1);
  const [stock] = await ctx.pool.query(
    'SELECT SUM(qty_remaining) AS remaining FROM hd_prizes WHERE campaign_id = ?', [ctx.campaignId]);
  assert.equal(Number(stock[0].remaining), 1);
  const [entries] = await ctx.pool.query(
    'SELECT COUNT(*) AS n FROM hd_entries WHERE campaign_id = ?', [ctx.campaignId]);
  assert.equal(Number(entries[0].n), 1);
});

test('inventory exhaustion persists a no-prize outcome instead of re-rolling', async t => {
  const ctx = await startServer({ prizes: [{ id: 'a', name: 'A奖', kind: 'cash', amount: 5, qty: 1, probability: 1 }] });
  t.after(ctx.close);
  const first = await drawAs(ctx, 'winner-user');
  assert.equal(first.body.ok, true);
  assert.equal(first.body.data.prize.id, 'a');

  const second = await drawAs(ctx, 'late-user');
  assert.equal(second.body.ok, true);
  assert.equal(second.body.data.prize.id, 'none');
  assert.equal(second.body.data.status, 'unavailable');
  assert.equal(second.body.data.code, '');

  // Retry returns the persisted outcome, not a re-roll or an error.
  const retry = await call(ctx, 'draw', {}, { token: second.token });
  assert.equal(retry.body.data.prize.id, 'none');

  // The same user sees the outcome in state, others see a sold-out drawError.
  const state = await call(ctx, 'state', {}, { token: second.token });
  assert.equal(state.body.data.entry.prize.id, 'none');
  const third = await login(ctx, 'third-user');
  const thirdState = await call(ctx, 'state', {}, { token: third.body.data.token });
  assert.match(thirdState.body.data.drawError, /名额已发完/);
});

test('weighted draw never picks zero-stock prizes', async t => {
  const ctx = await startServer({
    prizes: [
      { id: 'gone', name: '已抢完', kind: 'physical', qty: 0, probability: 99 },
      { id: 'left', name: '还有货', kind: 'physical', qty: 10, probability: 1 },
    ],
  });
  t.after(ctx.close);
  for (let i = 0; i < 5; i++) {
    const r = await drawAs(ctx, 'stock-user-' + i);
    assert.equal(r.body.data.prize.id, 'left');
  }
});

test('redeem happy path, double redeem, unknown code, staff key required', async t => {
  const ctx = await startServer();
  t.after(ctx.close);
  const drawn = await drawAs(ctx, 'redeem-user');
  const code = drawn.body.data.code;
  assert.match(code, /^[0-9A-F]{16}$/);

  // No session and no staff key -> 401.
  const noCred = await call(ctx, 'redeem', { code });
  assert.equal(noCred.status, 401);
  // Session but not staff -> 403.
  const notStaff = await call(ctx, 'redeem', { code }, { token: drawn.token });
  assert.equal(notStaff.status, 403);
  assert.equal(notStaff.body.code, 'FORBIDDEN');
  // Staff key without any session -> works (cashier integration).
  const ok = await call(ctx, 'redeem', { code }, { staffKey: STAFF_KEY });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.status, 'redeemed');
  assert.ok(ok.body.data.redeemedAt > 0);
  // Double redeem -> ALREADY_REDEEMED.
  const twice = await call(ctx, 'redeem', { code }, { staffKey: STAFF_KEY });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.code, 'ALREADY_REDEEMED');
  // Unknown code -> 404 NOT_FOUND.
  const unknown = await call(ctx, 'redeem', { code: 'AAAAAAAAAAAAAAAA' }, { staffKey: STAFF_KEY });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, 'NOT_FOUND');
});

test('lookup is staff-only and masks the winner openid', async t => {
  const ctx = await startServer();
  t.after(ctx.close);
  const drawn = await drawAs(ctx, 'lookup-user');
  const code = drawn.body.data.code;

  const denied = await call(ctx, 'lookup', { code }, { token: drawn.token });
  assert.equal(denied.status, 403);
  const wrongKey = await call(ctx, 'lookup', { code }, { staffKey: 'wrong' });
  assert.equal(wrongKey.status, 403);

  const found = await call(ctx, 'lookup', { code }, { staffKey: STAFF_KEY });
  assert.equal(found.body.ok, true);
  assert.ok(found.body.data.winner.includes('…'));
  assert.ok(!/^mock_[0-9a-f]{16}$/.test(found.body.data.winner));
  assert.equal(found.body.data.status, 'pending');
});

test('identity reflects staff key header and STAFF_OPENIDS', async t => {
  const ctx = await startServer();
  t.after(ctx.close);
  const { body } = await login(ctx, 'identity-user');
  const plain = await call(ctx, 'identity', {}, { token: body.data.token });
  assert.equal(plain.body.data.isAdmin, false);
  const keyed = await call(ctx, 'identity', {}, { token: body.data.token, staffKey: STAFF_KEY });
  assert.equal(keyed.body.data.isAdmin, true);
});

test('admin records masks openids; CSV exports; key enforced', async t => {
  const ctx = await startServer();
  t.after(ctx.close);
  const drawn = await drawAs(ctx, 'admin-user');
  await call(ctx, 'redeem', { code: drawn.body.data.code }, { staffKey: STAFF_KEY });

  const missing = await fetch(ctx.base + '/api/admin/records');
  assert.equal(missing.status, 401);
  const wrong = await fetch(ctx.base + '/api/admin/records', { headers: { 'X-Staff-Key': 'nope' } });
  assert.equal(wrong.status, 403);

  const res = await fetch(ctx.base + '/api/admin/records', { headers: { 'X-Staff-Key': STAFF_KEY } });
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.summary.entries, 1);
  assert.equal(body.data.summary.redeemed, 1);
  assert.equal(body.data.summary.stockRemaining, 1);
  const record = body.data.records[0];
  assert.ok(record.openid.includes('…'));
  assert.ok(!/^mock_[0-9a-f]{16}$/.test(record.openid));
  assert.equal(record.status, 'redeemed');

  const csv = await fetch(ctx.base + '/api/admin/records.csv', { headers: { 'X-Staff-Key': STAFF_KEY } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const text = await csv.text();
  assert.match(text, /code,prize,status,openid/);
  assert.match(text, /redeemed/);
  assert.doesNotMatch(text, /mock_[0-9a-f]{16}/);
});

test('inactive campaign rejects draws and reports drawError in state', async t => {
  const ctx = await startServer({ active: false });
  t.after(ctx.close);
  const { body } = await login(ctx, 'paused-user');
  const token = body.data.token;
  const drawn = await call(ctx, 'draw', {}, { token });
  assert.equal(drawn.body.ok, false);
  assert.equal(drawn.body.code, 'PAUSED');
  const state = await call(ctx, 'state', {}, { token });
  assert.match(state.body.data.drawError, /暂未开放/);
});

test('draw rejects before startsAt and after endsAt', async t => {
  const future = await startServer({ startsAt: '2099-01-01T00:00:00+08:00', endsAt: '2099-12-31T00:00:00+08:00' });
  t.after(future.close);
  const u1 = await login(future, 'early-user');
  const r1 = await call(future, 'draw', {}, { token: u1.body.data.token });
  assert.equal(r1.body.code, 'NOT_STARTED');

  const past = await startServer({ startsAt: '2020-01-01T00:00:00+08:00', endsAt: '2020-12-31T00:00:00+08:00' });
  t.after(past.close);
  const u2 = await login(past, 'late-user-2');
  const r2 = await call(past, 'draw', {}, { token: u2.body.data.token });
  assert.equal(r2.body.code, 'ENDED');
});

test('state is read-only: repeated state calls never create an entry', async t => {
  const ctx = await startServer();
  t.after(ctx.close);
  const { body } = await login(ctx, 'readonly-user');
  for (let i = 0; i < 3; i++) await call(ctx, 'state', {}, { token: body.data.token });
  const [rows] = await ctx.pool.query(
    'SELECT COUNT(*) AS n FROM hd_entries WHERE campaign_id = ?', [ctx.campaignId]);
  assert.equal(Number(rows[0].n), 0);
});

test('admin config update validates, reloads and reconciles stock', async t => {
  const ctx = await startServer();
  t.after(ctx.close);
  await drawAs(ctx, 'config-user'); // uses 1 of 2 stock
  const post = await fetch(ctx.base + '/api/admin/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Staff-Key': STAFF_KEY },
    body: JSON.stringify({ prizes: [
      { id: 'a', name: 'A奖', kind: 'cash', amount: 5, qty: 10, probability: 1 },
      { id: 'b', name: 'B奖', kind: 'physical', qty: 5, probability: 1 },
    ] }),
  });
  const body = await post.json();
  assert.equal(body.ok, true);
  const login2 = await login(ctx, 'config-user-2');
  const state = await call(ctx, 'state', {}, { token: login2.body.data.token });
  assert.equal(state.body.data.inventory.total, 15);
  assert.equal(state.body.data.inventory.remaining, 14);

  const bad = await fetch(ctx.base + '/api/admin/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Staff-Key': STAFF_KEY },
    body: JSON.stringify({ active: 'yes' }),
  });
  assert.equal((await bad.json()).ok, false);
});

test('static index.html serves at / and unknown paths; /api 404s', async t => {
  const ctx = await startServer();
  t.after(ctx.close);
  const home = await fetch(ctx.base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /app\.mjs/);
  const spa = await fetch(ctx.base + '/some/route');
  assert.match(await spa.text(), /app\.mjs/);
  const api = await fetch(ctx.base + '/api/nope');
  assert.equal(api.status, 404);
});
