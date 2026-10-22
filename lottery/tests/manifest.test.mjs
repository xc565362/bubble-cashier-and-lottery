import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../server.mjs';

// Runs against the real MySQL configured in .env.local, same pattern as
// lottery.test.mjs: randomized campaign id, all rows removed on teardown.
const STAFF_KEY = 'test-staff-key';

async function startServer(prizes, overrides = {}) {
  const campaignId = 'test-' + crypto.randomBytes(6).toString('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lottery-manifest-test-'));
  const configPath = path.join(dir, 'campaign.config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    id: campaignId, name: '测试活动', title: '测试标题', active: true,
    startsAt: '2026-01-01T00:00:00+08:00', endsAt: '2027-01-01T00:00:00+08:00',
    prizes,
    ...overrides,
  }));
  const app = await createApp({
    configPath,
    // Never pick up a real .coupon-bridge.json from the repo root.
    bridgeFile: path.join(dir, 'no-bridge.json'),
    env: { ...process.env, STAFF_KEY, WX_MOCK: '1' },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const close = async () => {
    await new Promise(resolve => app.server.close(resolve));
    await app.pool.query('DELETE FROM hd_entries WHERE campaign_id = ?', [campaignId]);
    await app.pool.query('DELETE FROM hd_prizes WHERE campaign_id = ?', [campaignId]);
    await app.pool.query('DELETE FROM hd_campaigns WHERE id = ?', [campaignId]);
    await app.pool.end();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { base, campaignId, close };
}

test('manifest: bubble-event/1 shape, no auth, benefits mapped from prizes', async t => {
  const ctx = await startServer([
    { id: 'cash10', name: '10元立减金', kind: 'cash', amount: 10, qty: 5, probability: 1 },
    { id: 'cap', name: '棒球帽', kind: 'physical', qty: 5, probability: 1 },
  ]);
  t.after(() => ctx.close());
  const res = await fetch(ctx.base + '/api/manifest');
  assert.equal(res.status, 200);
  const manifest = await res.json();
  assert.equal(manifest.protocol, 'bubble-event/1');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.service, ctx.campaignId);
  assert.equal(manifest.display.title, '测试标题');
  assert.deepEqual(manifest.display.recordFields, [
    { key: 'code', label: '核销码', type: 'code' },
    { key: 'prize', label: '奖品', type: 'text' },
    { key: 'status', label: '状态', type: 'enum', values: ['pending', 'redeemed'] },
    { key: 'createdAt', label: '时间', type: 'timestamp' },
  ]);
  assert.deepEqual(manifest.benefits, {
    cash10: { kind: 'cash', amountCents: 1000 },
    cap: { kind: 'physical' },
  });
  assert.deepEqual(manifest.actions, ['records', 'lookup', 'redeem', 'export']);
});

test('manifest: bridge pairing probe is a clean not-found with a valid staff key', async t => {
  const ctx = await startServer([
    { id: 'cap', name: '棒球帽', kind: 'physical', qty: 5, probability: 1 },
  ]);
  t.after(() => ctx.close());
  const probe = await fetch(ctx.base + '/api/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Staff-Key': STAFF_KEY },
    body: JSON.stringify({ action: 'lookup', payload: { code: '0000000000000000' } }),
  });
  assert.equal(probe.status, 404);
  const body = await probe.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'NOT_FOUND');
  // A wrong key must be rejected (this is what pairing relies on).
  const rejected = await fetch(ctx.base + '/api/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Staff-Key': 'wrong-key' },
    body: JSON.stringify({ action: 'lookup', payload: { code: '0000000000000000' } }),
  });
  assert.equal(rejected.status, 403);
});

test('manifest: title falls back to campaign name; admin config updates are reflected', async t => {
  const ctx = await startServer(
    [{ id: 'cap', name: '棒球帽', kind: 'physical', qty: 5, probability: 1 }],
    { title: undefined },
  );
  t.after(() => ctx.close());
  let manifest = await (await fetch(ctx.base + '/api/manifest')).json();
  assert.equal(manifest.display.title, '测试活动');
  const patch = await fetch(ctx.base + '/api/admin/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Staff-Key': STAFF_KEY },
    body: JSON.stringify({ title: '改名后的活动' }),
  });
  assert.equal(patch.status, 200);
  manifest = await (await fetch(ctx.base + '/api/manifest')).json();
  assert.equal(manifest.display.title, '改名后的活动');
});
