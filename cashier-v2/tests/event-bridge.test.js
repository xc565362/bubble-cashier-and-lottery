import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createEventBridge } = require('../payments/event-bridge.cjs');
const { createService } = require('../payments/service.cjs');

function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-bridge-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

const KNOWN_CODE = 'A1B2C3D4E5F67890';

function makeManifest(service, overrides = {}) {
  return {
    protocol: 'bubble-event/1', service, version: 1,
    display: {
      title: `${service} 活动`,
      recordFields: [
        { key: 'code', label: '核销码', type: 'code' },
        { key: 'prize', label: '奖品', type: 'text' },
        { key: 'status', label: '状态', type: 'enum', values: ['pending', 'redeemed'] },
        { key: 'createdAt', label: '时间', type: 'timestamp' },
      ],
    },
    benefits: { cap: { kind: 'physical' }, cash10: { kind: 'cash', amountCents: 1000 } },
    actions: ['records', 'lookup', 'redeem', 'export'],
    ...overrides,
  };
}

// In-process stub event server speaking bubble-event/1: manifest (no auth),
// X-Staff-Key auth check, records/lookup/redeem/export. Every request is
// logged so tests can assert which server received which key.
async function stubEventServer(t, { service = 'race-event', key = 'staff-secret', manifest } = {}) {
  const calls = [];
  const recordsData = {
    summary: { entries: 1, pending: 1, redeemed: 0, stockTotal: 10, stockRemaining: 9 },
    records: [{ code: KNOWN_CODE, prize: '棒球帽', status: 'pending', openid: 'mock…00af', createdAt: 1791971533677, redeemedAt: null, redeemedBy: '' }],
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    calls.push({ path: url.pathname, key: req.headers['x-staff-key'] || '' });
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/api/manifest' && req.method === 'GET') return json(200, manifest || makeManifest(service));
    const presented = typeof req.headers['x-staff-key'] === 'string' && req.headers['x-staff-key'].length > 0;
    if (req.headers['x-staff-key'] !== key) return json(presented ? 403 : 401, { ok: false, code: 'FORBIDDEN', message: '无效的工作人员密钥' });
    if (url.pathname === '/api/admin/records' && req.method === 'GET') return json(200, { ok: true, data: recordsData });
    if (url.pathname === '/api/admin/records.csv' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
      return res.end(`code,prize,status\r\n${KNOWN_CODE},棒球帽,pending\r\n`);
    }
    if (url.pathname === '/api/call' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => body += chunk);
      req.on('end', () => {
        const { action, payload } = JSON.parse(body);
        // Same normalization as the reference server: whitespace stripped,
        // upper-cased before comparison.
        const code = String(payload?.code || '').replace(/\s+/g, '').toUpperCase();
        if (action === 'lookup') {
          if (code === KNOWN_CODE) return json(200, { ok: true, data: { code, status: 'pending', prize: { name: '棒球帽' }, winner: 'mock…00af' } });
          return json(404, { ok: false, code: 'NOT_FOUND', message: '未找到此活动的核销码，请核对' });
        }
        if (action === 'redeem') {
          if (code === KNOWN_CODE) return json(200, { ok: true, data: { code, status: 'redeemed', prize: { name: '棒球帽' } } });
          return json(404, { ok: false, code: 'NOT_FOUND', message: '未找到此活动的核销码，请核对' });
        }
        return json(400, { ok: false, code: 'INVALID_ACTION', message: '不支持的操作' });
      });
      return undefined;
    }
    return json(404, { ok: false, code: 'NOT_FOUND', message: '接口不存在' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, calls };
}

test('event-bridge: pair validates manifest, probes key, persists protected connection; list never exposes key', async t => {
  const directory = temp(t);
  const stub = await stubEventServer(t, { service: 'race-event', key: 'staff-secret' });
  const bridge = createEventBridge({
    directory, protect: value => 'protected:' + value, unprotect: value => value.slice(10),
  });
  const entry = await bridge.dispatch('pair', { baseUrl: stub.base + '/', key: 'staff-secret' });
  assert.equal(entry.id, 'race-event');
  assert.equal(entry.title, 'race-event 活动');
  assert.equal(entry.baseUrl, stub.base);
  assert.deepEqual(entry.actions, ['records', 'lookup', 'redeem', 'export']);
  assert.ok(Number.isFinite(Date.parse(entry.connectedAt)));
  // Manifest fetched without auth, then a lookup probe with the staff key.
  assert.deepEqual(stub.calls.map(call => call.path), ['/api/manifest', '/api/call']);
  assert.equal(stub.calls[0].key, '');
  assert.equal(stub.calls[1].key, 'staff-secret');
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'event-connections.json'), 'utf8'));
  assert.equal(saved['race-event'].key, 'protected:staff-secret');
  assert.equal(saved['race-event'].manifest.protocol, 'bubble-event/1');
  assert.ok(!JSON.stringify(await bridge.dispatch('list')).includes('staff-secret'));
  assert.ok(!JSON.stringify(await bridge.dispatch('manifest', { id: 'race-event' })).includes('staff-secret'));
});

