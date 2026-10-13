const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const base = path.resolve(process.argv[2]);
const source = path.resolve(__dirname, '..');
const before = path.join(base, 'code-before');
const stage = path.join(base, 'deploy-code');
assert.ok(fs.existsSync(before) && !fs.existsSync(stage));
const changed = ['config.js', 'domain.js', 'service.js', 'center-lottery.cjs', 'physical-center.cjs', 'pool-management.cjs', 'management-center.cjs'];
for (const name of fs.readdirSync(before)) {
  if (!fs.statSync(path.join(before, name)).isFile() || changed.includes(name)) continue;
  assert.ok(fs.readFileSync(path.join(before, name)).equals(fs.readFileSync(path.join(source, 'lottery-backend', name))), 'Unexpected cloud change: ' + name);
}
const oldConfig = require(path.join(before, 'config.js'));
const nextConfig = require(path.join(source, 'lottery-backend', 'config.js'));
const expected = structuredClone(oldConfig);
expected.campaign.endsAt = Date.parse('2026-09-27T10:00:00.000Z');
expected.campaign.redemptionEndsAt = expected.campaign.endsAt;
assert.deepEqual(nextConfig, expected, 'Only the two cutoff fields may change');
function copy(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copy(path.join(from, e.name), path.join(to, e.name));
    else { assert.ok(e.isFile()); fs.copyFileSync(path.join(from, e.name), path.join(to, e.name)); }
  }
}
copy(before, stage);
for (const name of changed) fs.copyFileSync(path.join(source, 'lottery-backend', name), path.join(stage, name));
const config = JSON.parse(fs.readFileSync(path.join(base, 'cloudbaserc.before.json')));
const target = config.functions.find(fn => fn.name === 'lottery');
assert.ok(target && !target.envVariables.PHYSICAL_CENTER_JSON);
const privateCenter = JSON.parse(target.envVariables.LOTTERY_MANAGEMENT_CENTER_JSON);
assert.equal(privateCenter.centerId, '6946ec4d-8127-45c7-9dc6-dbc4e9eb72e0');
assert.equal(Object.keys(privateCenter.prizes).length, 8);
fs.writeFileSync(path.join(base, 'cloudbaserc.deploy.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(base, 'code-manifest.json'), JSON.stringify(changed.map(name => ({ name, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(stage, name))).digest('hex') })), null, 2));
console.log(JSON.stringify({ filesChanged: changed, endsAt: expected.campaign.endsAt, redemptionEndsAt: expected.campaign.redemptionEndsAt, environmentPreserved: true, physicalCutoverActivated: false }));
