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
r = await call(null, 'redeem', { code: aliceEntry.code }, { 'X-Staff-Key': STAFF_KEY });
ok(r.body.ok && r.body.data.status === 'redeemed', 'staff redeem succeeds');
r = await call(null, 'redeem', { code: aliceEntry.code }, { 'X-Staff-Key': STAFF_KEY });
ok(!r.body.ok && r.body.code === 'ALREADY_REDEEMED', 'double redeem rejected');
r = await call(null, 'redeem', { code: 'FFFF0000FFFF0000' }, { 'X-Staff-Key': STAFF_KEY });
ok(!r.body.ok, 'unknown code rejected');
r = await call(alice.token, 'state');
ok(r.body.data.entry?.status === 'redeemed', 'user side sees redeemed status');

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

// ---------- summary ----------
console.log(`\n===== E2E RESULT: ${passed} passed, ${failed} failed =====`);
process.exit(failed ? 1 : 0);
