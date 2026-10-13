import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createService } = require('../payments/service.cjs');
const { signedEnvelope, verifyEnvelope } = require('../payments/litepos.cjs');
const { normalizePrivateKey, publicFingerprint, sealCredentials, openCredentials } = require('../payments/credentials.cjs');
const { isPublicIPv4, createPublicIpResolver } = require('../payments/network.cjs');
const pair = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const merchant = pair();
const platform = pair();
const privatePem = merchant.privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicPem = merchant.publicKey.export({ type: 'spki', format: 'pem' });
const config = { mode: 'test', appid: 'mockapp', brand_code: '123', store_sn: 'TEST', workstation_sn: '0', operator: 'Test', gateway: 'https://test.shouqianba.com', platformPublicKey: platform.publicKey.export({ type: 'spki', format: 'pem' }) };
const protectedValue = (text) => Buffer.from(text).toString('base64'); // Mock protection; production desktop uses OS safeStorage.
const unprotect = (text) => Buffer.from(text, 'base64').toString('utf8');
function fixture(t, fetchFn = async () => { throw new Error('Unexpected network call'); }, resolveTerminalIp = async () => '8.8.4.4') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqb-config-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = { directory, protect: protectedValue, unprotect, fetchFn, resolveTerminalIp };
  return { directory, options, service: createService(options) };
}
const importPayload = { config, privateKey: privatePem, confirmReplace: true };
const signedError = (code = 'ACQ.ORDER_NOT_FOUND') => signedEnvelope('response', { head: { appid: config.appid, sign_type: 'SHA256' }, body: { result_code: '200', biz_response: { result_code: '400', error_code: code } } }, platform.privateKey);

test('PEM and bare Base64 PKCS1/PKCS8 normalize to one RSA signing key', () => {
  for (const type of ['pkcs1', 'pkcs8']) for (const format of ['pem', 'der']) {
    const value = merchant.privateKey.export({ type, format });
    const normalized = normalizePrivateKey(Buffer.isBuffer(value) ? value.toString('base64') : value);
    assert.equal(publicFingerprint(normalized.publicKey), publicFingerprint(publicPem));
    assert.match(normalized.privateKey, /^-----BEGIN PRIVATE KEY/);
  }
  assert.throws(() => normalizePrivateKey('garbage'), /RSA 2048/);
  assert.throws(() => normalizePrivateKey(publicPem), /私钥/);
  const weak = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  assert.throws(() => normalizePrivateKey(weak.privateKey.export({ type: 'pkcs8', format: 'pem' })), /RSA 2048/);
});

test('configuration import is atomic, protects keys, preserves original and never returns secrets', async (t) => {
  const { directory, options, service } = fixture(t);
  const original = await service.dispatch('generate-key');
  const legacyBytes = fs.readFileSync(path.join(directory, 'merchant-key.json'));
  await assert.rejects(service.dispatch('import-credentials', { ...importPayload, confirmReplace: false }), /确认替换/);
  const result = await service.dispatch('import-credentials', importPayload);
  assert.equal(result.ready, true); assert.equal(result.mode, 'test');
  assert.equal(result.keyFingerprint, publicFingerprint(publicPem));
  assert.ok(!JSON.stringify(result).includes('PRIVATE KEY'));
  assert.deepEqual(fs.readFileSync(path.join(directory, 'merchant-key.json')), legacyBytes);
  assert.equal(fs.readdirSync(path.join(directory, 'credential-backups')).length, 1);
  const activeFile = path.join(directory, 'credentials.json');
  const active = fs.readFileSync(activeFile, 'utf8');
  assert.ok(!active.includes('PRIVATE KEY'));
  assert.notEqual(result.merchantPublicKey, original.merchantPublicKey);
  await assert.rejects(service.dispatch('import-credentials', { ...importPayload, privateKey: 'bad' }), /私钥/);
  assert.equal(fs.readFileSync(activeFile, 'utf8'), active);
  assert.equal((await createService(options).dispatch('config')).keyFingerprint, result.keyFingerprint);
});

