// Local E2E for the lottery server: user journey, error paths, static assets,
// and independent verification straight from MySQL.
// Run: node --env-file=.env.local scripts/e2e.mjs  (server must be running)
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const STAFF_KEY = process.env.STAFF_KEY;
const RUN = Date.now().toString(36);
const ALICE = 'e2e-alice-' + RUN;
const BOB = 'e2e-bob-' + RUN;

let passed = 0, failed = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label} ${extra}`); }
};

async function call(token, action, payload = {}, headers = {}) {
  const res = await fetch(BASE + '/api/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: JSON.stringify({ action, payload })
  });
  return { status: res.status, body: await res.json() };
}

async function login(code) {
  const res = await fetch(BASE + '/api/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code })
  });
  const body = await res.json();
  return { status: res.status, body, token: body?.data?.token };
}

// ---------- 1. static assets ----------
console.log('\n[1] Static assets');
for (const path of ['/', '/styles.css', '/app.mjs', '/core.mjs', '/api.mjs', '/catalog.mjs', '/qr.mjs', '/runtime-config.js', '/vendor/qrcode.js', '/vendor/jsbarcode.js']) {
  const res = await fetch(BASE + path);
  ok(res.status === 200, `GET ${path} → 200 (${res.headers.get('content-type')})`);
}
const spa = await fetch(BASE + '/prize'); // SPA fallback for non-/api path
ok(spa.status === 200 && (await spa.text()).includes('id="main"'), 'SPA fallback serves index.html');

// ---------- 2. auth ----------
console.log('\n[2] Auth');
const bad = await fetch(BASE + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
ok(bad.status >= 400, 'empty login body rejected');
const alice = await login(ALICE);
ok(alice.status === 200 && typeof alice.token === 'string', 'mock login alice → token');
const bob = await login(BOB);
ok(bob.status === 200 && bob.token !== alice.token, 'mock login bob → distinct token');
const noAuth = await call(null, 'state');
ok([401, 403].includes(noAuth.status), 'state without token rejected', `got ${noAuth.status}`);
const badToken = await call('deadbeef'.repeat(8), 'state');
ok([401, 403].includes(badToken.status), 'forged token rejected', `got ${badToken.status}`);

// ---------- 3. user journey ----------
console.log('\n[3] User journey (alice)');
let r = await call(alice.token, 'state');
ok(r.body.ok && r.body.data.entry == null, 'fresh user: entry is null');
ok(r.body.data.inventory?.remaining > 0, `inventory visible (remaining=${r.body.data.inventory?.remaining})`);
const prizes = r.body.data.campaign?.prizes || r.body.data.prizes || [];
ok(prizes.length === 8, `8 prizes on the board (got ${prizes.length})`);

r = await call(alice.token, 'draw');
ok(r.body.ok && r.body.data?.code, `draw → won "${r.body.data?.prize?.name}" code ${r.body.data?.code}`);
const aliceEntry = r.body.data;

const r2 = await call(alice.token, 'draw');
ok(JSON.stringify(r2.body.data) === JSON.stringify(aliceEntry), 'second draw idempotent (identical entry)');

r = await call(alice.token, 'state');
ok(r.body.data.entry?.code === aliceEntry.code, 'state after draw shows the entry');

// ---------- 4. staff flow ----------
console.log('\n[4] Staff / cashier flow');
r = await call(alice.token, 'lookup', { code: aliceEntry.code });
ok([401, 403].includes(r.status), 'lookup without staff key rejected', `got ${r.status}`);
r = await call(alice.token, 'lookup', { code: aliceEntry.code }, { 'X-Staff-Key': 'wrong-key' });
ok([401, 403].includes(r.status), 'lookup with wrong staff key rejected', `got ${r.status}`);
r = await call(null, 'lookup', { code: aliceEntry.code }, { 'X-Staff-Key': STAFF_KEY });
ok(r.body.ok && r.body.data?.code === aliceEntry.code, 'staff lookup WITHOUT session works (cashier path)');
ok(String(r.body.data?.winner || '').includes('…'), 'winner openid masked in staff view');
if (aliceEntry.checkoutCoupon) {
  // Cash prizes are redeemed at the cashier till via the coupon center; booth redeem must reject.
  r = await call(null, 'redeem', { code: aliceEntry.code }, { 'X-Staff-Key': STAFF_KEY });
  ok(!r.body.ok && r.body.code === 'CHECKOUT_COUPON', 'cash prize rejected at booth redeem (checkout coupon path)');
} else {
  r = await call(null, 'redeem', { code: aliceEntry.code }, { 'X-Staff-Key': STAFF_KEY });
  ok(r.body.ok && r.body.data.status === 'redeemed', 'staff redeem succeeds');
  r = await call(null, 'redeem', { code: aliceEntry.code }, { 'X-Staff-Key': STAFF_KEY });
  ok(!r.body.ok && r.body.code === 'ALREADY_REDEEMED', 'double redeem rejected');
  r = await call(alice.token, 'state');
  ok(r.body.data.entry?.status === 'redeemed', 'user side sees redeemed status');
}
r = await call(null, 'redeem', { code: 'FFFF0000FFFF0000' }, { 'X-Staff-Key': STAFF_KEY });
ok(!r.body.ok, 'unknown code rejected');

// ---------- 5. second user + admin ----------
console.log('\n[5] Second user + admin');
r = await call(bob.token, 'draw');
ok(r.body.ok && r.body.data?.code, `bob drew → ${r.body.data?.prize?.name}`);
const bobCode = r.body.data?.code || '';
const rec = await fetch(BASE + '/api/admin/records', { headers: { 'X-Staff-Key': STAFF_KEY } });
const recBody = await rec.json();
ok(rec.status === 200 && recBody.data?.summary?.entries >= 2, `admin records summary: ${JSON.stringify(recBody.data?.summary)}`);
const csv = await fetch(BASE + '/api/admin/records.csv', { headers: { 'X-Staff-Key': STAFF_KEY } });
ok(csv.status === 200 && (await csv.text()).includes(aliceEntry.code), 'CSV export contains alice\'s code');
const noKey = await fetch(BASE + '/api/admin/records');
ok(noKey.status === 401, 'admin without key → 401');

// ---------- 6. direct MySQL verification ----------
console.log('\n[6] Direct MySQL verification');
const mysql = await import('mysql2/promise');
const pool = mysql.createPool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME, dateStrings: true
});
const [rows] = await pool.query(
  "SELECT e.code, e.status, e.redeemed_by, p.name AS prize FROM hd_entries e LEFT JOIN hd_prizes p ON p.campaign_id=e.campaign_id AND p.prize_id=e.prize_id WHERE e.code IN (?,?)",
  [aliceEntry.code, bobCode]
);
ok(rows.length === 2, `both entries persisted in hd_entries: ${JSON.stringify(rows)}`);
const [stock] = await pool.query("SELECT SUM(qty_remaining) rem FROM hd_prizes WHERE campaign_id='bubble-race-2026-500'");
console.log(`  INFO  stock remaining in DB: ${stock[0].rem}`);
await pool.end();

// ---------- 7. coupon-center bridge (in-process stub + in-process app) ----------
// A cash win must mint a real coupon pinned to the entry code; a physical win
// must not; a failed issuance must be recoverable via retry-coupon-issue.
console.log('\n[7] Coupon-center bridge (stub)');
{
  const http = await import('node:http');
  const crypto = await import('node:crypto');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createApp } = await import('../server.mjs');
  const { hashToken } = await import('../src/auth.js');

  const STUB_TOKEN = 'e2e-lottery-key';
  const STUB_CAMPAIGN = 'e2e-stub-campaign';
  const coupons = new Map();
  const stubState = { failNext: 0 };
  const stub = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${STUB_TOKEN}`) return send(401, { ok: false, code: 'UNAUTHORIZED', error: '凭证无效' });
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/v1/campaigns') {
      return send(200, { ok: true, data: [{ id: STUB_CAMPAIGN, kind: 'cash', name: '5元立减金', amountCents: 500, minimumCents: 0, quota: 100, issued: coupons.size, enabled: true, startsAt: '2026-01-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z' }] });
    }
    if (req.method === 'POST' && url.pathname === '/v1/coupons/issue') {
      const input = JSON.parse(await new Promise(resolve => { let s = ''; req.on('data', c => s += c); req.on('end', () => resolve(s)); }));
      if (stubState.failNext > 0) { stubState.failNext--; return send(500, { ok: false, code: 'INJECTED', error: '注入的发券失败' }); }
      if (!coupons.has(input.awardId)) {
        coupons.set(input.awardId, { id: 'coupon-' + (coupons.size + 1), campaignId: input.campaignId, kind: 'cash', amountCents: 500, minimumCents: 0, owner: input.owner, awardId: input.awardId, state: 'AVAILABLE', code: input.trustedCode, environment: 'production', reservation: null });
      }
      return send(200, { ok: true, data: coupons.get(input.awardId) });
    }
    return send(404, { ok: false, code: 'NOT_FOUND', error: '接口不存在' });
  });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  const stubBase = `http://127.0.0.1:${stub.address().port}`;

  const runId = Date.now().toString(36);
  const cashCampaign = 'e2e-cash-' + runId;
  const physCampaign = 'e2e-phys-' + runId;
  const sessionHashes = [];
  const apps = [];
  const startApp = async (id, prizes) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lottery-e2e-'));
    fs.writeFileSync(path.join(dir, 'campaign.config.json'), JSON.stringify({
      id, name: 'E2E券联动', active: true,
      startsAt: '2026-01-01T00:00:00+08:00', endsAt: '2027-01-01T00:00:00+08:00', prizes,
    }));
    const app = await createApp({
      configPath: path.join(dir, 'campaign.config.json'),
      bridgeFile: path.join(dir, 'no-bridge.json'),
      env: { ...process.env, STAFF_KEY, WX_MOCK: '1', COUPON_CENTER_URL: stubBase, COUPON_LOTTERY_KEY: STUB_TOKEN, COUPON_CAMPAIGN_ID: STUB_CAMPAIGN },
    });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    apps.push({ app, dir });
    return `http://127.0.0.1:${app.server.address().port}`;
  };
  const callLocal = (base, action, payload = {}, headers = {}, token) =>
    fetch(base + '/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body: JSON.stringify({ action, payload }) }).then(async r => ({ status: r.status, body: await r.json() }));
  const loginLocal = async base => {
    const body = await fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'e2e-user-' + crypto.randomBytes(4).toString('hex') }) }).then(r => r.json());
    sessionHashes.push(hashToken(body.data.token));
    return body.data.token;
  };

  try {
    const cashBase = await startApp(cashCampaign, [{ id: 'cash5', name: '5元立减金', kind: 'cash', amount: 5, qty: 2, probability: 1 }]);
    const physBase = await startApp(physCampaign, [{ id: 'cap', name: '棒球帽', kind: 'physical', qty: 2, probability: 1 }]);

    // cash win → coupon exists with the same code and amount
    const cashToken = await loginLocal(cashBase);
    let r = await callLocal(cashBase, 'draw', {}, {}, cashToken);
    ok(r.body.ok && r.body.data.checkoutCoupon === true && r.body.data.status === 'pending', 'cash win shows a checkout coupon', JSON.stringify(r.body.data));
    const cashCode = r.body.data?.code || '';
    const minted = coupons.get(cashCode);
    ok(!!minted && minted.code === cashCode && minted.amountCents === 500 && minted.awardId === cashCode, 'coupon minted with entry code + face value 500 cents');

    // physical win → no coupon
    const physToken = await loginLocal(physBase);
    r = await callLocal(physBase, 'draw', {}, {}, physToken);
    const before = coupons.size;
    ok(r.body.ok && r.body.data.checkoutCoupon === false && coupons.size === before, 'physical win mints no coupon');

    // induced failure → draw kept, entry 'issuing', retry recovers exactly once
    stubState.failNext = 1;
    const lateToken = await loginLocal(cashBase);
    r = await callLocal(cashBase, 'draw', {}, {}, lateToken);
    ok(r.body.ok && r.body.data.status === 'issuing', 'failed issuance keeps the draw (status issuing)', JSON.stringify(r.body.data));
    const lateCode = r.body.data?.code || '';
    ok(!coupons.has(lateCode), 'no coupon minted while the center is failing');
    const rec = await fetch(cashBase + '/api/admin/records', { headers: { 'X-Staff-Key': STAFF_KEY } }).then(r => r.json());
    ok(rec.data?.summary?.couponIssuesPending === 1, `admin records surface couponIssuesPending=1 (got ${rec.data?.summary?.couponIssuesPending})`);
    r = await callLocal(cashBase, 'retry-coupon-issue', {}, { 'X-Staff-Key': STAFF_KEY });
    ok(r.body.ok && r.body.data.checked === 2 && r.body.data.confirmed === 2 && r.body.data.pending === 0, 'retry-coupon-issue mints the missing coupon (sweep confirms both cash entries)', JSON.stringify(r.body.data));
    ok(coupons.get(lateCode)?.code === lateCode, 'recovered coupon pinned to the entry code');
    r = await callLocal(cashBase, 'retry-coupon-issue', {}, { 'X-Staff-Key': STAFF_KEY });
    ok(r.body.ok && coupons.size === 2, 'second retry is idempotent (no double issue)');
    r = await callLocal(cashBase, 'state', {}, {}, lateToken);
    ok(r.body.data?.entry?.status === 'pending', 'winner sees the usable coupon after recovery');
  } finally {
    for (const { app, dir } of apps) {
      await new Promise(resolve => app.server.close(resolve));
      await app.pool.query('DELETE FROM hd_entries WHERE campaign_id IN (?, ?)', [cashCampaign, physCampaign]);
      await app.pool.query('DELETE FROM hd_prizes WHERE campaign_id IN (?, ?)', [cashCampaign, physCampaign]);
      await app.pool.query('DELETE FROM hd_campaigns WHERE id IN (?, ?)', [cashCampaign, physCampaign]);
      if (sessionHashes.length) await app.pool.query(`DELETE FROM hd_sessions WHERE token_hash IN (${sessionHashes.map(() => '?').join(',')})`, sessionHashes);
      await app.pool.end();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    await new Promise(resolve => stub.close(resolve));
  }
}

// ---------- summary ----------
console.log(`\n===== E2E RESULT: ${passed} passed, ${failed} failed =====`);
process.exit(failed ? 1 : 0);
