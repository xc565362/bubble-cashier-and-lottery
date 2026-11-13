'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { environment, rewriteUnit, planCouponDropIn, assertEffectiveCoupon, createOwnedDropIn, removeOwnedDropIn, assertIdle, backupDatabase, backupTree, parseArgs, verifyManifest, activateRuntime, withMaintenance } = require('./update-linux.cjs');
const closers = new WeakMap();
const temp = t => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-update-fixture-')); closers.set(t, []); t.after(() => { for (const close of closers.get(t)) close(); fs.rmSync(directory, { recursive: true, force: true }); }); return directory; };
const options = { expectedRelease: '/opt/bubble/old', release: '/opt/bubble/new', node: '/usr/local/bin/node', target: 'online', envFile: '/etc/bubble-online/service.env' };
const unit = '[Unit]\nDescription=existing\n[Service]\nUser=bubble-online\nWorkingDirectory=/opt/bubble/old\nEnvironmentFile=/etc/bubble-online/service.env\nExecStart=/usr/local/bin/node online/server.cjs\nProtectSystem=strict\n';

test('unit switch changes only runtime location and preserves service user, env path and sandbox hardening', () => {
  const next = rewriteUnit(unit, options);
  assert.equal(next, unit.replace('WorkingDirectory=/opt/bubble/old', 'WorkingDirectory=/opt/bubble/new'));
  const absolute = unit.replace('node online/server.cjs', 'node /opt/bubble/old/online/server.cjs');
  assert.equal(rewriteUnit(absolute, options), next);
  for (const old of [unit.replace('/opt/bubble/old', '/opt/bubble/other'), unit + 'ExecStart=/bin/false\n', unit.replace('EnvironmentFile=', 'OtherEnvironment='), unit.replace('online/server.cjs', 'custom.cjs')]) assert.throws(() => rewriteUnit(old, options), /预期不符/);
  assert.throws(() => rewriteUnit(unit, { ...options, release: '/opt/bubble/../unsafe' }), /路径/);
});

test('coupon service update requires separately verified unit and switches to coupon entry only', () => {
  const current = unit.replaceAll('online/server.cjs', 'coupons/server.cjs').replace('EnvironmentFile=/etc/bubble-online/service.env', 'EnvironmentFile=/etc/bubble-coupons.env');
  assert.match(rewriteUnit(current, { ...options, target: 'coupon', envFile: '/etc/bubble-coupons.env' }), /ExecStart=\/usr\/local\/bin\/node coupons\/server.cjs/);
  assert.throws(() => rewriteUnit(unit, { ...options, target: 'coupon' }), /预期不符/);
});