test('encrypted migration requires password and authenticated data; wrong imports leave configuration unchanged', async (t) => {
  const { service, directory } = fixture(t);
  await service.dispatch('import-credentials', importPayload);
  const bundle = await service.dispatch('export-credentials', { password: 'Test-only-password-123' });
  assert.ok(!JSON.stringify(bundle).includes('PRIVATE KEY'));
  const decoded = openCredentials(bundle, 'Test-only-password-123');
  assert.equal(decoded.privateKey, privatePem);
  assert.equal(decoded.config.appid, config.appid);
  assert.throws(() => openCredentials(bundle, 'wrong-password-123'), /密码/);
  const tampered = { ...bundle, data: `AAAA${bundle.data.slice(4)}` };
  assert.throws(() => openCredentials(tampered, 'Test-only-password-123'), /配置包/);
  assert.throws(() => sealCredentials({}, 'short'), /12/);
  const before = fs.readFileSync(path.join(directory, 'credentials.json'), 'utf8');
  await assert.rejects(service.dispatch('import-credentials', { bundle, password: 'incorrect-password', confirmReplace: true }), /密码/);
  assert.equal(fs.readFileSync(path.join(directory, 'credentials.json'), 'utf8'), before);
  const other = fixture(t);
  await other.service.dispatch('import-credentials', { bundle, password: 'Test-only-password-123', confirmReplace: true });
  assert.equal((await other.service.dispatch('config')).keyFingerprint, publicFingerprint(publicPem));
});

test('non-charging diagnostic only sends a signed query with a fresh random order and real-IP header', async (t) => {
  let calls = 0;
  const { service, directory } = fixture(t, async (url, options) => {
    calls++;
    assert.ok(url.endsWith('/sales/query'));
    assert.equal(options.headers['X-Forwarded-For'], '8.8.4.4');
    const body = verifyEnvelope(options.body, 'request', publicPem, config.appid);
    assert.match(body.check_sn, /^CHK[0-9a-f]+$/); assert.ok(body.check_sn.length <= 32);
    assert.equal(body.brand_code, config.brand_code); assert.equal(body.dynamic_id, undefined);
    return new Response(signedError());
  });
  await service.dispatch('import-credentials', importPayload);
  const result = await service.dispatch('check-connection');
  assert.equal(result.connectionCheck.verified, true); assert.equal(calls, 1);
  assert.equal(fs.existsSync(path.join(directory, 'payments.json')), false);
  await service.dispatch('save-config', { ...config, store_sn: 'CHANGED' });
  assert.equal((await service.dispatch('config')).connectionCheck, null);
});

test('forged or rejected diagnostics never report a verified connection', async (t) => {
  for (const raw of [signedError('ILLEGAL_SIGN'), signedError().replace('ACQ.ORDER_NOT_FOUND', 'tampered')]) {
    const { service } = fixture(t, async () => new Response(raw));
    await service.dispatch('import-credentials', importPayload);
    const result = await service.dispatch('check-connection');
    assert.equal(result.connectionCheck.verified, false);
  }
});

test('test merchant payment requires explicit acknowledgement and unresolved payments lock key replacement', async (t) => {
  let calls = 0;
  const { service, directory } = fixture(t, async () => { calls++; throw new TypeError('offline'); });
  await service.dispatch('import-credentials', importPayload);
  const draft = { id: 'order1', orderNo: 'POS1', total: 1, items: [{ id: 'p1', name: 'Test', productType: 'sale', price: 1, qty: 1 }] };
  const code = '130000000000000000';
  await assert.rejects(service.dispatch('start', { draft, code }), /测试/);
  assert.equal(calls, 0); assert.equal(fs.existsSync(path.join(directory, 'payments.json')), false);
  assert.equal((await service.dispatch('start', { draft, code, confirmTestPayment: true })).state, 'pending');
  await assert.rejects(service.dispatch('import-credentials', importPayload), /未完成/);
  await assert.rejects(service.dispatch('export-credentials', { password: 'test-password123' }), /对账/);
  await assert.rejects(service.dispatch('check-connection'), /未完成/);
  const diagnostic = await service.dispatch('diagnostics');
  assert.ok(!JSON.stringify(diagnostic).includes(code));
  assert.ok(!JSON.stringify(diagnostic).includes('PRIVATE KEY'));
});

test('missing public IP fails before submitting payment, without leaving an uncertain charge', async (t) => {
  let calls = 0;
  const { service } = fixture(t, async () => { calls++; }, async () => { throw new Error('IP unavailable'); });
  await service.dispatch('import-credentials', importPayload);
  const result = await service.dispatch('start', { draft: { id: 'order2', orderNo: 'POS2', total: 1, items: [{ id: 'p', name: 'Test', price: 1, qty: 1 }] }, code: '130000000000000000', confirmTestPayment: true });
  assert.equal(result.state, 'failed'); assert.equal(result.notSubmitted, true); assert.equal(calls, 0);
  await service.dispatch('acknowledge', { id: 'order2' });
  assert.equal((await service.dispatch('pending')).length, 0);
});

