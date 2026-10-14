import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createLotteryLocalBridge } = require('../payments/lottery-local.cjs');
const { createService } = require('../payments/service.cjs');

function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lottery-local-bridge-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

const sampleRecords = {
  summary: { entries: 1, pending: 1, redeemed: 0, noPrize: 0, stockTotal: 500, stockRemaining: 499, byPrize: { '奖品': 1 } },
  records: [{ code: 'A1B2C3D4E5F67890', prize: '奖品', status: 'pending', openid: 'mock…00af', createdAt: 1791971533677, redeemedAt: null, redeemedBy: '' }],
};

function fakeServer(calls, handler) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    return handler(url, init);
  };
}

test('lottery-local: connect validates address, verifies key, persists protected key, never exposes it', async t => {
  const directory = temp(t);
  const calls = [];
  const bridge = createLotteryLocalBridge({
    directory, protect: value => 'protected:' + value, unprotect: value => value.slice(10),
    fetchFn: fakeServer(calls, () => Response.json({ ok: true, data: sampleRecords })),
  });
  await assert.rejects(bridge.dispatch('connect', { baseUrl: 'http://example.com:8787', key: 'k' }), /HTTPS|127\.0\.0\.1/);
  await assert.rejects(bridge.dispatch('connect', { baseUrl: 'ftp://127.0.0.1', key: 'k' }), /HTTPS|127\.0\.0\.1/);
  await assert.rejects(bridge.dispatch('connect', { baseUrl: 'http://127.0.0.1:8787', key: '' }), /密钥/);
  const info = await bridge.dispatch('connect', { baseUrl: 'http://127.0.0.1:8787/', key: 'staff-secret' });
  assert.deepEqual(info, { configured: true, baseUrl: 'http://127.0.0.1:8787' });
  assert.equal(calls[0].url, 'http://127.0.0.1:8787/api/admin/records');
  assert.equal(calls[0].init.headers['X-Staff-Key'], 'staff-secret');
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'lottery-local.json'), 'utf8'));
  assert.equal(saved.key, 'protected:staff-secret');
  assert.ok(!JSON.stringify(await bridge.dispatch('config')).includes('staff-secret'));
});

test('lottery-local: lookup/redeem post to /api/call with normalized code; errors surface server messages', async t => {
  const directory = temp(t);
  fs.writeFileSync(path.join(directory, 'lottery-local.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:8787', key: 'k' }));
  const calls = [];
  let nextResponse = { ok: true, data: { code: 'A1B2C3D4E5F67890', status: 'pending', prize: { name: '奖品' }, winner: 'mock…00af' } };
  const bridge = createLotteryLocalBridge({ directory, fetchFn: fakeServer(calls, () => Response.json(nextResponse)) });
  await assert.rejects(bridge.dispatch('lookup', { code: 'not-a-code' }), /核销码格式/);
  assert.equal(calls.length, 0);
  const found = await bridge.dispatch('lookup', { code: 'a1b2 c3d4 e5f6 7890' });
  assert.equal(found.code, 'A1B2C3D4E5F67890');
  assert.equal(calls[0].url, 'http://127.0.0.1:8787/api/call');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['X-Staff-Key'], 'k');
  assert.deepEqual(JSON.parse(calls[0].init.body), { action: 'lookup', payload: { code: 'A1B2C3D4E5F67890' } });
  nextResponse = { ok: false, code: 'ALREADY_REDEEMED', message: '此奖品已核销，请勿重复发放' };
  await assert.rejects(bridge.dispatch('redeem', { code: 'A1B2C3D4E5F67890' }), /请勿重复发放/);
});

test('lottery-local: records validates shape; unreachable server gives a clear message; 401/403 means bad key', async t => {
  const directory = temp(t);
  fs.writeFileSync(path.join(directory, 'lottery-local.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:8787', key: 'k' }));
  let behavior = 'ok';
  const bridge = createLotteryLocalBridge({ directory, fetchFn: async () => {
    if (behavior === 'down') throw new TypeError('fetch failed');
    if (behavior === 'badkey') return Response.json({ ok: false, code: 'FORBIDDEN', message: '无效的工作人员密钥' }, { status: 403 });
    if (behavior === 'broken') return Response.json({ ok: true, data: { summary: { entries: 'many' }, records: [] } });
    return Response.json({ ok: true, data: sampleRecords });
  } });
  const data = await bridge.dispatch('records');
  assert.equal(data.summary.stockRemaining, 499);
  behavior = 'down';
  await assert.rejects(bridge.dispatch('records'), /无法连接抽奖服务/);
  behavior = 'badkey';
  await assert.rejects(bridge.dispatch('records'), /密钥无效/);
  behavior = 'broken';
  await assert.rejects(bridge.dispatch('records'), /格式异常/);
});

test('lottery-local: reads stay available during unresolved checkout; connect/redeem stay blocked', async t => {
  const directory = temp(t);
  fs.writeFileSync(path.join(directory, 'lottery-local.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:8787', key: 'k' }));
  fs.writeFileSync(path.join(directory, 'payments.json'), JSON.stringify({ pending: { id: 'pending', state: 'pending', acknowledged: false } }));
  const service = createService({ directory, fetchFn: fakeServer([], url => Response.json(url.endsWith('/api/call')
    ? { ok: true, data: { code: 'A1B2C3D4E5F67890', status: 'pending', prize: { name: '奖品' }, winner: 'mock…00af' } }
    : { ok: true, data: sampleRecords })) });
  try {
    assert.equal((await service.dispatch('h5lottery-records')).summary.entries, 1);
    assert.equal((await service.dispatch('h5lottery-lookup', { code: 'A1B2C3D4E5F67890' })).status, 'pending');
    await assert.rejects(service.dispatch('h5lottery-redeem', { code: 'A1B2C3D4E5F67890' }), /收退款和券占用/);
    await assert.rejects(service.dispatch('h5lottery-connect', { baseUrl: 'http://127.0.0.1:8787', key: 'k' }), /收退款和券占用/);
  } finally { service.close(); }
});
