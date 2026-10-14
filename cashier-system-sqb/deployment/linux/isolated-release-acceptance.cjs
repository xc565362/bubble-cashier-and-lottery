'use strict';
// Executes installed release code against disposable data only. Never source a live env file.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');

async function acceptance(release) {
  release = fs.realpathSync(release);
  const manifest = require(path.join(release, 'update-linux.cjs')).verifyManifest(release);
  const temporaryParent = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryParent, 'bubble-isolated-acceptance-'));
  fs.chmodSync(directory, 0o700);
  const checks = [], couponDirectory = path.join(directory, 'coupon-only');
  const adminToken = crypto.randomBytes(32).toString('hex');
  let child = null, couponOrigin = null, online = null;
  let externalRequests = 0;
  const pass = name => checks.push(name);

  async function stopCoupon() {
    if (!child) return;
    const current = child; child = null;
    if (current.exitCode !== null || current.signalCode !== null) return;
    const exited = once(current, 'exit');
    current.kill('SIGTERM');
    const deadline = setTimeout(() => current.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(deadline); }
  }
  async function startCoupon() {
    // Absolute Node path and deliberately minimal environment: no inherited application config.
    const environment = { HOST: '127.0.0.1', PORT: '0', COUPON_ENV: 'development',
      COUPON_DATA_DIR: couponDirectory, COUPON_ADMIN_TOKEN: adminToken,
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) };
    child = spawn(process.execPath, [path.join(release, 'coupons/server.cjs')], {
      env: environment, cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    child.stderr.resume(); // No runtime/environment output is copied into the report.
    const instance = child;
    couponOrigin = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Isolated coupon process did not start')), 10000);
      const done = (error, value) => { clearTimeout(timer); instance.stdout.removeListener('data', onData); error ? reject(error) : resolve(value); };
      const onData = chunk => {
        output = (output + chunk.toString()).slice(-2000);
        const match = /Coupon API development; port (\d+);/.exec(output);
        if (match) done(null, `http://127.0.0.1:${Number(match[1])}`);
      };
      instance.stdout.on('data', onData);
      instance.once('error', () => done(new Error('Isolated coupon process failed to start')));
      instance.once('exit', () => done(new Error('Isolated coupon process exited before startup')));
    });
    assert.equal((await fetch(couponOrigin + '/healthz', { signal: AbortSignal.timeout(5000) })).status, 200);
  }
  async function coupon(route, body, { token = adminToken, status = 200, origin } = {}) {
    const response = await fetch(couponOrigin + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000), redirect: 'error' });
    const result = await response.json();
    assert.equal(response.status, status, `Unexpected HTTP status for ${route} (${result.code || 'no-error-code'})`);
    assert.equal(result.ok, status === 200, `Unexpected response for ${route}`);
    return status === 200 ? result.data : result;
  }
  try {
    await startCoupon();
    await coupon('/v1/info', undefined, { token: null, status: 401 });
    await coupon('/v1/info', undefined, { origin: 'https://untrusted.invalid', status: 403 });
    const info = await coupon('/v1/info');
    assert.equal(info.environment, 'development'); assert.ok(info.capabilities.includes('lottery-record-status-v1'));
    pass('actual_coupon_process_health_auth_origin_and_records_capability');
    const now = Date.now();
    const campaign = await coupon('/v1/campaigns', { requestId: 'isolated-campaign', name: 'Disposable acceptance headscarf', kind: 'physical',
      physical: { prizeId: 'scarf', quantity: 1, product: { id: 'isolated-scarf', name: 'Disposable headscarf', sku: 'ISOLATED-SCARF', barcode: 'ISOLATED-SCARF' } }, amountCents: 0, minimumCents: 0, quota: 1,
      startsAt: new Date(now - 60000).toISOString(), expiresAt: new Date(now + 3600000).toISOString() });
    const lotteryKey = await coupon('/v1/keys', { requestId: 'isolated-lottery-key', name: 'Disposable lottery', role: 'lottery', campaignId: campaign.id });
    const cashierKey = await coupon('/v1/keys', { requestId: 'isolated-cashier-key', name: 'Disposable cashier', role: 'cashier' });
    const issue = { requestId: 'isolated-issue', campaignId: campaign.id, owner: 'isolated-owner', awardId: 'isolated-award', trustedCode: 'ABCDEF0123456789' };
    const award = await coupon('/v1/coupons/issue', issue, { token: lotteryKey.token });
    const repeated = await coupon('/v1/coupons/issue', { ...issue, requestId: 'isolated-issue-retry' }, { token: lotteryKey.token });
    assert.equal(repeated.id, award.id);
    pass('real_http_scoped_issuance_idempotent_by_award');
    const statusInput = { centerId: info.centerId, environment: 'development', refs: [{ recordId: crypto.createHash('sha256').update('isolated-draw-reference').digest('hex'),
      campaignId: campaign.id, owner: issue.owner, awardId: issue.awardId, couponId: award.id }] };
    const readStatus = () => coupon('/v1/lottery/records/status', statusInput);
    const before = await readStatus(); assert.equal(before.items[0].state, 'AVAILABLE');
    assert.equal(before.items[0].result, 'verified');
    assert.ok(!JSON.stringify(before).includes(award.code)); assert.ok(!JSON.stringify(before).includes(issue.owner));
    pass('real_http_authoritative_status_is_sanitized');
    const held = await coupon('/v1/reservations', { requestId: 'isolated-reserve', code: award.code, checkoutId: 'isolated-checkout', eligibleCents: 0 }, { token: cashierKey.token });
    assert.equal((await readStatus()).items[0].state, 'RESERVED');
    await coupon('/v1/reservations/prepare', { requestId: 'isolated-prepare', id: held.reservation.id,
      orderId: 'isolated-order', orderNo: 'ISOLATED-ONLY', eligibleCents: 0, paidCents: 0 }, { token: cashierKey.token });
    assert.equal((await readStatus()).items[0].state, 'PAYMENT_PENDING');
    const commit = { requestId: 'isolated-commit', id: held.reservation.id, orderId: 'isolated-order', paidCents: 0, paymentReference: 'ZERO:isolated-order' };
    assert.equal((await coupon('/v1/reservations/commit', commit, { token: cashierKey.token })).state, 'REDEEMED');
    const redeemed = await readStatus(); assert.equal(redeemed.items[0].state, 'REDEEMED'); assert.ok(redeemed.items[0].redeemedAt > 0);
    pass('real_http_reserve_prepare_zero_redemption_and_status_transition');
    const database = new DatabaseSync(path.join(couponDirectory, 'coupons.sqlite'), { readOnly: true });
    try {
      const saved = JSON.parse(database.prepare('SELECT data FROM coupons WHERE id=?').get(award.id).data);
      assert.equal(saved.state, 'REDEEMED'); assert.equal(database.prepare('SELECT count(*) n FROM coupons').get().n, 1);
    } finally { database.close(); }
    pass('independent_readonly_sqlite_connection_reads_committed_redemption');
    await stopCoupon(); await startCoupon();
    assert.equal((await coupon('/v1/info')).centerId, info.centerId);
    assert.deepEqual((await readStatus()).items, redeemed.items);
    assert.equal((await coupon('/v1/reservations/commit', commit, { token: cashierKey.token })).state, 'REDEEMED');
    const duplicate = await coupon('/v1/reservations', { requestId: 'isolated-second-redemption', code: award.code,
      checkoutId: 'isolated-second-checkout', eligibleCents: 0 }, { token: cashierKey.token, status: 409 });
    assert.equal(duplicate.code, 'NOT_AVAILABLE');
    assert.equal((await coupon('/v1/campaigns'))[0].issued, 1);
    pass('second_process_keeps_identity_redemption_and_prevents_duplicate_use');

    const onlineDirectory = path.join(directory, 'online-only'); fs.mkdirSync(onlineDirectory, { mode: 0o700 });
    const auth = require(path.join(release, 'online/auth.cjs')).createAuthStore({ file: path.join(onlineDirectory, 'accounts.sqlite') });
    const password = crypto.randomBytes(24).toString('hex');
    try { await auth.createInitialAdmin({ username: 'isolated-owner', password, displayName: 'Disposable acceptance owner' }); } finally { auth.close(); }
    const portProbe = net.createServer(); await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
    const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    online = require(path.join(release, 'online/server.cjs')).startOnlineServer({ directory: onlineDirectory,
      keyFile: path.join(onlineDirectory, 'temporary.key'), setupFile: '', publicOrigin: origin,
      port, host: '127.0.0.1', allowHttpLocal: true, staticRoot: path.join(release, 'dist'),
      fetchFn: () => { externalRequests++; throw new Error('Outbound network prohibited in isolated acceptance'); } });
    if (!online.server.listening) await once(online.server, 'listening');
    const request = (route, options = {}) => fetch(origin + route, { ...options, signal: AbortSignal.timeout(5000), redirect: 'error',
      headers: { Origin: origin, 'X-Terminal-Id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ...options.headers } });
    assert.equal((await request('/healthz')).status, 200);
    assert.equal((await request('/api/online/ledger')).status, 401);
    const html = await (await request('/cashier/')).text();
    const script = /src="(\/cashier\/assets\/[^" ]+\.js)"/.exec(html); assert.ok(script);
    assert.equal((await request(script[1])).status, 200);
    const login = await request('/api/online/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'isolated-owner', password }) });
    assert.equal(login.status, 200); const session = await login.json();
    const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' };
    assert.equal((await request('/api/online/ledger', { headers })).status, 200);
    const pending = await request('/api/sqb/coupon-pending', { method: 'POST', headers, body: '{}' });
    assert.equal(pending.status, 200); assert.deepEqual((await pending.json()).data, []);
    const sync = await request('/api/sqb/coupon-sync', { method: 'POST', headers, body: '{}' });
    assert.equal(sync.status, 409); assert.equal((await sync.json()).code, 'LEASE_REQUIRED');
    assert.equal(externalRequests, 0);
    pass('installed_online_runtime_assets_login_readonly_and_lease_enforcement');
    return { ok: true, releaseId: manifest.id, scope: 'installed-code-disposable-localhost-integration',
      checks, couponEnvironment: 'development', externalRequests, realPaymentRequests: 0,
      productionDataRead: false, productionDataWritten: false, realDrawsExecuted: false,
      limitations: ['Won/lost draw history requires separate CloudBase isolated QA.', 'This run does not verify the production coupon database, public routing, or WeChat device login.'] };
  } finally {
    await online?.close(); await stopCoupon();
    const resolved = fs.realpathSync(directory);
    if (path.dirname(resolved) !== temporaryParent || !path.basename(resolved).startsWith('bubble-isolated-acceptance-')) throw new Error('Temporary cleanup path mismatch');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--release' || !path.isAbsolute(args[1])) throw new Error('Usage: node isolated-release-acceptance.cjs --release /absolute/versioned/release');
  acceptance(args[1]).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
    console.error(JSON.stringify({ ok: false, error: error.message, code: error.code || null })); process.exitCode = 1;
  });
}
module.exports = { acceptance };
