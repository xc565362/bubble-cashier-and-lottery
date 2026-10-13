const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const [cli, directory] = process.argv.slice(2);
const env = 'bubble-lottery-500-d8cd9c6a45992';
const base = path.resolve(directory);
const json = name => JSON.parse(fs.readFileSync(path.join(base, name)));
const result = raw => JSON.parse(raw.slice(raw.indexOf('{')));
const report = { at: new Date().toISOString(), businessTables: {}, unauthorizedHttp: null };
for (const table of ['lottery_entries', 'lottery_codes', 'lottery_pools']) {
  const command = JSON.stringify([{ TableName: table, CommandType: 'QUERY', Command: JSON.stringify({ find: table, filter: {}, limit: 10000 }) }]);
  const r = spawnSync(process.execPath, [cli, '-e', env, 'db', 'nosql', 'execute', '--command', command, '--json'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(r.status, 0);
  fs.writeFileSync(path.join(base, table + '.after.json'), r.stdout, { mode: 0o600 });
  const rows = result(r.stdout).data.results[0];
  const before = json(table + '.raw.json').data.results[0];
  assert.deepEqual(rows.sort((a,b)=>a._id.localeCompare(b._id)), before.sort((a,b)=>a._id.localeCompare(b._id)), table + ' changed; inspect live activity');
  report.businessTables[table] = { count: rows.length, unchanged: true };
}
const before = json('cloudbaserc.before.json').functions[0].envVariables;
const after = json('cloudbaserc.after.json').functions[0].envVariables;
assert.ok(Object.entries(before).every(([k,v]) => after[k] === v));
assert.ok(!after.PHYSICAL_CENTER_JSON);
report.existingEnvironmentPreserved = true;
report.physicalCutoverActivated = false;
const connection = json('management-connection.json');
(async () => {
  const r = await fetch(connection.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401); report.unauthorizedHttp = r.status;
  const bridge = require('../payments/lottery.cjs').createLotteryBridge({ directory: base });
  const s = await bridge.dispatch('snapshot');
  assert.equal(s.center?.quotaAdjustmentSupported, true);
  assert.ok(!s.centerError);
  report.pool = { mode: s.mode, revision: s.revision, total: s.total, allocated: s.allocated, remaining: s.remaining };
  fs.writeFileSync(path.join(base, 'verified-management.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
