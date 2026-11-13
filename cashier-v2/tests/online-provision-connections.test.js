import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateConnections, readPrivateJson, provisionConnections, main } = require('../online/provision-connections.cjs');
const { createService } = require('../payments/service.cjs');
const { createServerProtector } = require('../online/secrets.cjs');
const centerId = '10000000-0000-4000-8000-000000000001';
const secrets = { admin: 'c'.repeat(64), cashier: 'd'.repeat(64) };
const config = () => ({ coupon: { baseUrl: 'https://coupons.example.test', adminToken: secrets.admin } });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-provision-test-'));
  t.after(() => { const resolved = path.resolve(directory); assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase()); assert.match(path.basename(resolved), /^bubble-provision-test-/); fs.rmSync(resolved, { recursive: true, force: true }); });
  return { directory, keyFile: path.join(directory, 'server.key'), file: path.join(directory, 'connections.json'), write(value = config()) { fs.writeFileSync(this.file, JSON.stringify(value), { mode: 0o600 }); return this.file; } };
}
const noSecrets = value => { const output = JSON.stringify(value); for (const secret of Object.values(secrets)) assert.equal(output.includes(secret), false); assert.equal(output.includes('https://'), false); };

test('provision validates all connection parameters before creating service or encryption files', async t => {
  const f = fixture(t); let opened = false;
  const invalid = [ {}, { unexpected: {} }, { ...config(), lottery: { url: 'https://lottery.example.test/api/manage', campaignId: 'test-lottery', key: 'a'.repeat(64) } }, { ...config(), coupon: { ...config().coupon, mode: 'local' } }, { coupon: { ...config().coupon, baseUrl: 'http://example.test' } }, { coupon: { ...config().coupon, baseUrl: 'https://example.test/manage' } } ];
  for (const input of invalid) await assert.rejects(provisionConnections({ input, directory: f.directory, keyFile: f.keyFile, serviceFactory() { opened = true; }, protectorFactory() { opened = true; } }), error => error.provisionFailure === 'invalid_configuration');
  assert.equal(opened, false); assert.equal(fs.existsSync(f.keyFile), false);
  assert.equal(validateConnections(config()).coupon.mode, 'remote');
});

test('private file reader rejects relative paths, directories, oversized and invalid JSON without echoing contents', async t => {
  const f = fixture(t); f.write(); assert.equal(readPrivateJson(f.file).coupon.mode, 'remote');
  assert.throws(() => readPrivateJson('connections.json'), error => error.provisionFailure === 'invalid_file_path');
  assert.throws(() => readPrivateJson(f.directory), error => error.provisionFailure === 'file_not_private_or_regular');
  fs.writeFileSync(f.file, secrets.admin + '{', { mode: 0o600 }); assert.throws(() => readPrivateJson(f.file), error => error.provisionFailure === 'invalid_json' && !error.message.includes(secrets.admin));
  fs.writeFileSync(f.file, 'x'.repeat(65537)); assert.throws(() => readPrivateJson(f.file), error => error.provisionFailure === 'file_not_private_or_regular');
  if (process.platform !== 'win32') { f.write(); fs.chmodSync(f.file, 0o644); assert.throws(() => readPrivateJson(f.file), error => error.provisionFailure === 'file_not_private_or_regular'); }
});

test('helper connects the coupon center, uses exclusive service and closes after success', async t => {
  const f = fixture(t), calls = [], reports = []; let closed = 0;
  const result = await provisionConnections({ input: config(), directory: f.directory, keyFile: f.keyFile, report: value => reports.push(value), protectorFactory: () => ({ protect: value => value, unprotect: value => value }), serviceFactory(options) {
    assert.equal(options.directory, path.join(f.directory, 'payments')); assert.equal(options.exclusive, true);
    return { close() { closed++; }, async dispatch(action, payload) { calls.push(action); assert.equal(action, 'coupon-connect'); assert.equal(payload.mode, 'remote'); return { connected: true, centerId, physicalSupported: true, lotteryCatalogSupported: true }; } };
  } });
  assert.equal(result.ok, true); assert.equal(closed, 1); assert.deepEqual(calls, ['coupon-connect']);
  assert.deepEqual(result.results[0], { component: 'coupon', configured: true, centerId, capabilities: ['physical-prize-v1', 'lottery-catalog-v1'] }); noSecrets(reports);
});

