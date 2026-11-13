const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const [cli, directory] = process.argv.slice(2);
const base = path.resolve(directory), env = 'bubble-lottery-500-d8cd9c6a45992';
const json = name => JSON.parse(fs.readFileSync(path.join(base, name)));
async function main() {
  const before = json('cloudbaserc.before.json').functions[0];
  const after = json('cloudbaserc.after.json').functions[0];
  assert.deepEqual(after.envVariables, before.envVariables);
  assert.ok(!after.envVariables.PHYSICAL_CENTER_JSON);
  const files = fs.readdirSync(path.join(base, 'deploy-code')).filter(n => fs.statSync(path.join(base, 'deploy-code', n)).isFile());
  for (const name of files) assert.ok(fs.readFileSync(path.join(base, 'deploy-code', name)).equals(fs.readFileSync(path.join(base, 'code-after', name))), 'Deployed code mismatch: ' + name);
  const report = { at: new Date().toISOString(), sourceFilesVerified: files.length, environmentPreserved: true, physicalCutoverActivated: false, tables: {} };
  for (const table of ['lottery_entries', 'lottery_codes', 'lottery_pools']) {
    const command = JSON.stringify([{ TableName: table, CommandType: 'QUERY', Command: JSON.stringify({ find: table, filter: {}, limit: 10000 }) }]);
    const r = spawnSync(process.execPath, [cli, '-e', env, 'db', 'nosql', 'execute', '--command', command, '--json'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.equal(r.status, 0, 'Cloud query failed');
    fs.writeFileSync(path.join(base, table + '.after.json'), r.stdout, { mode: 0o600 });
    const rows = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))).data.results[0];
    const old = json(table + '.raw.json').data.results[0];
    assert.deepEqual(rows.sort((a, b) => a._id.localeCompare(b._id)), old.sort((a, b) => a._id.localeCompare(b._id)), 'Concurrent activity or changed table: ' + table);
    report.tables[table] = { count: rows.length, unchanged: true };
  }
  const r = await fetch('http://localhost:5173/api/sqb/lottery-snapshot', { method: 'POST', headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }, body: '{}' });
  const body = await r.json();
  assert.ok(r.ok && body.ok, 'Original cashier snapshot unavailable');
  const s = body.data;
  assert.equal(s.endsAt, Date.parse('2026-09-27T10:00:00.000Z'));
  assert.equal(s.redemptionEndsAt, s.endsAt); assert.ok(!s.centerError);
  assert.equal(Object.keys(s.center.prizes).length, 8);
  for (const p of Object.values(s.center.prizes)) assert.equal(Date.parse(p.redemptionEndsAt), s.endsAt);
  report.originalCashierVerified = true;
  report.cutoffBeijing = '2026-09-27 18:00:00+08:00';
  report.pool = { total: s.total, allocated: s.allocated, remaining: s.remaining, revision: s.revision, mode: s.mode };
  fs.writeFileSync(path.join(base, 'deadline-verified.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
