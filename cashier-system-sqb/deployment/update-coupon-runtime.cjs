const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync, backup } = require('node:sqlite');
const root = '/opt/bubble/cashier-system-0.7.6';
const persistent = '/var/lib/bubble-coupons';
const dir = persistent + '/backups/management-0.7.6-20260922';
const override = '/etc/systemd/system/bubble-coupons.service.d/76-lottery-management.conf';
const run = (...args) => { const r = spawnSync('systemctl', args, { encoding: 'utf8', timeout: 30000 }); if (r.status !== 0) throw new Error('systemctl failed: ' + args.join(' ')); return r.stdout.trim(); };
const rows = db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name}) => {
  assert.match(name, /^[a-z_]+$/);
  const items = db.prepare('SELECT * FROM ' + name).all().map(row => JSON.stringify(row)).sort();
  return [name, { count: items.length, sha256: crypto.createHash('sha256').update(items.join('\n')).digest('hex') }];
}));
async function main() {
  assert.equal(process.getuid(), 0);
  assert.ok(!fs.existsSync(override), 'Already upgraded');
  assert.ok(!fs.existsSync(dir), 'Backup already exists; inspect before retry');
  assert.ok(fs.existsSync(root + '/coupons/server.cjs'));
  const proc = run('show', 'bubble-coupons', '-p', 'MainPID', '--value');
  const env = Object.fromEntries(fs.readFileSync('/proc/' + proc + '/environ', 'utf8').split('\0').filter(Boolean).map(s => { const i = s.indexOf('='); return [s.slice(0,i), s.slice(i+1)]; }));
  assert.equal(path.resolve(env.COUPON_DATA_DIR), persistent);
  assert.equal(env.COUPON_ENV, 'production');
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.copyFileSync(persistent + '/deployment/coupon.env', dir + '/coupon.env');
  fs.copyFileSync('/etc/systemd/system/bubble-coupons.service', dir + '/service.before');
  fs.cpSync('/etc/systemd/system/bubble-coupons.service.d', dir + '/dropins.before', { recursive: true });
  const db = new DatabaseSync(persistent + '/coupons.sqlite', { readOnly: true, timeout: 5000 });
  const pending = () => db.prepare("SELECT count(*) AS n FROM coupons WHERE json_extract(data,'$.state') IN ('RESERVED','PAYMENT_PENDING')").get().n;
  assert.equal(pending(), 0, 'Active redemption exists; leave service running');
  await backup(db, dir + '/coupons.online.sqlite');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  let stopped = false, applied = false;
  try {
    run('stop', 'bubble-coupons'); stopped = true;
    assert.equal(pending(), 0, 'Redemption started before stop; restarting original service');
    await backup(db, dir + '/coupons.before.sqlite');
    const before = rows(db);
    fs.writeFileSync(dir + '/business-before.json', JSON.stringify(before, null, 2));
    fs.writeFileSync(override, '[Service]\nExecStart=\nExecStart=/usr/local/bin/node ' + root + '/coupons/server.cjs\n', { flag: 'wx', mode: 0o644 }); applied = true;
    run('daemon-reload'); run('start', 'bubble-coupons');
    assert.equal(run('is-active', 'bubble-coupons'), 'active');
    let info;
    for (let n = 0; n < 10; n++) {
      try {
        const r = await fetch('http://127.0.0.1:' + (env.PORT || '3910') + '/v1/info', { headers: { Authorization: 'Bearer ' + env.COUPON_ADMIN_TOKEN } });
        info = await r.json(); if (info.ok) break;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(info?.data?.capabilities?.includes('quota-increase-v1'));
    assert.equal(info.data.environment, 'production');
    const after = rows(db);
    fs.writeFileSync(dir + '/business-after.json', JSON.stringify(after, null, 2));
    assert.deepEqual(after, before, 'Concurrent business activity or unexpected row change; inspect backup');
    fs.writeFileSync(dir + '/verified.json', JSON.stringify({ at: new Date().toISOString(), version: '0.7.6', integrity: 'ok', businessRowsUnchanged: true, centerId: info.data.centerId }));
    console.log(JSON.stringify({ active: true, version: '0.7.6', businessRowsUnchanged: true, quotaCapability: true, backup: dir }));
  } catch (error) {
    if (applied) { fs.unlinkSync(override); run('daemon-reload'); }
    if (stopped) run('start', 'bubble-coupons');
    throw error;
  } finally { db.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