test('event-bridge: pair rejects bad addresses and bad keys before saving', async t => {
  const directory = temp(t);
  const stub = await stubEventServer(t, { key: 'staff-secret' });
  const bridge = createEventBridge({ directory });
  await assert.rejects(bridge.dispatch('pair', { baseUrl: 'http://example.com:8787', key: 'k' }), /HTTPS|127\.0\.0\.1/);
  await assert.rejects(bridge.dispatch('pair', { baseUrl: 'ftp://127.0.0.1', key: 'k' }), /HTTPS|127\.0\.0\.1/);
  await assert.rejects(bridge.dispatch('pair', { baseUrl: 'https://user:pass@events.example.com', key: 'k' }), /HTTPS|127\.0\.0\.1/);
  await assert.rejects(bridge.dispatch('pair', { baseUrl: stub.base, key: '' }), /密钥/);
  await assert.rejects(bridge.dispatch('pair', { baseUrl: stub.base, key: 'wrong-key' }), /密钥无效/);
  assert.equal(fs.existsSync(path.join(directory, 'event-connections.json')), false);
  assert.deepEqual(await bridge.dispatch('list'), { connections: [] });
});

test('event-bridge: pair rejects non-conforming manifests', async t => {
  const directory = temp(t);
  const cases = [
    { protocol: 'other/9' },
    { version: 2 },
    { service: '' },
    { display: { title: 'x', recordFields: [] } },
    { display: { title: 'x', recordFields: [{ key: 'code', label: '核销码', type: 'mystery' }] } },
    { display: { title: 'x', recordFields: [{ key: 'status', label: '状态', type: 'enum' }] } },
    { benefits: { bad: { kind: 'money' } } },
    { actions: ['records', 'teleport'] },
    { actions: [] },
    { actions: ['records', 'redeem', 'export'] },
  ];
  for (const [index, overrides] of cases.entries()) {
    const stub = await stubEventServer(t, { manifest: { ...makeManifest(`event-${index}`), ...overrides } });
    await assert.rejects(bridgeDispatchPair(t, directory, stub), /协议清单|lookup/);
  }
  assert.deepEqual(await listIds(t, directory), { connections: [] });

  async function bridgeDispatchPair(tt, dir, stub) {
    const bridge = createEventBridge({ directory: dir });
    return bridge.dispatch('pair', { baseUrl: stub.base, key: 'staff-secret' });
  }
  async function listIds(tt, dir) {
    const bridge = createEventBridge({ directory: dir });
    return bridge.dispatch('list');
  }
});