test('IP resolver refuses private/reserved addresses, caches short queries but refreshes purchases', async () => {
  for (const ip of ['127.0.0.1', '192.168.1.1', '10.0.0.1', '172.16.0.1', '100.64.0.1', '169.254.1.1', '203.0.113.1', '::1', '8.8.4.4\r\nInjected: 1']) assert.equal(isPublicIPv4(ip), false);
  assert.equal(isPublicIPv4('8.8.4.4'), true);
  let calls = 0;
  const resolver = createPublicIpResolver(async (url) => { assert.equal(url, 'https://api.ipify.org?format=json'); calls++; return new Response('{"ip":"8.8.4.4"}'); });
  await resolver(); await resolver(); assert.equal(calls, 1);
  await resolver({ fresh: true }); assert.equal(calls, 2);
  await assert.rejects(createPublicIpResolver(async () => new Response('{"ip":"10.0.0.1"}'))(), /公网/);
});

test('connectivity query uses the fallback terminal IP without duplicate gateway requests', async (t) => {
  let gateways = 0;
  const fetchFn = async (url, options) => {
    if (url.startsWith('https://api.ipify.org')) throw new TypeError('offline');
    if (url === 'https://checkip.amazonaws.com/') return new Response('8.8.4.4\n');
    gateways++;
    assert.ok(url.endsWith('/sales/query'));
    assert.equal(options.headers['X-Forwarded-For'], '8.8.4.4');
    return new Response(signedError());
  };
  const { service } = fixture(t, fetchFn, createPublicIpResolver(fetchFn));
  await service.dispatch('import-credentials', importPayload);
  assert.equal((await service.dispatch('check-connection')).connectionCheck.verified, true);
  assert.equal(gateways, 1);
});

test('both IP providers failing blocks purchase and saves safe network diagnostics', async (t) => {
  let gateways = 0;
  const fetchFn = async (url) => {
    if (url.startsWith('https://api.ipify.org') || url === 'https://checkip.amazonaws.com/') throw new TypeError('offline');
    gateways++;
    throw new Error('Gateway must not be called');
  };
  const { service } = fixture(t, fetchFn, createPublicIpResolver(fetchFn));
  await service.dispatch('import-credentials', importPayload);
  const payload = { draft: { id: 'no-ip', orderNo: 'POS-NO-IP', total: 1, items: [{ id: 'p', name: 'Test', price: 1, qty: 1 }] }, code: '130000000000000000', confirmTestPayment: true };
  const result = await service.dispatch('start', payload);
  assert.equal(result.state, 'failed'); assert.equal(result.notSubmitted, true); assert.equal(gateways, 0);
  assert.equal((await service.dispatch('start', payload)).notSubmitted, true);
  assert.equal((await service.dispatch('query', { id: 'no-ip' })).notSubmitted, true);
  assert.equal(gateways, 0);
  const events = (await service.dispatch('diagnostics')).events;
  const failure = events.find((event) => event.action === 'request-error');
  assert.equal(failure.code, 'PUBLIC_IP_UNAVAILABLE');
  assert.equal(failure.ipChecks.length, 2);
  assert.ok(!JSON.stringify(events).includes(payload.code));
});

test('IP failure during reconciliation never changes a submitted payment to failed', async (t) => {
  let online = true;
  let gateways = 0;
  const fetchFn = async (url) => {
    if (url.startsWith('https://api.ipify.org') || url === 'https://checkip.amazonaws.com/') {
      if (!online) throw new TypeError('offline');
      return new Response('{"ip":"8.8.4.4"}');
    }
    gateways++;
    throw new TypeError('response lost after submission');
  };
  const resolver = createPublicIpResolver(fetchFn);
  const { service } = fixture(t, fetchFn, () => resolver({ fresh: true }));
  await service.dispatch('import-credentials', importPayload);
  const payload = { draft: { id: 'pending-ip', orderNo: 'POS-PENDING', total: 1, items: [{ id: 'p', name: 'Test', price: 1, qty: 1 }] }, code: '130000000000000000', confirmTestPayment: true };
  assert.equal((await service.dispatch('start', payload)).state, 'pending');
  online = false;
  const result = await service.dispatch('query', { id: 'pending-ip' });
  assert.equal(result.state, 'pending'); assert.equal(result.notSubmitted, undefined); assert.equal(gateways, 1);
  await assert.rejects(service.dispatch('acknowledge', { id: 'pending-ip' }), /未确定/);
});
