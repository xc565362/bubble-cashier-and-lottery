const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const [action, cli, destination, businessFile] = process.argv.slice(2);
assert.ok(['enter', 'activate', 'verify'].includes(action) && cli && destination);
const base = path.resolve(destination);
const environment = 'bubble-lottery-500-d8cd9c6a45992';
const read = name => JSON.parse(fs.readFileSync(path.join(base, name), 'utf8'));
const save = (name, value) => fs.writeFileSync(path.join(base, name), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const original = read('cloudbaserc.before.json').functions.find(fn => fn.name === 'lottery');
const management = JSON.parse(original.envVariables.LOTTERY_MANAGEMENT_CENTER_JSON);
const physicalIds = ['cap', 'bucket', 'waist', 'tote'];
const cutoff = Date.parse('2026-09-27T10:00:00Z');
let sequence = 0;
function run(args, label) {
  const r = spawnSync(process.execPath, [cli, '-e', environment, ...args], {
    encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  });
  const file = `${action}-${label}-${Date.now()}-${++sequence}.json`;
  fs.writeFileSync(path.join(base, file), r.stdout || '', { flag: 'wx', mode: 0o600 });
  if (r.status !== 0) {
    save(file + '.error.json', { status: r.status, stderr: r.stderr, error: r.error?.message });
    throw new Error('Cloud command failed; inspect private record ' + file);
  }
  if (args[0] === 'config' && args[1] === 'pull') return null;
  const result = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.ok(!result.error, 'Cloud API returned an error');
  return result;
}
function pull(label) {
  const file = `cloudbaserc.${label}.${Date.now()}.json`;
  run(['config', 'pull', 'fn', 'lottery', '--output', path.join(base, file), '--json'], 'pull');
  const fn = read(file).functions.find(fn => fn.name === 'lottery');
  const { PHYSICAL_CENTER_JSON, ...unchanged } = fn.envVariables;
  assert.deepEqual(unchanged, original.envVariables, 'Other environment variables changed');
  for (const key of ['name', 'type', 'handler', 'timeout', 'runtime', 'memorySize', 'installDependency']) assert.deepEqual(fn[key], original[key]);
  return { file, fn, physical: PHYSICAL_CENTER_JSON ? JSON.parse(PHYSICAL_CENTER_JSON) : null };
}
async function update(current, physical, label) {
  const expected = { ...current.fn.envVariables, PHYSICAL_CENTER_JSON: JSON.stringify(physical) };
  const body = { EnvId: environment, FunctionName: 'lottery', Environment: {
    Variables: Object.entries(expected).map(([Key, Value]) => ({ Key, Value })),
  } };
  run(['api', 'tcb', 'UpdateFunctionConfiguration', '--body', JSON.stringify(body), '--json'], label);
  let detail;
  for (let attempt = 0; attempt < 12; attempt++) {
    detail = run(['fn', 'detail', 'lottery', '--json'], 'status').data;
    assert.ok(!['UpdateFailed', 'Failed', 'CreateFailed'].includes(detail.Status), 'Cloud function update failed');
    if (detail.Status === 'Active') break;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  assert.equal(detail.Status, 'Active');
  assert.equal(detail.AvailableStatus, 'Available');
  assert.equal(detail.Qualifier, '$LATEST');
  assert.equal(detail.Timeout, 60);
  const after = pull(label);
  assert.deepEqual(after.fn.envVariables, expected, 'Environment readback mismatch');
  return after;
}
async function request(route, input) {
  const r = await fetch(new URL(route, management.baseUrl), {
    method: input ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { Authorization: 'Bearer ' + management.adminToken, 'Content-Type': 'application/json' },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
  const result = await r.json();
  assert.ok(r.ok && result.ok, 'Coupon request failed: ' + (result.code || r.status));
  return result.data;
}
async function local(action) {
  const r = await fetch('http://localhost:5173/api/sqb/' + action, { method: 'POST',
    headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20000) });
  const result = await r.json();
  assert.ok(r.ok && result.ok, 'Original cashier unavailable: ' + action);
  return result.data;
}
async function idle() {
  for (const state of ['RESERVED', 'PAYMENT_PENDING']) assert.equal((await request('/v1/coupons?state=' + state)).total, 0, 'Coupon checkout in progress');
  assert.equal((await local('pending')).length, 0, 'Payment in progress');
  const config = await local('coupon-config');
  assert.equal(config.openReservations, 0);
  assert.equal(config.centerId, management.centerId);
  assert.equal((await local('config')).mode, 'production');
}
function verifyFrontend() {
  const before = read('miniprogram-before.manifest.json');
  let count = 0;
  function visit(dir) { for (const item of fs.readdirSync(dir, { withFileTypes: true })) item.isDirectory() ? visit(path.join(dir, item.name)) : count++; }
  visit(before.root);
  assert.equal(count, before.files.length);
  for (const file of before.files) assert.equal(digest(path.join(before.root, file.name)), file.sha256, 'Mini-program frontend changed');
  return count;
}
async function verifyProducts() {
  assert.ok(businessFile, 'Pass the new business backup');
  const directory = path.join(process.env.USERPROFILE, '.stall-cashier-sqb-web');
  const credentials = JSON.parse(fs.readFileSync(path.join(directory, 'credentials.json')));
  const payments = JSON.parse(fs.readFileSync(path.join(directory, 'payments.json')));
  const bundle = JSON.parse(fs.readFileSync(businessFile));
  const { business } = require('../payments/backup.cjs').verifyBackup(bundle, payments, credentials.config, credentials.key.publicKey);
  assert.ok(Date.now() - Date.parse(business.exportedAt) < 2 * 3600000, 'Need a recent business backup');
  const bindings = await local('coupon-physical-bindings');
  const { resolvePhysicalProduct } = require('../coupons/physical-products.cjs');
  const rows = [];
  for (const id of physicalIds) {
    const product = resolvePhysicalProduct(id, business.products);
    const expected = bindings.prizes[id].product;
    for (const key of ['id', 'name', 'sku', 'barcode', 'price', 'productType']) assert.equal(product[key], expected[key]);
    assert.equal(product.price, 0); assert.equal(product.productType, 'gift');
    rows.push({ prizeId: id, id: product.id, sku: product.sku, name: product.name, stock: product.stock });
  }
  if (fs.existsSync(path.join(base, 'business.before.json'))) assert.equal(digest(businessFile), digest(path.join(base, 'business.before.json')));
  else fs.copyFileSync(businessFile, path.join(base, 'business.before.json'), fs.constants.COPYFILE_EXCL);
  if (fs.existsSync(path.join(base, 'product-verification.json'))) assert.deepEqual(read('product-verification.json').products, rows);
  else save('product-verification.json', { at: new Date().toISOString(), exportedAt: business.exportedAt, source: path.resolve(businessFile), signatureVerified: true, products: rows });
}
async function checkDeployedGuard(config) {
  const { createPhysicalCenter } = require(path.join(base, 'code-before/physical-center.cjs'));
  const { campaign, prizes } = require(path.join(base, 'code-before/config.js'));
  const code = '0000000000000001';
  const entry = { campaignId: campaign.id, prize: prizes.find(p => p.id === 'cap'), code, status: 'pending', createdAt: Date.now() - 1000 };
  const entries = new Map([['entries:fixture', entry], ['codes:' + code, { campaignId: campaign.id, entryId: 'fixture' }]]);
  let writes = 0, network = 0;
  const service = createPhysicalCenter({ base: async () => ({ entry }), campaign, prizes, physicalConfig: config,
    adminIds: ['fixture-admin'], entryId: () => 'fixture', now: () => Date.now(),
    store: { transaction: fn => fn({ get: async (table, id) => structuredClone(entries.get(table + ':' + id)), set: async () => { writes++; } }) },
    fetchFn: async () => { network++; throw Error('Live network forbidden in fixture'); },
  });
  await assert.rejects(service('redeem', { code }, 'fixture-admin'), { code: 'POS_REQUIRED' });
  if (config.stage === 'migrating') assert.equal((await service('state', {}, 'fixture')).entry.status, 'unavailable');
  assert.equal(writes, 0); assert.equal(network, 0);
  return { downloadedCodeGuardPassed: true, productionIdentityInvoked: false, liveRedemptions: 0 };
}
async function enter() {
  assert.ok(!fs.existsSync(path.join(base, 'handoff.json')), 'Maintenance already entered; inspect state instead of retrying');
  await idle();
  await verifyProducts();
  verifyFrontend();
  const info = await request('/v1/info');
  assert.equal(info.centerId, management.centerId); assert.equal(info.environment, 'production');
  const campaigns = await request('/v1/campaigns');
  assert.deepEqual(campaigns, read('coupon-campaigns.before.json'), 'Campaigns changed since preflight');
  const snapshot = await local('lottery-snapshot');
  const oldSnapshot = read('lottery-snapshot.before.json');
  for (const key of ['total', 'allocated', 'remaining', 'revision', 'mode', 'prizes']) assert.deepEqual(snapshot[key], oldSnapshot[key], 'Lottery changed since preflight: ' + key);
  const before = pull('immediate-before');
  assert.equal(before.physical, null);
  const physical = JSON.parse(fs.readFileSync(path.join(path.dirname(base), 'server-backup-20260921/physical-center.prepared.json')));
  physical.stage = 'migrating';
  physical.handoffReadyAt = Date.now() + 5 * 60000;
  for (const id of physicalIds) assert.equal(physical.prizes[id].campaignId, management.prizes[id]);
  assert.equal(physical.centerId, management.centerId);
  save('physical-requested.json', physical);
  const guard = await checkDeployedGuard(physical);
  const after = await update(before, physical, 'migrating');
  const readyAt = Math.max(physical.handoffReadyAt, Date.now() + 90000);
  const result = { at: new Date().toISOString(), stage: 'migrating', configFile: after.file, readyAt, readyAtIso: new Date(readyAt).toISOString(), guard, physicalRedemptionEnabled: false };
  save('handoff.json', result);
  console.log(JSON.stringify(result, null, 2));
}
async function activate() {
  const handoff = read('handoff.json');
  assert.ok(Date.now() >= handoff.readyAt, 'Old cloud invocation window has not elapsed');
  await idle(); verifyFrontend();
  const current = pull('before-active');
  assert.deepEqual(current.physical, read('physical-requested.json'));
  assert.equal(current.physical.stage, 'migrating');
  const before = await request('/v1/campaigns');
  assert.deepEqual(before, read('coupon-campaigns.before.json'), 'Campaigns changed during maintenance');
  const next = { ...current.physical, stage: 'active' };
  const guard = await checkDeployedGuard(next);
  const after = await update(current, next, 'active');
  const completed = [];
  try {
    for (const id of physicalIds) {
      const c = before.find(row => row.id === next.prizes[id].campaignId);
      assert.ok(c.enabled && c.redemptionEnabled === false);
      assert.equal(Date.parse(c.redemptionEndsAt), cutoff);
      const result = await request('/v1/campaigns/status', { id: c.id, enabled: c.enabled, redemptionEnabled: true, requestId: 'physical-cutover-20260922-enable-' + id });
      save('enabled-' + id + '.json', result);
      completed.push(id);
    }
  } catch (error) {
    // Fail closed on any uncertain or partial campaign activation; never restore the legacy phone path.
    const failures = [];
    for (const id of physicalIds) {
      const c = before.find(row => row.id === next.prizes[id].campaignId);
      try { await request('/v1/campaigns/status', { id: c.id, enabled: c.enabled, redemptionEnabled: false, requestId: 'physical-cutover-20260922-pause-' + id }); }
      catch { failures.push(id); }
    }
    save('activation-failed.json', { at: new Date().toISOString(), completed, pauseFailures: failures, message: error.message });
    throw new Error('Activation incomplete; inspect private activation-failed.json. Legacy phone path remains disabled.');
  }
  save('activation.json', { at: new Date().toISOString(), configFile: after.file, stage: 'active', completed, guard });
  await verify();
}
async function verify() {
  const current = pull('verified');
  assert.equal(current.physical.stage, 'active');
  const expected = { ...read('physical-requested.json'), stage: 'active' };
  assert.deepEqual(current.physical, expected);
  const campaigns = await request('/v1/campaigns');
  const before = read('coupon-campaigns.before.json');
  assert.equal(campaigns.length, before.length);
  for (const old of before) {
    const row = campaigns.find(c => c.id === old.id);
    const isPhysical = physicalIds.some(id => expected.prizes[id].campaignId === old.id);
    assert.deepEqual(row, isPhysical ? { ...old, redemptionEnabled: true } : old, 'Unexpected campaign changes');
  }
  save('coupon-campaigns.verified.json', campaigns);
  const snapshot = await local('lottery-snapshot');
  const originalSnapshot = read('lottery-snapshot.before.json');
  assert.ok(!snapshot.centerError);
  assert.equal(snapshot.endsAt, cutoff); assert.equal(snapshot.redemptionEndsAt, cutoff);
  for (const key of ['total', 'allocated', 'remaining', 'revision', 'mode', 'prizes']) assert.deepEqual(snapshot[key], originalSnapshot[key], 'Lottery configuration or activity changed: ' + key);
  for (const id of physicalIds) assert.equal(snapshot.center.prizes[id].redemptionEnabled, true);
  save('lottery-snapshot.verified.json', snapshot);
  const tables = {};
  for (const table of ['lottery_entries', 'lottery_codes', 'lottery_pools']) {
    const command = JSON.stringify([{ TableName: table, CommandType: 'QUERY', Command: JSON.stringify({ find: table, filter: {}, limit: 10000 }) }]);
    const result = run(['db', 'nosql', 'execute', '--command', command, '--json'], table).data.results[0];
    const old = read(table + '.raw.json').data.results[0];
    const sort = rows => rows.sort((a, b) => a._id.localeCompare(b._id));
    assert.deepEqual(sort(result), sort(old), 'Business data changed; check activity in ' + table);
    tables[table] = { count: result.length, unchanged: true };
  }
  const directory = path.join(process.env.USERPROFILE, '.stall-cashier-sqb-web');
  for (const name of ['credentials.json', 'merchant-key.json', 'payments.json', 'physical-product-bindings.json', 'coupon-connection.json', 'coupon-transactions.json'])
    assert.equal(digest(path.join(directory, name)), digest(path.join(base, 'local-data-before', name)), 'Local merchant or transactions changed: ' + name);
  const frontendFiles = verifyFrontend();
  const report = { at: new Date().toISOString(), activated: true, physicalCampaignsEnabled: 4, frontendFilesUnchanged: frontendFiles,
    configFile: current.file, originalMerchantAndTransactionsUnchanged: true, tables,
    pool: { total: snapshot.total, allocated: snapshot.allocated, remaining: snapshot.remaining, revision: snapshot.revision, mode: snapshot.mode },
    cutoffBeijing: '2026-09-27 18:00', historicalBatchMigration: false, realDeviceAcceptanceCompleted: false, realTransactionsByThisOperation: 0 };
  save('cutover-verified.json', report);
  console.log(JSON.stringify(report, null, 2));
}
({ enter, activate, verify })[action]().catch(error => { console.error(error.message); process.exitCode = 1; });
