const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
process.on('uncaughtException', error => { console.error('Preparation failed:', error.code || error.name, error.stack?.split('\n').find(line => line.includes('prepare-lottery-management.cjs'))?.trim()); process.exitCode = 1; });
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
const managementOrigin = requiredHttpsOrigin('BUBBLE_LOTTERY_MANAGEMENT_ORIGIN');
const [backup, dataDir, physicalFile] = process.argv.slice(2).map(p => path.resolve(p));
const source = path.resolve(__dirname, '../lottery-backend');
const before = JSON.parse(fs.readFileSync(path.join(backup, 'cloudbaserc.before.json')));
const local = JSON.parse(fs.readFileSync(path.join(dataDir, 'coupon-connection.json')));
const physical = JSON.parse(fs.readFileSync(physicalFile));
const fn = before.functions.find(f => f.name === 'lottery');
const cash = JSON.parse(fn.envVariables.CASHIER_CENTER_JSON);
console.log('Preparing management connection from verified configuration');
assert.equal(local.baseUrl, cash.baseUrl);
assert.equal(cash.centerId, physical.centerId);
assert.ok(!fn.envVariables.LOTTERY_MANAGEMENT_KEY, 'Already configured; do not rotate silently');
assert.ok(!fn.envVariables.PHYSICAL_CENTER_JSON, 'Physical cutover requires separate review');
const key = crypto.randomBytes(32).toString('hex');
const center = { baseUrl: local.baseUrl, centerId: cash.centerId, adminToken: local.adminToken,
  prizes: Object.fromEntries(Object.entries({ ...cash.prizes, ...physical.prizes }).map(([id, p]) => [id, p.campaignId])) };
assert.equal(Object.keys(center.prizes).length, 8);
assert.ok(Object.values(center.prizes).every(Boolean));
console.log('Validated eight prize mappings');
const dir = path.join(backup, 'deploy-code');
assert.ok(!fs.existsSync(dir));
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const target = path.join(to, entry.name), origin = path.join(from, entry.name);
    if (entry.isDirectory()) copyTree(origin, target);
    else if (entry.isFile()) fs.copyFileSync(origin, target);
    else throw new Error('Unexpected link in deployment backup');
  }
}
copyTree(path.join(backup, 'code-before'), dir);
for (const name of fs.readdirSync(source)) {
  if (!fs.statSync(path.join(source, name)).isFile()) continue;
  const old = path.join(backup, 'code-before', name);
  if (fs.existsSync(old) && !['index.js', 'service.js'].includes(name)) assert.ok(fs.readFileSync(old).equals(fs.readFileSync(path.join(source, name))), 'Unexpected change: ' + name);
  fs.copyFileSync(path.join(source, name), path.join(dir, name));
}
// The management origin is explicitly supplied above; no production domain is embedded.
const route = '/lottery-management';
fn.envVariables.LOTTERY_MANAGEMENT_KEY = key;
fn.envVariables.LOTTERY_MANAGEMENT_CENTER_JSON = JSON.stringify(center);
const write = (name, data) => fs.writeFileSync(path.join(backup, name), JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
write('cloudbaserc.management.json', before);
write('management-connection.json', { url: managementOrigin + route, campaignId: require('../lottery-backend/config.js').campaign.id, key });
write('route-request.json', { ServiceId: before.envId, Path: route, Type: 1, Name: 'lottery' });
console.log(JSON.stringify({ prepared: true, codeDir: dir, envPreserved: ['CASHIER_CENTER_JSON', 'LOTTERY_ADMIN_OPENIDS'], physicalCutover: false, mappedPrizes: 8 }));