test('event-bridge: lookup/redeem/records/export proxy with stored key; server errors surface', async t => {
  const directory = temp(t);
  const stub = await stubEventServer(t, { key: 'staff-secret' });
  const bridge = createEventBridge({ directory });
  await bridge.dispatch('pair', { baseUrl: stub.base, key: 'staff-secret' });
  stub.calls.length = 0;
  await assert.rejects(bridge.dispatch('lookup', { id: 'race-event', code: '' }), /核销码格式/);
  const found = await bridge.dispatch('lookup', { id: 'race-event', code: 'a1b2 c3d4 e5f6 7890' });
  assert.equal(found.status, 'pending');
  const redeemed = await bridge.dispatch('redeem', { id: 'race-event', code: KNOWN_CODE });
  assert.equal(redeemed.status, 'redeemed');
  const records = await bridge.dispatch('records', { id: 'race-event' });
  assert.equal(records.summary.stockRemaining, 9);
  const { csv } = await bridge.dispatch('export-csv', { id: 'race-event' });
  assert.match(csv, /code,prize,status/);
  assert.ok(stub.calls.every(call => call.key === 'staff-secret'));
  assert.deepEqual(stub.calls.map(call => call.path), ['/api/call', '/api/call', '/api/admin/records', '/api/admin/records.csv']);
  await assert.rejects(bridge.dispatch('lookup', { id: 'race-event', code: '0000000000000001' }), /未找到此活动的核销码/);
  await assert.rejects(bridge.dispatch('records', { id: 'missing-event' }), /尚未连接/);
});

test('event-bridge: multiple connections stay isolated; remove keeps the rest', async t => {
  const directory = temp(t);
  const stubA = await stubEventServer(t, { service: 'race-event', key: 'key-a' });
  const stubB = await stubEventServer(t, { service: 'checkin-event', key: 'key-b' });
  const bridge = createEventBridge({ directory });
  await bridge.dispatch('pair', { baseUrl: stubA.base, key: 'key-a' });
  await bridge.dispatch('pair', { baseUrl: stubB.base, key: 'key-b' });
  assert.deepEqual((await bridge.dispatch('list')).connections.map(item => item.id).sort(), ['checkin-event', 'race-event']);
  stubA.calls.length = 0; stubB.calls.length = 0;
  await bridge.dispatch('lookup', { id: 'race-event', code: KNOWN_CODE });
  await bridge.dispatch('records', { id: 'checkin-event' });
  assert.equal(stubA.calls.length, 1);
  assert.equal(stubA.calls[0].key, 'key-a');
  assert.equal(stubB.calls.length, 1);
  assert.equal(stubB.calls[0].key, 'key-b');
  assert.equal(stubB.calls[0].path, '/api/admin/records');
  // Re-pair with a rotated key updates the stored credentials in place.
  await bridge.dispatch('pair', { baseUrl: stubA.base, key: 'key-a' });
  assert.equal((await bridge.dispatch('list')).connections.length, 2);
  const remaining = await bridge.dispatch('remove', { id: 'race-event' });
  assert.deepEqual(remaining.connections.map(item => item.id), ['checkin-event']);
  await assert.rejects(bridge.dispatch('records', { id: 'race-event' }), /尚未连接/);
  await bridge.dispatch('records', { id: 'checkin-event' });
  // Removal survives a reload from disk.
  const reloaded = createEventBridge({ directory });
  assert.deepEqual((await reloaded.dispatch('list')).connections.map(item => item.id), ['checkin-event']);
});

test('event-bridge: service wiring guards pair/remove during unresolved checkout; reads stay available', async t => {
  const directory = temp(t);
  const stub = await stubEventServer(t, { service: 'race-event', key: 'staff-secret' });
  fs.writeFileSync(path.join(directory, 'event-connections.json'), JSON.stringify({
    'race-event': {
      id: 'race-event', baseUrl: stub.base, key: 'staff-secret',
      manifest: makeManifest('race-event'), connectedAt: new Date().toISOString(),
    },
  }));
  fs.writeFileSync(path.join(directory, 'payments.json'), JSON.stringify({ pending: { id: 'pending', state: 'pending', acknowledged: false } }));
  const service = createService({ directory });
  try {
    assert.equal((await service.dispatch('event-list')).connections[0].id, 'race-event');
    assert.equal((await service.dispatch('event-manifest', { id: 'race-event' })).protocol, 'bubble-event/1');
    assert.equal((await service.dispatch('event-lookup', { id: 'race-event', code: KNOWN_CODE })).status, 'pending');
    assert.equal((await service.dispatch('event-records', { id: 'race-event' })).summary.entries, 1);
    await assert.rejects(service.dispatch('event-pair', { baseUrl: stub.base, key: 'k' }), /收退款和券占用/);
    await assert.rejects(service.dispatch('event-remove', { id: 'race-event' }), /收退款和券占用/);
  } finally { service.close(); }
});
