'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const net = require('node:net');
const { verifyManifest } = require('./update-linux.cjs');
const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'cashier-release-state.json')));

test('packaged runtime starts isolated real online server, serves /cashier/ assets, authenticates admin and refuses reads without login', async t => {
  const manifest = verifyManifest(state.stage); assert.equal(manifest.id, state.id);
  assert.ok(!manifest.files.some(file => /(?:setup-grant|\.env|\.key|\.sqlite|\.pem)/.test(file.path)));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-release-smoke-'));
  const { createAuthStore } = require(path.join(state.stage, 'online/auth.cjs'));
  const { startOnlineServer } = require(path.join(state.stage, 'online/server.cjs'));
  const auth = createAuthStore({ file: path.join(directory, 'accounts.sqlite') });
  await auth.createInitialAdmin({ username: 'isolated-owner', password: 'isolated-test-password-only', displayName: '隔离验收管理员' }); auth.close();
  const portProbe = net.createServer(); await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
  const origin = `http://127.0.0.1:${port}`; let networkCalls = 0;
  const app = startOnlineServer({ directory, keyFile: path.join(directory, 'fixture.key'), publicOrigin: origin, port, host: '127.0.0.1', allowHttpLocal: true,
    fetchFn: () => { networkCalls++; throw new Error('External network prohibited'); } });
  await new Promise((resolve, reject) => { if (app.server.listening) resolve(); else app.server.once('listening', resolve); app.server.once('error', reject); });
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(route, options = {}) { return fetch(base + route, { ...options, headers: { Origin: origin, 'X-Terminal-Id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ...options.headers } }); }
  assert.equal((await request('/healthz')).status, 200);
  assert.equal((await request('/api/online/ledger')).status, 401);
  const htmlResponse = await request('/cashier/'); assert.equal(htmlResponse.status, 200); const html = await htmlResponse.text();
  const script = /src="(\/cashier\/assets\/[^"]+\.js)"/.exec(html); assert.ok(script);
  assert.equal((await request(script[1])).status, 200);
  const login = await request('/api/online/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'isolated-owner', password: 'isolated-test-password-only' }) });
  assert.equal(login.status, 200); const session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' };
  const ledger = await request('/api/online/ledger', { headers }); assert.equal(ledger.status, 200); assert.equal((await ledger.json()).ledger.orders.length, 0);
  const pending = await request('/api/sqb/coupon-pending', { method: 'POST', headers, body: '{}' }); assert.equal(pending.status, 200); assert.deepEqual((await pending.json()).data, []);
  const denied = await request('/api/sqb/coupon-sync', { method: 'POST', headers, body: '{}' }); assert.equal(denied.status, 409);
  assert.equal((await denied.json()).code, 'LEASE_REQUIRED'); assert.equal(networkCalls, 0);
});