function couponProfileFixture() {
  const node = '/opt/node-v24.19.0-linux-x64/bin/node', id = '20261014-123456abcdef';
  const current = '[Unit]\nDescription=existing coupon center\n[Service]\nType=simple\nUser=bubble-coupons\nGroup=bubble-coupons\nWorkingDirectory=/opt/bubble\nEnvironmentFile=/var/lib/bubble-coupons/deployment/coupon.env\nExecStart=/usr/local/bin/node /opt/bubble/cashier-system-0.7.0/coupons/server.cjs\nRestart=on-failure\nRestartSec=3\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nProtectSystem=strict\nReadWritePaths=/var/lib/bubble-coupons\nTimeoutStopSec=30\n[Install]\nWantedBy=multi-user.target\n';
  const dropIns = [['73-cashier-runtime.conf', '/usr/local/bin/node /opt/bubble/cashier-system-0.7.3'], ['76-lottery-management.conf', '/usr/local/bin/node /opt/bubble/cashier-system-0.7.6'], ['77-redemption-deadline.conf', '/usr/local/bin/node /opt/bubble/cashier-system-0.7.6-deadline'], ['zz-h5-catalog-mv64ca07.conf', `${node} /opt/bubble/cashier-system-h5-20261013`]].map(([name, command]) => ({ path: `/etc/systemd/system/bubble-coupons.service.d/${name}`, bytes: Buffer.from(`[Service]\nExecStart=\nExecStart=${command}/coupons/server.cjs\n`) }));
  const effective = {
    FragmentPath: '/etc/systemd/system/bubble-coupons.service', DropInPaths: dropIns.map(item => item.path).join(' '), WorkingDirectory: '/opt/bubble',
    ExecStart: `{ path=${node} ; argv[]=${node} /opt/bubble/cashier-system-h5-20261013/coupons/server.cjs ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
    EnvironmentFiles: '/var/lib/bubble-coupons/deployment/coupon.env (ignore_errors=no)', User: 'bubble-coupons', Group: 'bubble-coupons',
  };
  return { current, dropIns, effective, unit: 'bubble-coupons.service', expectedRelease: '/opt/bubble/cashier-system-h5-20261013', release: `/opt/bubble/coupon-center-${id}`, node, envFile: '/var/lib/bubble-coupons/deployment/coupon.env', id };
}

test('verified production profile preserves four existing overrides and adds only final code-location directives', () => {
  const f = couponProfileFixture(), before = JSON.stringify(f), plan = planCouponDropIn(f);
  assert.equal(JSON.stringify(f), before);
  assert.equal(plan.file, '/etc/systemd/system/bubble-coupons.service.d/zzzz-codex-lottery-20261014-123456abcdef.conf');
  assert.equal(plan.bytes.toString(), `[Service]\nWorkingDirectory=${f.release}\nExecStart=\nExecStart=${f.node} ${f.release}/coupons/server.cjs\n`);
  assert.ok(!/Environment|User=|Group=|ReadWritePaths|ProtectSystem/.test(plan.bytes.toString()));
  assert.deepEqual(plan.next.paths.slice(0, -1), f.dropIns.map(item => item.path));
  const nextEffective = { ...f.effective, DropInPaths: plan.next.paths.join(' '), WorkingDirectory: f.release, ExecStart: f.effective.ExecStart.replace(f.expectedRelease, f.release) };
  assert.doesNotThrow(() => assertEffectiveCoupon(nextEffective, plan.next));
  assert.throws(() => assertEffectiveCoupon(nextEffective, plan.prior), /不一致/);
  assert.deepEqual(parseArgs(['--coupon-drop-in-profile', 'h5-20261013']), { couponDropInProfile: 'h5-20261013' });
});

test('production drop-in profile fails closed on unknown overrides, configuration, effective runtime or path', () => {
  for (const change of [
    f => { f.dropIns.push({ path: '/etc/systemd/system/bubble-coupons.service.d/zzz-other.conf', bytes: Buffer.from('[Service]\nExecStart=\n') }); },
    f => { f.dropIns[0].bytes = Buffer.from(f.dropIns[0].bytes.toString() + 'Environment=HOST=0.0.0.0\n'); },
    f => { f.dropIns[1].path = '/run/systemd/system/bubble-coupons.service.d/76-lottery-management.conf'; },
    f => { f.dropIns[2].bytes = Buffer.from(f.dropIns[2].bytes.toString().replace('ExecStart=\n', '')); },
    f => { f.dropIns[3].bytes = Buffer.from('[Unit]\nConditionPathExists=/tmp/other\n' + f.dropIns[3].bytes.toString()); },
    f => { f.current = f.current.replace('ProtectSystem=strict', 'ProtectSystem=false'); },
    f => { f.current += '[Service]\nEnvironment=COUPON_DATA_DIR=/tmp\n'; },
    f => { f.effective.EnvironmentFiles += ' /tmp/unverified.env (ignore_errors=no)'; },
    f => { f.effective.User = 'root'; }, f => { f.effective.Group = 'root'; },
    f => { f.effective.WorkingDirectory = '/tmp'; },
    f => { f.effective.ExecStart = f.effective.ExecStart.replace('ignore_errors=no', 'ignore_errors=yes'); },
    f => { f.effective.ExecStart += ' { path=/bin/false ; argv[]=/bin/false ; ignore_errors=no ; }'; },
    f => { f.effective.DropInPaths = f.effective.DropInPaths.split(' ').reverse().join(' '); },
    f => { f.release = '/opt/bubble/../unsafe'; }, f => { f.node = '/usr/local/bin/node'; }, f => { f.unit = 'other.service'; },
  ]) { const f = couponProfileFixture(); change(f); assert.throws(() => planCouponDropIn(f)); }
});

test('owned drop-in uses exclusive creation, preserves old configuration, and rollback removes only unchanged new file', t => {
  const directory = temp(t), f = couponProfileFixture(), plan = planCouponDropIn(f);
  fs.writeFileSync(path.join(directory, 'bubble-coupons.service'), f.current);
  for (const item of f.dropIns) fs.writeFileSync(path.join(directory, path.basename(item.path)), item.bytes);
  const originals = fs.readdirSync(directory).map(name => [name, fs.readFileSync(path.join(directory, name))]);
  const file = path.join(directory, path.basename(plan.file)); let owned = false;
  createOwnedDropIn(file, plan.bytes, () => { owned = true; }); assert.equal(owned, true);
  assert.throws(() => createOwnedDropIn(file, Buffer.from('not-owned'), () => assert.fail('must not acquire an existing file')), { code: 'EEXIST' });
  fs.appendFileSync(file, '# external change\n');
  assert.throws(() => removeOwnedDropIn(file, plan.bytes), { code: 'ROLLBACK_CONFIG_CHANGED' });
  assert.equal(fs.existsSync(file), true);
  fs.writeFileSync(file, plan.bytes); removeOwnedDropIn(file, plan.bytes); removeOwnedDropIn(file, plan.bytes);
  assert.equal(fs.existsSync(file), false);
  for (const [name, bytes] of originals) assert.deepEqual(fs.readFileSync(path.join(directory, name)), bytes);
});

test('post-switch health failure removes the new override before restarting previous runtime without rewriting originals', async t => {
  const directory = temp(t), f = couponProfileFixture(), plan = planCouponDropIn(f), file = path.join(directory, path.basename(plan.file));
  const original = path.join(directory, 'old-unit'); fs.writeFileSync(original, f.current); let newLoaded = false, running = true, healthCalls = 0;
  await assert.rejects(activateRuntime({
    before() {}, stop() { running = false; }, verifyStopped() { assert.equal(running, false); }, verifyIdle() {}, backup() {},
    verifyPreserved() { assert.equal(fs.readFileSync(original, 'utf8'), f.current); },
    switchUnit() { createOwnedDropIn(file, plan.bytes); }, restoreUnit() { removeOwnedDropIn(file, plan.bytes); },
    reload() { newLoaded = fs.existsSync(file); }, start() { running = true; },
    health() { healthCalls++; if (newLoaded) throw new Error('fixture new-runtime failure'); assert.equal(running, true); },
  }), error => error.rollback === 'previous-code-active');
  assert.equal(healthCalls, 2); assert.equal(newLoaded, false); assert.equal(running, true);
  assert.equal(fs.existsSync(file), false); assert.equal(fs.readFileSync(original, 'utf8'), f.current);
});

test('environment parsing preserves values without expansion and rejects ambiguous duplicates', () => {
  assert.deepEqual(environment('# existing\nPORT=5175\nPRIVATE="$(no execution)"\nOTHER=\'secret\'\n'), { PORT: '5175', PRIVATE: '$(no execution)', OTHER: 'secret' });
  assert.throws(() => environment('PORT=5175\nPORT=3910'), /格式/);
  assert.throws(() => environment('export PORT=5175'), /格式/);
  assert.deepEqual(parseArgs(['--source', '/tmp/stage', '--expected-release', '/opt/bubble/old']), { source: '/tmp/stage', expectedRelease: '/opt/bubble/old' });
  assert.throws(() => parseArgs(['--source', '--apply']), /参数/);
});

function ledgerFixture(t) {
  const directory = temp(t), file = path.join(directory, 'ledger.sqlite'), db = new DatabaseSync(file);
  db.exec('CREATE TABLE online_ledger(id INTEGER PRIMARY KEY,body TEXT); CREATE TABLE online_lease(id INTEGER PRIMARY KEY,body TEXT); CREATE TABLE online_ack(id TEXT); CREATE TABLE online_awards(id TEXT)');
  const state = { products: [{ id: 'existing-product' }], orders: [{ id: 'existing-order' }] };
  db.prepare('INSERT INTO online_ledger VALUES(1,?)').run(JSON.stringify(state));
  fs.mkdirSync(path.join(directory, 'payments'));
  closers.get(t).push(() => db.close()); return { directory, db, state };
}

test('preflight refuses active lease and every pending financial/coupon journal without clearing them', t => {
  const f = ledgerFixture(t);
  assert.deepEqual(assertIdle(f.directory), { products: 1, orders: 1, idle: true });
  f.db.prepare('INSERT INTO online_lease VALUES(1,?)').run(JSON.stringify({ expiresAt: Date.now() + 60000 }));
  assert.throws(() => assertIdle(f.directory), /权限或未决/); assert.equal(f.db.prepare('SELECT count(*) n FROM online_lease').get().n, 1);
  f.db.exec('DELETE FROM online_lease');
  for (const key of ['pendingPayment', 'pendingAdjustment', 'pendingRestore', 'pendingZero', 'pendingCouponReservation']) {
    f.db.prepare('UPDATE online_ledger SET body=?').run(JSON.stringify({ ...f.state, [key]: { id: 'existing-pending' } }));
    assert.throws(() => assertIdle(f.directory), /未决/);
  }
  f.db.prepare('UPDATE online_ledger SET body=?').run(JSON.stringify(f.state));
  for (const table of ['online_ack', 'online_awards']) { f.db.prepare(`INSERT INTO ${table} VALUES(?)`).run('pending'); assert.throws(() => assertIdle(f.directory)); f.db.exec(`DELETE FROM ${table}`); }
  const journal = path.join(f.directory, 'payments', 'coupon-transactions.json'); fs.writeFileSync(journal, JSON.stringify({ one: { finished: false } }));
  const before = fs.readFileSync(journal); assert.throws(() => assertIdle(f.directory), /日志存在未完成/); assert.deepEqual(fs.readFileSync(journal), before);
});

test('SQLite backup API includes live WAL content, creates verified standalone copy, and does not modify original data', async t => {
  const directory = temp(t), source = path.join(directory, 'source.sqlite'), dest = path.join(directory, 'backup.sqlite');
  const db = new DatabaseSync(source); db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE entries(id TEXT, value TEXT)');
  db.prepare('INSERT INTO entries VALUES(?,?)').run('persisted-wal-entry', 'existing-award');
  closers.get(t).push(() => db.close());
  const before = db.prepare('SELECT * FROM entries').all();
  await backupDatabase(source, dest);
  const saved = new DatabaseSync(dest, { readOnly: true });
  try { assert.deepEqual(saved.prepare('SELECT * FROM entries').all(), before); } finally { saved.close(); }
  assert.deepEqual(db.prepare('SELECT * FROM entries').all(), before);
  await assert.rejects(backupDatabase(source, dest), /目标已存在/);
});

test('business backup includes JSON and SQLite but never copies live service locks or WAL sidecar files as the database', async t => {
  const directory = temp(t), source = path.join(directory, 'data'), dest = path.join(directory, 'backup'); fs.mkdirSync(source);
  const db = new DatabaseSync(path.join(source, 'accounts.sqlite')); db.exec('CREATE TABLE users(name TEXT); INSERT INTO users VALUES(\'existing-admin\')'); db.close();
  fs.writeFileSync(path.join(source, 'payment-config.json'), '{"ciphertext":"fixture-only"}'); fs.writeFileSync(path.join(source, 'service.lock'), 'not-a-backup');
  assert.equal(await backupTree(source, dest), 2); assert.deepEqual(fs.readdirSync(dest).sort(), ['accounts.sqlite', 'payment-config.json']);
  assert.equal(fs.readFileSync(path.join(source, 'service.lock'), 'utf8'), 'not-a-backup');
});

test('manifest verification rejects forbidden secret files, traversal and tampered runtime before a service stop', t => {
  const directory = temp(t), names = ['online/server.cjs', 'online/http.cjs', 'online/auth.cjs', 'online/ledger.cjs', 'coupons/server.cjs', 'coupons/http.cjs', 'coupons/store.cjs', 'coupons/catalog-contract.cjs', 'payments/lottery-records.cjs', 'payments/service.cjs', 'src/orderLogic.js', 'src/afterSales.js', 'node_modules/json-source-map/index.js', 'dist/index.html', 'package.json'];
  const files = names.map(name => { const content = name === 'dist/index.html' ? '<script src="/cashier/assets/test.js"></script><link href="/cashier/assets/test.css">' : 'fixture'; const file = path.join(directory, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return { path: name, bytes: Buffer.byteLength(content), sha256: crypto.createHash('sha256').update(content).digest('hex') }; });
  const manifest = { version: 1, kind: 'update-only', id: '20261013-123456abcdef', files }, target = path.join(directory, 'release-manifest.json');
  fs.writeFileSync(target, JSON.stringify(manifest)); assert.equal(verifyManifest(directory).files.length, 15);
  for (const bad of ['setup-grant.json', 'online/service.env', 'online/../config.key']) { fs.writeFileSync(target, JSON.stringify({ ...manifest, files: [{ ...files[0], path: bad }, ...files.slice(1)] })); assert.throws(() => verifyManifest(directory)); }
  fs.writeFileSync(target, JSON.stringify(manifest)); fs.appendFileSync(path.join(directory, 'online/server.cjs'), 'tampered'); assert.throws(() => verifyManifest(directory), /校验失败/);
});

test('activation backs up before switching and never performs account/env/key/database initialization', async () => {
  const calls = [], steps = Object.fromEntries(['before', 'stop', 'verifyStopped', 'verifyIdle', 'backup', 'verifyPreserved', 'switchUnit', 'reload', 'start', 'health', 'restoreUnit'].map(name => [name, async () => { calls.push(name); }]));
  await activateRuntime(steps);
  assert.deepEqual(calls, ['before', 'stop', 'verifyStopped', 'verifyIdle', 'backup', 'verifyPreserved', 'switchUnit', 'reload', 'start', 'health', 'verifyPreserved']);
});

test('failure at every stopped or switched phase restores old code without reverting business data', async () => {
  for (const point of ['before', 'stop', 'verifyStopped', 'verifyIdle', 'backup', 'verifyPreserved', 'switchUnit', 'reload', 'start', 'health']) {
    const calls = []; let failed = false, current = 'old', running = true;
    const steps = Object.fromEntries(['before', 'stop', 'verifyStopped', 'verifyIdle', 'backup', 'verifyPreserved', 'switchUnit', 'reload', 'start', 'health', 'restoreUnit'].map(name => [name, async () => {
      calls.push(name);
      if (name === 'stop') running = false; if (name === 'switchUnit') current = 'new'; if (name === 'restoreUnit') current = 'old'; if (name === 'start') running = true;
      if (!failed && point === name) { failed = true; throw new Error('fixture failure'); }
    }]));
    await assert.rejects(activateRuntime(steps), error => error.rollback === (point === 'before' ? 'not-needed' : 'previous-code-active'), point);
    assert.equal(current, 'old', point); assert.equal(running, true, point);
    assert.ok(!calls.includes('restoreDatabase'), 'rollback must preserve intervening real business data');
    if (point === 'before') assert.deepEqual(calls, ['before']);
  }
});

test('failed rollback reports manual recovery and does not claim healthy completion', async () => {
  const steps = Object.fromEntries(['before', 'stop', 'verifyStopped', 'verifyIdle', 'backup', 'verifyPreserved', 'switchUnit', 'reload', 'start', 'health', 'restoreUnit'].map(name => [name, async () => {}]));
  steps.health = async () => { throw new Error('fixture health failure'); };
  await assert.rejects(activateRuntime(steps), error => error.rollback === 'manual-recovery-required');
});

test('coupon maintenance blocks new checkout through update or rollback and resumes only after operation completes', async () => {
  for (const failure of [null, 'pause', 'verifyIdle', 'coupon-update', 'resume']) {
    let running = true, invoked = false; const calls = [];
    const steps = Object.fromEntries(['before', 'pause', 'verifyStopped', 'verifyIdle', 'resume', 'health'].map(name => [name, async () => {
      calls.push(name); if (name === 'pause') running = false; if (name === 'resume') running = true;
      if (name === failure) throw new Error('fixture barrier failure');
    }]));
    const task = async () => { invoked = true; calls.push('coupon-update'); assert.equal(running, false); if (failure === 'coupon-update') throw new Error('fixture coupon rollback completed'); };
    if (failure) await assert.rejects(withMaintenance(steps, task), error => error.rollback === (failure === 'resume' ? 'manual-recovery-required' : 'not-needed'));
    else await withMaintenance(steps, task);
    assert.equal(running, true); assert.equal(invoked, !['pause', 'verifyIdle'].includes(failure));
    if (invoked) assert.ok(calls.indexOf('resume') > calls.indexOf('coupon-update'));
  }
});