test('connect failure reports accurately and never echoes secrets', async t => {
  const f = fixture(t), reports = []; let closed = false;
  const result = await provisionConnections({ input: config(), directory: f.directory, keyFile: f.keyFile, report: r => reports.push(r), protectorFactory: () => ({}), serviceFactory: () => ({ close() { closed = true; }, async dispatch() { throw Object.assign(new Error(`${secrets.admin} https://secret.test/?token=${secrets.admin}`), { code: secrets.admin }); } }) });
  assert.equal(result.ok, false); assert.equal(closed, true); assert.equal(reports[0].configured, false); assert.equal(reports[0].failure, 'connection_failed'); assert.equal(reports[0].centerId, ''); noSecrets(reports);
});

test('CLI outputs fixed failure categories only and never reads account or ledger files', async t => {
  const f = fixture(t); f.write(); let output = '', called = false;
  const exitCode = await main({ argv: ['--file', f.file], env: { BUBBLE_ONLINE_DATA_DIR: f.directory, BUBBLE_ONLINE_KEY_FILE: f.keyFile }, write: value => { output += value; }, protectorFactory: () => ({}), serviceFactory: () => { called = true; throw new Error(`service running ${secrets.admin}`); } });
  assert.equal(exitCode, 1); assert.equal(called, true); assert.equal(JSON.parse(output).failure, 'service_unavailable_or_running'); noSecrets(output);
  output = ''; assert.equal(await main({ argv: ['--token', secrets.admin], write: value => { output += value; } }), 1); assert.equal(JSON.parse(output).failure, 'invalid_arguments'); noSecrets(output);
  assert.equal(fs.existsSync(path.join(f.directory, 'accounts.sqlite')), false); assert.equal(fs.existsSync(path.join(f.directory, 'ledger.sqlite')), false);
});

test('real coupon bridge encrypts the connection, validates identity and leaves auth/ledger untouched', async t => {
  const f = fixture(t), requests = [], reports = []; f.write();
  const accountFile = path.join(f.directory, 'accounts.sqlite'), ledgerFile = path.join(f.directory, 'ledger.sqlite');
  fs.writeFileSync(accountFile, 'untouched account sentinel'); fs.writeFileSync(ledgerFile, 'untouched ledger sentinel');
  const fakeFetch = async (input, options) => {
    const url = new URL(input); requests.push(`${options.method} ${url.pathname}`);
    assert.equal(url.hostname, 'coupons.example.test'); assert.equal(url.search, '');
    const token = options.headers.Authorization;
    assert.ok([`Bearer ${secrets.admin}`, `Bearer ${secrets.cashier}`].includes(token));
    let data;
    if (options.method === 'GET' && url.pathname === '/v1/info') data = { service: 'stall-coupon-center', version: 1, centerId, environment: 'production', role: token === `Bearer ${secrets.cashier}` ? 'cashier' : 'admin', capabilities: ['physical-prize-v1', 'lottery-catalog-v1'] };
    else if (options.method === 'POST' && url.pathname === '/v1/keys') { const body = JSON.parse(options.body); assert.equal(body.role, 'cashier'); assert.match(body.requestId, /^terminal:/); data = { token: secrets.cashier }; }
    else throw new Error('forbidden coupon action');
    return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const result = await provisionConnections({ input: readPrivateJson(f.file), directory: f.directory, keyFile: f.keyFile, report: value => reports.push(value), serviceFactory: options => createService({ ...options, fetchFn: fakeFetch }) });
  assert.equal(result.ok, true); assert.equal(result.results.length, 1); noSecrets(reports);
  const protector = createServerProtector({ keyFile: f.keyFile });
  for (const field of ['adminToken', 'cashierToken']) {
    const raw = fs.readFileSync(path.join(f.directory, 'payments', 'coupon-connection.json'), 'utf8'); assert.equal(raw.includes(secrets.admin), false); const saved = JSON.parse(raw); assert.match(saved[field], /^bsv1\./);
  }
  assert.equal(protector.unprotect(JSON.parse(fs.readFileSync(path.join(f.directory, 'payments', 'coupon-connection.json'), 'utf8')).adminToken), secrets.admin);
  assert.equal(fs.readFileSync(accountFile, 'utf8'), 'untouched account sentinel'); assert.equal(fs.readFileSync(ledgerFile, 'utf8'), 'untouched ledger sentinel'); assert.equal(fs.existsSync(path.join(f.directory, 'payments', 'service.lock')), false);
  assert.equal(requests.filter(r => r === 'POST /v1/keys').length, 1); assert.ok(requests.every(r => ['GET /v1/info', 'POST /v1/keys'].includes(r)));
});
