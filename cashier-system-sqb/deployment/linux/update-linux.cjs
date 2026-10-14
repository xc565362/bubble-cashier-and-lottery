'use strict';
// Update an existing verified systemd service. Never initialize accounts, keys,
// config, nginx, or business data. Rollback switches code only; DB backups are
// retained privately and are never blindly restored over intervening business.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { DatabaseSync, backup } = require('node:sqlite');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const regular = file => { const st = fs.lstatSync(file); if (!st.isFile() || st.isSymbolicLink()) fail('UNSAFE_FILE', '需要普通文件，不能是链接'); return st; };
function read(file) { regular(file); return fs.readFileSync(file); }
function verifyManifest(source) {
  const manifest = JSON.parse(read(path.join(source, 'release-manifest.json')));
  if (manifest.kind !== 'update-only' || manifest.version !== 1 || !/^\d{8}-[a-f0-9]{12}$/.test(manifest.id || '') || !Array.isArray(manifest.files) || manifest.files.length < 15 || manifest.files.length > 500) fail('INVALID_RELEASE', '升级包清单不正确');
  const names = new Set();
  for (const item of manifest.files) {
    if (!/^[A-Za-z0-9_.\/-]+$/.test(item.path || '') || item.path.split('/').some(part => !part || part === '..' || part.startsWith('.')) || path.isAbsolute(item.path) || names.has(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256 || '')) fail('INVALID_RELEASE', '升级包路径或校验值不正确');
    if (!/^(?:dist\/|online\/|payments\/|coupons\/|src\/(?:orderLogic|afterSales)\.js$|node_modules\/json-source-map\/|package\.json$|update-linux\.cjs$)/.test(item.path) || /(?:setup-grant|service\.env|\.sqlite|\.pem|config\.key|install-linux|bootstrap|provision-connections)/.test(item.path)) fail('INVALID_RELEASE', '升级包包含不允许的文件');
    names.add(item.path);
    const file = path.join(source, item.path);
    if (!fs.realpathSync(file).startsWith(fs.realpathSync(source) + path.sep) || hash(read(file)) !== item.sha256 || fs.statSync(file).size !== item.bytes) fail('INVALID_RELEASE', '升级包内容校验失败');
  }
  for (const required of ['online/server.cjs', 'online/http.cjs', 'coupons/server.cjs', 'coupons/http.cjs', 'coupons/store.cjs', 'payments/lottery-records.cjs', 'src/orderLogic.js', 'src/afterSales.js', 'node_modules/json-source-map/index.js', 'dist/index.html']) if (!names.has(required)) fail('INVALID_RELEASE', '升级包缺少运行文件');
  const index = read(path.join(source, 'dist/index.html')).toString();
  if (!index.includes('src="/cashier/assets/') || !index.includes('href="/cashier/assets/')) fail('INVALID_RELEASE', '在线页面基础地址不正确');
  return manifest;
}
function environment(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim(); if (!value || value.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(value);
    if (!match || Object.hasOwn(result, match[1])) fail('INVALID_ENV', '现有环境文件格式不支持，请人工核对');
    let entry = match[2];
    if ((entry.startsWith('"') && entry.endsWith('"')) || (entry.startsWith("'") && entry.endsWith("'"))) entry = entry.slice(1, -1);
    if (/[\r\n\u0000]/.test(entry)) fail('INVALID_ENV', '环境文件值无效');
    result[match[1]] = entry;
  }
  return result;
}
function rewriteUnit(current, { expectedRelease, release, node, target, envFile }) {
  for (const value of [expectedRelease, release, node, envFile]) if (!/^\/[A-Za-z0-9_./-]+$/.test(value || '') || value.includes('/../')) fail('INVALID_PLAN', '服务路径不正确');
  if (!['online', 'coupon'].includes(target)) fail('INVALID_PLAN', '服务类型不正确');
  const entry = target === 'online' ? 'online/server.cjs' : 'coupons/server.cjs';
  const lines = current.split(/\r?\n/), matches = key => lines.map((line, index) => ({ line, index })).filter(item => item.line.startsWith(key + '='));
  const working = matches('WorkingDirectory'), start = matches('ExecStart'), env = matches('EnvironmentFile');
  if (working.length !== 1 || start.length !== 1 || env.length !== 1 || working[0].line !== `WorkingDirectory=${expectedRelease}` || env[0].line !== `EnvironmentFile=${envFile}` ||
      ![`${node} ${entry}`, `${node} ${expectedRelease}/${entry}`].includes(start[0].line.slice('ExecStart='.length))) fail('UNIT_CHANGED', '现有服务配置与预期不符，未修改服务');
  lines[working[0].index] = `WorkingDirectory=${release}`;
  lines[start[0].index] = `ExecStart=${node} ${entry}`;
  return lines.join('\n');
}
// This is an explicit profile for the inspected pre-existing production unit,
// not a general-purpose systemd merger. Existing overrides remain untouched.
const couponDropInDirectory = '/etc/systemd/system/bubble-coupons.service.d';
const couponDropInProfile = [
  ['73-cashier-runtime.conf', '/usr/local/bin/node /opt/bubble/cashier-system-0.7.3/coupons/server.cjs'],
  ['76-lottery-management.conf', '/usr/local/bin/node /opt/bubble/cashier-system-0.7.6/coupons/server.cjs'],
  ['77-redemption-deadline.conf', '/usr/local/bin/node /opt/bubble/cashier-system-0.7.6-deadline/coupons/server.cjs'],
  ['zz-h5-catalog-mv64ca07.conf', '/opt/node-v24.19.0-linux-x64/bin/node /opt/bubble/cashier-system-h5-20261013/coupons/server.cjs'],
];
function serviceLines(text, dropIn = false) {
  let section = '', count = 0; const result = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || /^[#;]/.test(line)) continue;
    if (/^\[[A-Za-z]+\]$/.test(line)) {
      section = line.slice(1, -1); if (section === 'Service') count++;
      if (!(dropIn ? ['Service'] : ['Unit', 'Service', 'Install']).includes(section)) fail('UNIT_CHANGED', '服务分段不符合已核对配置');
    } else {
      if (!section || /\\$/.test(line)) fail('UNIT_CHANGED', '服务配置格式不符合已核对配置');
      if (section === 'Service') result.push(line);
    }
  }
  if (count !== 1) fail('UNIT_CHANGED', '服务分段不符合已核对配置');
  return result;
}
function assertEffectiveCoupon(properties, { paths, workingDirectory, node, script, envFile }) {
  const prefix = `{ path=${node} ; argv[]=${node} ${script} ; ignore_errors=no ; `;
  if (properties.FragmentPath !== '/etc/systemd/system/bubble-coupons.service' || properties.DropInPaths !== paths.join(' ') ||
      properties.WorkingDirectory !== workingDirectory || properties.EnvironmentFiles !== `${envFile} (ignore_errors=no)` ||
      properties.User !== 'bubble-coupons' || properties.Group !== 'bubble-coupons' ||
      !properties.ExecStart.startsWith(prefix) || !properties.ExecStart.endsWith(' }') || (properties.ExecStart.match(/[{}]/g) || []).length !== 2) fail('UNIT_CHANGED', '券中心有效配置与已核对配置不一致');
}
function planCouponDropIn({ current, dropIns, effective, unit, expectedRelease, release, node, envFile, id }) {
  if (unit !== 'bubble-coupons.service' || expectedRelease !== '/opt/bubble/cashier-system-h5-20261013' ||
      node !== '/opt/node-v24.19.0-linux-x64/bin/node' || envFile !== '/var/lib/bubble-coupons/deployment/coupon.env' ||
      !/^\d{8}-[a-f0-9]{12}$/.test(id || '') || release !== `/opt/bubble/coupon-center-${id}`) fail('INVALID_PLAN', '券中心覆盖配置仅支持已核对的部署');
  const expected = ['Type=simple', 'User=bubble-coupons', 'Group=bubble-coupons', 'WorkingDirectory=/opt/bubble', `EnvironmentFile=${envFile}`,
    'ExecStart=/usr/local/bin/node /opt/bubble/cashier-system-0.7.0/coupons/server.cjs', 'Restart=on-failure', 'RestartSec=3', 'UMask=0077',
    'NoNewPrivileges=true', 'PrivateTmp=true', 'ProtectHome=true', 'ProtectSystem=strict', 'ReadWritePaths=/var/lib/bubble-coupons', 'TimeoutStopSec=30'];
  if (JSON.stringify(serviceLines(current).sort()) !== JSON.stringify(expected.sort()) || dropIns.length !== couponDropInProfile.length) fail('UNIT_CHANGED', '券中心基础配置与已核对配置不一致');
  couponDropInProfile.forEach(([name, command], index) => {
    if (dropIns[index].path !== `${couponDropInDirectory}/${name}` || JSON.stringify(serviceLines(dropIns[index].bytes.toString(), true)) !== JSON.stringify(['ExecStart=', `ExecStart=${command}`])) fail('UNIT_CHANGED', '券中心已有覆盖配置与已核对配置不一致');
  });
  const paths = dropIns.map(item => item.path), script = `${expectedRelease}/coupons/server.cjs`;
  const prior = { paths, workingDirectory: '/opt/bubble', node, script, envFile };
  assertEffectiveCoupon(effective, prior);
  const file = `${couponDropInDirectory}/zzzz-codex-lottery-${id}.conf`;
  if (paths.some(existing => existing >= file)) fail('UNIT_CHANGED', '新增覆盖文件不是最后的启动配置');
  return { file, bytes: Buffer.from(`[Service]\nWorkingDirectory=${release}\nExecStart=\nExecStart=${node} ${release}/coupons/server.cjs\n`),
    prior, next: { ...prior, paths: [...paths, file], workingDirectory: release, script: `${release}/coupons/server.cjs` } };
}
function rootDirectory(directory) {
  const st = fs.lstatSync(directory);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) || fs.realpathSync(directory) !== directory) fail('UNSAFE_DIRECTORY', '升级目录必须为 root 管理且不能是链接或允许其他用户写入');
}
function createOwnedDropIn(file, bytes, created = () => {}) {
  const fd = fs.openSync(file, 'wx', 0o644);
  try { created(); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (process.platform !== 'win32') { const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
}
function removeOwnedDropIn(file, bytes) {
  if (!fs.existsSync(file)) return;
  if (hash(read(file)) !== hash(bytes)) fail('ROLLBACK_CONFIG_CHANGED', '新增覆盖文件被修改，未删除，请人工恢复');
  fs.unlinkSync(file);
  if (process.platform !== 'win32') { const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
}
function systemdProperties(unit) {
  return Object.fromEntries(['FragmentPath', 'DropInPaths', 'WorkingDirectory', 'ExecStart', 'EnvironmentFiles', 'User', 'Group'].map(key => [key, run('systemctl', ['show', unit, `--property=${key}`, '--value'])]));
}
function verifyDropInFiles(plan, dropIns, allowNew = false) {
  rootDirectory(couponDropInDirectory);
  const names = dropIns.map(item => path.basename(item.path));
  if (allowNew) names.push(path.basename(plan.file));
  if (JSON.stringify(fs.readdirSync(couponDropInDirectory).sort()) !== JSON.stringify(names.sort())) fail('PRECONDITION_CHANGED', '券中心覆盖目录的文件列表发生变化');
  for (const item of dropIns) {
    const st = regular(item.path);
    if (st.uid !== 0 || (st.mode & 0o022) || hash(read(item.path)) !== hash(item.bytes)) fail('PRECONDITION_CHANGED', '已有服务覆盖配置内容或权限发生变化');
  }
  if (allowNew && hash(read(plan.file)) !== hash(plan.bytes)) fail('PRECONDITION_CHANGED', '新增覆盖配置内容发生变化');
}
function assertIdle(directory, now = Date.now()) {
  const file = path.join(directory, 'ledger.sqlite'); regular(file);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    const row = db.prepare('SELECT body FROM online_ledger WHERE id=1').get();
    const state = JSON.parse(row.body), leaseRow = db.prepare('SELECT body FROM online_lease WHERE id=1').get();
    const lease = leaseRow && JSON.parse(leaseRow.body);
    if (lease?.expiresAt > now || state.pendingPayment || state.pendingAdjustment || state.pendingRestore || state.pendingZero || state.pendingCouponReservation ||
        db.prepare('SELECT count(*) n FROM online_ack').get().n || db.prepare('SELECT count(*) n FROM online_awards').get().n) fail('BUSINESS_BUSY', '收银存在使用权限或未决交易，请完成并释放后再升级');
    for (const [name, unfinished] of [['payments.json', value => !value.acknowledged && value.state !== 'failed'], ['coupon-transactions.json', value => !value.finished]]) {
      const current = path.join(directory, 'payments', name);
      if (fs.existsSync(current) && Object.values(JSON.parse(read(current))).some(unfinished)) fail('BUSINESS_BUSY', '支付或券处理日志存在未完成记录，未执行升级');
    }
    return { products: state.products.length, orders: state.orders.length, idle: true };
  } finally { db.close(); }
}
async function backupDatabase(from, to) {
  regular(from); if (fs.existsSync(to)) fail('BACKUP_EXISTS', '备份目标已存在');
  const db = new DatabaseSync(from, { readOnly: true });
  try { await backup(db, to); } finally { db.close(); }
  fs.chmodSync(to, 0o600);
  const check = new DatabaseSync(to, { readOnly: true });
  try { if (Object.values(check.prepare('PRAGMA quick_check').get())[0] !== 'ok') fail('BACKUP_INVALID', '数据库备份校验失败'); } finally { check.close(); }
}
async function backupTree(from, to) {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 }); let count = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (/^\.migration-backup-/.test(entry.name) || /(?:-wal|-shm)$/.test(entry.name) || entry.name === 'service.lock') continue;
    const source = path.join(from, entry.name), dest = path.join(to, entry.name);
    if (entry.isSymbolicLink()) fail('UNSAFE_FILE', '数据目录含链接，未继续升级');
    if (entry.isDirectory()) count += await backupTree(source, dest);
    else if (entry.isFile()) {
      if (entry.name.endsWith('.sqlite')) await backupDatabase(source, dest);
      else { fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL); fs.chmodSync(dest, 0o600); }
      count++;
    } else fail('UNSAFE_FILE', '数据目录含非普通文件');
  }
  return count;
}
function atomic(file, bytes, mode = 0o644) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`, fd = fs.openSync(temp, 'wx', mode);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function probe(route, host, port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: route, headers: { Host: host }, timeout: 3000 }, response => {
      let body = ''; response.setEncoding('utf8');
      response.on('data', value => { body += value; if (body.length > 8192) request.destroy(new Error('Probe too large')); });
      response.on('end', () => { try { resolve({ status: response.statusCode, value: JSON.parse(body) }); } catch { reject(new Error('Probe malformed')); } });
    });
    request.on('timeout', () => request.destroy(new Error('Probe timed out'))); request.on('error', reject);
  });
}
async function health(target, origin, port) {
  const host = new URL(origin).host;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const ok = await probe('/healthz', host, port);
      const denied = await probe(target === 'online' ? '/api/online/ledger' : '/v1/info', host, port);
      if (ok.status === 200 && (target === 'online' ? ok.value.service === 'bubble-online-cashier' : ok.value.service === 'stall-coupon-center') && denied.status === 401) return true;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  fail('HEALTH_FAILED', '服务启动或未登录保护检查失败');
}
function run(file, args) { try { return execFileSync(file, args, { encoding: 'utf8', stdio: 'pipe' }).trim(); } catch { fail('SYSTEM_COMMAND_FAILED', '系统服务操作未完成，请检查服务状态'); } }
async function activateRuntime(steps) {
  let stopped = false, switched = false;
  try {
    await steps.before();
    // An unsuccessful systemctl/rename call can already have changed state.
    // Arm recovery before attempting either mutation.
    stopped = true; await steps.stop();
    await steps.verifyStopped(); await steps.verifyIdle(); await steps.backup(); await steps.verifyPreserved();
    switched = true; await steps.switchUnit();
    await steps.reload(); await steps.start(); await steps.health(); await steps.verifyPreserved();
  } catch (error) {
    let rollback = 'not-needed';
    if (stopped) {
      try {
        if (switched) { await steps.stop(); await steps.restoreUnit(); await steps.reload(); }
        await steps.start(); await steps.health(); rollback = 'previous-code-active';
      } catch { rollback = 'manual-recovery-required'; }
    }
    error.rollback = rollback; throw error;
  }
}
async function withMaintenance(steps, task) {
  let paused = false, result, issue;
  try {
    await steps.before(); paused = true;
    await steps.pause(); await steps.verifyStopped(); await steps.verifyIdle();
    result = await task();
  } catch (error) { issue = error; }
  if (paused) {
    try { await steps.resume(); await steps.health(); if (issue) issue.maintenanceRestored = true; }
    catch { if (!issue) issue = Object.assign(new Error('Maintenance recovery failed'), { code: 'MAINTENANCE_RECOVERY_FAILED' }); issue.rollback = 'manual-recovery-required'; issue.maintenanceRestored = false; }
  }
  if (issue) { issue.rollback ||= 'not-needed'; throw issue; }
  return result;
}
async function update(options) {
  if (process.platform !== 'linux' || Number(process.versions.node.split('.')[0]) < 24) fail('PLATFORM', '需要 Linux 和 Node.js 24');
  if (process.getuid() !== 0) fail('ROOT_REQUIRED', '请通过 sudo 运行只读计划或升级');
  const { source, target = 'online', expectedRelease, apply = false } = options;
  const unit = options.unit || (target === 'online' ? 'bubble-online.service' : '');
  if (!/^[a-zA-Z0-9_-]+\.service$/.test(unit) || !['online', 'coupon'].includes(target)) fail('INVALID_PLAN', '请提供确切的现有服务名称');
  const envFile = options.envFile || (target === 'online' ? '/etc/bubble-online/service.env' : '');
  if (!/^\/(?:etc|opt|var)\/[A-Za-z0-9_./-]+$/.test(envFile) || !/^\/opt\/bubble\/[A-Za-z0-9_-]+$/.test(expectedRelease || '')) fail('INVALID_PLAN', '需要明确核对现有程序和环境路径');
  const manifest = verifyManifest(fs.realpathSync(source)), release = `/opt/bubble/${target === 'online' ? 'cashier-online' : 'coupon-center'}-${manifest.id}`;
  const envBytes = read(envFile), env = environment(envBytes.toString()), node = options.node || '/usr/local/bin/node';
  const dataDir = target === 'online' ? env.BUBBLE_ONLINE_DATA_DIR : env.COUPON_DATA_DIR;
  const origin = target === 'online' ? env.PUBLIC_ORIGIN : options.origin;
  const parsed = new URL(origin);
  if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password || env.HOST !== '127.0.0.1' || Number(env.PORT) !== (target === 'online' ? 5175 : 3910) || !/^\/var\/[A-Za-z0-9_./-]+$/.test(dataDir || '') || fs.realpathSync(dataDir) !== dataDir) fail('INVALID_ENV', '现有端口、数据目录或入口与部署预期不符');
  regular(node);
  const fragment = run('systemctl', ['show', unit, '--property=FragmentPath', '--value']);
  const dropInPaths = run('systemctl', ['show', unit, '--property=DropInPaths', '--value']);
  if (fragment !== `/etc/systemd/system/${unit}`) fail('UNIT_CHANGED', '服务配置路径变化，需人工核对');
  const priorUnit = read(fragment); let nextUnit, dropInPlan, dropIns = [], dropInOwned = false;
  if (options.couponDropInProfile) {
    if (target !== 'coupon' || options.couponDropInProfile !== 'h5-20261013') fail('INVALID_PLAN', '券中心覆盖配置名称不正确');
    for (const directory of ['/etc', '/etc/systemd', '/etc/systemd/system', couponDropInDirectory, '/opt', '/opt/bubble', '/var/lib/bubble-online-deploy-backups']) rootDirectory(directory);
    const expectedPaths = couponDropInProfile.map(([name]) => `${couponDropInDirectory}/${name}`);
    if (dropInPaths !== expectedPaths.join(' ')) fail('UNIT_CHANGED', '券中心已有覆盖文件列表与已核对配置不一致');
    dropIns = expectedPaths.map(file => ({ path: file, bytes: read(file) }));
    dropInPlan = planCouponDropIn({ current: priorUnit.toString(), dropIns, effective: systemdProperties(unit), unit, expectedRelease, release, node, envFile, id: manifest.id });
    if (fs.existsSync(dropInPlan.file)) fail('RELEASE_EXISTS', '本次覆盖文件已经存在，请核对之前执行结果');
    verifyDropInFiles(dropInPlan, dropIns);
  } else {
    if (dropInPaths) fail('UNIT_CHANGED', '服务配置存在未经核对的覆盖，需人工核对');
    nextUnit = rewriteUnit(priorUnit.toString(), { expectedRelease, release, node, target, envFile });
  }
  const verifyExistingUnits = () => {
    if (hash(read(fragment)) !== hash(priorUnit) || dropIns.some(item => hash(read(item.path)) !== hash(item.bytes))) fail('PRECONDITION_CHANGED', '已有服务配置发生变化，未覆盖或删除原配置');
    if (dropInPlan) verifyDropInFiles(dropInPlan, dropIns, dropInOwned && fs.existsSync(dropInPlan.file));
  };
  if (run('systemctl', ['is-active', unit]) !== 'active') fail('SERVICE_NOT_ACTIVE', '现有服务未在运行，未执行升级');
  const onlineDataDir = '/var/lib/bubble-online';
  const ledger = assertIdle(onlineDataDir);
  if (target === 'online') {
    if (dataDir !== onlineDataDir || env.BUBBLE_ONLINE_KEY_FILE !== '/etc/bubble-online/keys/config.key') fail('INVALID_ENV', '现有在线数据或密钥路径与预期不符');
    regular(env.BUBBLE_ONLINE_KEY_FILE); regular(path.join(dataDir, 'accounts.sqlite'));
  } else regular(path.join(dataDir, 'coupons.sqlite'));
  const keyFile = '/etc/bubble-online/keys/config.key', keyBytes = read(keyFile);
  let maintenance;
  if (target === 'coupon') {
    const onlineUnitFile = '/etc/systemd/system/bubble-online.service', onlineEnvFile = '/etc/bubble-online/service.env';
    if (run('systemctl', ['show', 'bubble-online.service', '--property=FragmentPath', '--value']) !== onlineUnitFile ||
        run('systemctl', ['show', 'bubble-online.service', '--property=DropInPaths', '--value']) || run('systemctl', ['is-active', 'bubble-online.service']) !== 'active') fail('UNIT_CHANGED', '在线收银服务须先完成身份核对并正常运行');
    const unitBytes = read(onlineUnitFile), onlineEnvBytes = read(onlineEnvFile), onlineEnv = environment(onlineEnvBytes.toString());
    const prior = /^WorkingDirectory=(\/opt\/bubble\/cashier-online-[a-zA-Z0-9-]+)$/m.exec(unitBytes.toString())?.[1];
    if (!prior || onlineEnv.BUBBLE_ONLINE_DATA_DIR !== onlineDataDir || onlineEnv.PORT !== '5175' || onlineEnv.HOST !== '127.0.0.1' || new URL(onlineEnv.PUBLIC_ORIGIN).origin !== onlineEnv.PUBLIC_ORIGIN || !onlineEnv.PUBLIC_ORIGIN.startsWith('https://')) fail('INVALID_ENV', '在线收银维护屏障配置未通过核对');
    rewriteUnit(unitBytes.toString(), { expectedRelease: prior, release: prior, node, target: 'online', envFile: onlineEnvFile });
    maintenance = { unitBytes, onlineEnvBytes, onlineUnitFile, onlineEnvFile, origin: onlineEnv.PUBLIC_ORIGIN };
  }
  const plan = { target, unit, priorRelease: expectedRelease, release, dataDir, maintenanceUnit: maintenance ? 'bubble-online.service' : null, unitUpdate: dropInPlan ? 'new-final-drop-in' : 'replace-runtime-directives', newDropIn: dropInPlan?.file || null, preservesExistingDropIns: Boolean(dropInPlan), preservesEnvironment: true, preservesKeys: true, createsAccounts: false, restoresDatabasesOnRollback: false, ledger, manifestFiles: manifest.files.length };
  if (!apply) { console.log(JSON.stringify({ ...plan, status: 'dry-run' }, null, 2)); return plan; }
  if (fs.existsSync(release)) fail('RELEASE_EXISTS', '目标版本目录已存在，请核对之前执行结果后使用新的升级包');
  const backupDir = `/var/lib/bubble-online-deploy-backups/update-${manifest.id}-${target}-${Date.now()}`;
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(backupDir, unit), priorUnit, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(backupDir, 'service.env'), envBytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(backupDir, 'config.key'), keyBytes, { flag: 'wx', mode: 0o600 });
  if (dropInPlan) {
    fs.mkdirSync(path.join(backupDir, 'unit-drop-ins'), { mode: 0o700 });
    for (const item of dropIns) fs.writeFileSync(path.join(backupDir, 'unit-drop-ins', path.basename(item.path)), item.bytes, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(backupDir, 'drop-in-recovery.json'), JSON.stringify({ created: dropInPlan.file, sha256: hash(dropInPlan.bytes), originalDropIns: dropIns.map(item => ({ path: item.path, sha256: hash(item.bytes) })), prior: dropInPlan.prior }, null, 2), { flag: 'wx', mode: 0o600 });
  }
  if (maintenance) { fs.writeFileSync(path.join(backupDir, 'bubble-online.service'), maintenance.unitBytes, { flag: 'wx', mode: 0o600 }); fs.writeFileSync(path.join(backupDir, 'online-service.env'), maintenance.onlineEnvBytes, { flag: 'wx', mode: 0o600 }); }
  fs.mkdirSync(release, { mode: 0o755 });
  for (const item of manifest.files) { const dest = path.join(release, item.path); fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 }); fs.copyFileSync(path.join(source, item.path), dest, fs.constants.COPYFILE_EXCL); fs.chmodSync(dest, 0o644); }
  fs.copyFileSync(path.join(source, 'release-manifest.json'), path.join(release, 'release-manifest.json'), fs.constants.COPYFILE_EXCL);
  verifyManifest(release);
  try {
    const activate = () => activateRuntime({
      before() {
        if (hash(read(envFile)) !== hash(envBytes) || hash(read(keyFile)) !== hash(keyBytes)) fail('PRECONDITION_CHANGED', '准备期间配置已变化，未停止服务');
        verifyExistingUnits();
        if (dropInPlan) { rootDirectory(couponDropInDirectory); if (fs.existsSync(dropInPlan.file)) fail('PRECONDITION_CHANGED', '准备期间出现同名覆盖配置'); assertEffectiveCoupon(systemdProperties(unit), dropInPlan.prior); }
        assertIdle(onlineDataDir);
      },
      stop: () => run('systemctl', ['stop', unit]),
      verifyStopped() { if (run('systemctl', ['show', unit, '--property=ActiveState', '--value']) !== 'inactive') fail('STOP_FAILED', '服务未完全停止'); },
      verifyIdle: () => assertIdle(onlineDataDir),
      async backup() { const files = await backupTree(dataDir, path.join(backupDir, 'data')); fs.writeFileSync(path.join(backupDir, 'backup-complete.json'), JSON.stringify({ files, completedAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' }); },
      verifyPreserved() {
        if (hash(read(envFile)) !== hash(envBytes) || hash(read(keyFile)) !== hash(keyBytes)) fail('PRESERVATION_FAILED', '环境或密钥完整性核对失败');
        if (dropInPlan) verifyExistingUnits();
      },
      switchUnit() {
        if (dropInPlan) { verifyExistingUnits(); assertEffectiveCoupon(systemdProperties(unit), dropInPlan.prior); createOwnedDropIn(dropInPlan.file, dropInPlan.bytes, () => { dropInOwned = true; }); }
        else atomic(fragment, nextUnit);
      },
      restoreUnit() {
        if (dropInPlan) { verifyExistingUnits(); if (dropInOwned) { removeOwnedDropIn(dropInPlan.file, dropInPlan.bytes); dropInOwned = false; } }
        else atomic(fragment, priorUnit);
      },
      reload: () => run('systemctl', ['daemon-reload']), start: () => run('systemctl', ['start', unit]),
      async health() {
        if (dropInPlan) { verifyExistingUnits(); assertEffectiveCoupon(systemdProperties(unit), fs.existsSync(dropInPlan.file) ? dropInPlan.next : dropInPlan.prior); }
        await health(target, origin, Number(env.PORT));
      },
    });
    if (maintenance) await withMaintenance({
      before() { if (hash(read(maintenance.onlineUnitFile)) !== hash(maintenance.unitBytes) || hash(read(maintenance.onlineEnvFile)) !== hash(maintenance.onlineEnvBytes) || hash(read(keyFile)) !== hash(keyBytes)) fail('PRECONDITION_CHANGED', '在线收银服务配置已变化，未进入维护'); assertIdle(onlineDataDir); },
      pause: () => run('systemctl', ['stop', 'bubble-online.service']),
      verifyStopped() { if (run('systemctl', ['show', 'bubble-online.service', '--property=ActiveState', '--value']) !== 'inactive') fail('STOP_FAILED', '在线收银未完全停止，未升级券中心'); },
      verifyIdle: () => assertIdle(onlineDataDir),
      resume: () => run('systemctl', ['start', 'bubble-online.service']),
      health: () => health('online', maintenance.origin, 5175),
    }, activate);
    else await activate();
    const result = { ...plan, status: 'updated', backupDir, health: true, unauthenticatedStatus: 401 };
    fs.writeFileSync(path.join(backupDir, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify(result, null, 2)); return result;
  } catch (error) {
    const rollback = error.rollback || 'manual-recovery-required';
    fs.writeFileSync(path.join(backupDir, 'failure.json'), JSON.stringify({ code: error.code || 'UPDATE_FAILED', rollback, backupDir }), { mode: 0o600 });
    fail(rollback === 'manual-recovery-required' ? 'ROLLBACK_FAILED' : 'UPDATE_FAILED', `升级未完成；${rollback === 'previous-code-active' ? '已恢复原程序并通过健康检查' : rollback === 'not-needed' ? '原服务未停止' : '请检查服务恢复状态'}。数据库未被回写覆盖。备份：${backupDir}`);
  }
}
function parseArgs(args) {
  const result = {}; const names = { '--source': 'source', '--target': 'target', '--unit': 'unit', '--expected-release': 'expectedRelease', '--env-file': 'envFile', '--origin': 'origin', '--node': 'node', '--coupon-drop-in-profile': 'couponDropInProfile' };
  for (let i = 0; i < args.length; i++) { if (args[i] === '--apply') { result.apply = true; continue; } if (!names[args[i]] || !args[i + 1] || args[i + 1].startsWith('--')) fail('INVALID_ARGS', '命令参数不正确'); result[names[args[i]]] = args[++i]; }
  return result;
}
if (require.main === module) update(parseArgs(process.argv.slice(2))).catch(error => { console.error(JSON.stringify({ ok: false, code: error.code || 'UPDATE_FAILED', message: error.code ? error.message : '升级未完成，请检查私密备份与服务状态' })); process.exitCode = 1; });
module.exports = { verifyManifest, environment, rewriteUnit, serviceLines, assertEffectiveCoupon, planCouponDropIn, createOwnedDropIn, removeOwnedDropIn, rootDirectory, assertIdle, backupDatabase, backupTree, parseArgs, activateRuntime, withMaintenance, health, update };
