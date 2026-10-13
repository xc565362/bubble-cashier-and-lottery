const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

// Exported historical maintenance source. Review deployment/README.md before use.
function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) throw new Error('Set ' + name + ' explicitly before running this historical maintenance script.');
  return value.trim();
}
function requiredHttpsOrigin(name) {
  const value = requiredEnv(name);
  let url;
  try { url = new URL(value); } catch { throw new Error(name + ' must be a valid HTTPS origin.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(name + ' must be an HTTPS origin without credentials, path or query.');
  return url.origin;
}
const expectedCenterUrl = requiredHttpsOrigin('BUBBLE_EXPECTED_CENTER_URL');
const expectedCenterId = requiredEnv('BUBBLE_EXPECTED_CENTER_ID');
const base = path.resolve(process.argv[2]);
const privateRoot = path.dirname(base);
const project = path.resolve(__dirname, '..');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (name, value) => fs.writeFileSync(path.join(base, name), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fn = json(path.join(base, 'cloudbaserc.before.json')).functions.find(item => item.name === 'lottery');
const management = JSON.parse(fn.envVariables.LOTTERY_MANAGEMENT_CENTER_JSON);
const physical = json(path.join(privateRoot, 'server-backup-20260921', 'physical-center.prepared.json'));
const { campaign, prizes } = require('../lottery-backend/config.js');
const physicalPrizes = prizes.filter(prize => prize.kind === 'physical');

async function center(route, token = management.adminToken) {
  const response = await fetch(new URL(route, management.baseUrl), {
    headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  assert.ok(response.ok && result.ok, 'Coupon read failed: ' + (result.code || response.status));
  return result.data;
}

async function local(action) {
  const response = await fetch('http://localhost:5173/api/sqb/' + action, {
    method: 'POST', headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' },
    body: '{}', signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  assert.ok(response.ok && result.ok, 'Original cashier read failed: ' + action);
  return result.data;
}

function tree(directory, relative = '') {
  return fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).flatMap(entry => {
    const name = path.join(relative, entry.name);
    assert.ok(!entry.isSymbolicLink(), 'Unexpected symbolic link');
    return entry.isDirectory() ? tree(directory, name) : [{ name, sha256: hash(path.join(directory, name)) }];
  });
}

async function main() {
  assert.ok(!fn.envVariables.PHYSICAL_CENTER_JSON, 'Physical configuration already exists; re-read current state');
  assert.equal(fn.timeout, 60);
  assert.equal(management.baseUrl.replace(/\/$/, ''), expectedCenterUrl);
  assert.equal(management.centerId, expectedCenterId);
  assert.equal(physical.baseUrl, management.baseUrl);
  assert.equal(physical.centerId, management.centerId);
  assert.equal(campaign.redemptionEndsAt, Date.parse('2026-09-27T10:00:00Z'));

  const code = tree(path.join(base, 'code-before')).filter(file => !file.name.startsWith('node_modules' + path.sep));
  assert.ok(code.length >= 14);
  for (const file of code) assert.equal(hash(path.join(project, 'lottery-backend', file.name)), file.sha256, 'Cloud/local source mismatch: ' + file.name);
  save('code-before.manifest.json', code);
  const frontend = path.resolve(project, '../小程序交付/小程序前端-二维码版/miniprogram');
  save('miniprogram-before.manifest.json', { root: frontend, files: tree(frontend) });

  const info = await center('/v1/info');
  assert.equal(info.centerId, management.centerId);
  assert.equal(info.role, 'admin');
  assert.equal(info.environment, 'production');
  for (const capability of ['physical-prize-v1', 'quota-increase-v1', 'redemption-deadline-v1']) assert.ok(info.capabilities.includes(capability));
  save('coupon-info.before.json', info);
  for (const state of ['RESERVED', 'PAYMENT_PENDING']) assert.equal((await center('/v1/coupons?state=' + state)).total, 0, 'Redemption in progress');
  const campaigns = await center('/v1/campaigns');
  save('coupon-campaigns.before.json', campaigns);
  const issuerChecks = [];
  for (const prize of physicalPrizes) {
    const mapping = physical.prizes[prize.id];
    assert.equal(mapping.campaignId, management.prizes[prize.id]);
    const current = campaigns.find(row => row.id === mapping.campaignId);
    assert.ok(current && current.enabled);
    assert.equal(current.kind, 'physical');
    assert.equal(current.physical.prizeId, prize.id);
    assert.equal(current.redemptionEnabled, false);
    assert.equal(Date.parse(current.startsAt), campaign.startsAt);
    assert.equal(Date.parse(current.expiresAt), campaign.redeemEndsAt);
    assert.equal(Date.parse(current.redemptionEndsAt), campaign.redemptionEndsAt);
    const issuer = await center('/v1/info', mapping.token);
    assert.equal(issuer.centerId, management.centerId);
    assert.equal(issuer.role, 'lottery');
    assert.equal(issuer.environment, 'production');
    const scoped = await center('/v1/campaigns', mapping.token);
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].id, current.id);
    issuerChecks.push({ prizeId: prize.id, campaignId: current.id, role: issuer.role, verified: true });
  }
  save('coupon-keys.before.json', await center('/v1/keys'));
  save('coupon-events.before.json', await center('/v1/events'));
  const allCoupons = [];
  for (let page = 1; ; page++) {
    const result = await center('/v1/coupons?page=' + page);
    assert.ok(Array.isArray(result.items));
    allCoupons.push(...result.items);
    if (allCoupons.length >= result.total) break;
    assert.ok(result.items.length && page < 1000, 'Unexpected coupon pagination');
  }
  save('coupon-rows.before.json', allCoupons);
  const settings = await local('config');
  assert.equal(settings.ready, true);
  assert.equal(settings.mode, 'production');
  const pending = await local('pending');
  assert.ok(Array.isArray(pending) && pending.length === 0, 'Pending payment found');
  const connection = await local('coupon-config');
  assert.equal(connection.connected, true);
  assert.equal(connection.centerId, management.centerId);
  assert.equal(connection.openReservations, 0);
  const bindings = await local('coupon-physical-bindings');
  save('local-bindings.before.json', bindings);
  const snapshot = await local('lottery-snapshot');
  assert.ok(!snapshot.centerError);
  assert.equal(snapshot.endsAt, campaign.redemptionEndsAt);
  assert.equal(snapshot.redemptionEndsAt, campaign.redemptionEndsAt);
  save('lottery-snapshot.before.json', snapshot);
  const dataDirectory = path.join(process.env.USERPROFILE, '.stall-cashier-sqb-web');
  const files = fs.readdirSync(dataDirectory, { withFileTypes: true }).filter(entry => entry.isFile() && !entry.name.endsWith('.tmp'));
  const destination = path.join(base, 'local-data-before');
  fs.mkdirSync(destination, { mode: 0o700 });
  for (const file of files) fs.copyFileSync(path.join(dataDirectory, file.name), path.join(destination, file.name), fs.constants.COPYFILE_EXCL);
  save('local-data-before.manifest.json', tree(destination));
  const report = { at: new Date().toISOString(), readOnlyPreflight: true, sourceFilesVerified: code.length,
    frontendFiles: tree(frontend).length, issuerChecks, coupons: allCoupons.length,
    pool: { total: snapshot.total, allocated: snapshot.allocated, remaining: snapshot.remaining, revision: snapshot.revision, mode: snapshot.mode },
    liveProductInventoryVerified: false, originalMerchantReady: true, physicalCutoverActivated: false };
  save('preflight.json', report);
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
