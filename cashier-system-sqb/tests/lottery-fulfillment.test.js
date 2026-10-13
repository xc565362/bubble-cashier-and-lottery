import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createService } = require('../lottery-backend/service.js');
const { createPoolManagement } = require('../lottery-backend/pool-management.cjs');
const { createManagementCenter } = require('../lottery-backend/management-center.cjs');
const { createManagementHttp } = require('../lottery-backend/management-http.cjs');

async function fixture() {
  let tables = new Map(), tail = Promise.resolve();
  const store = { transaction(fn) {
    const pending = tail.then(async () => {
      const next = structuredClone(tables);
      const result = await fn({
        get: async (table, id) => structuredClone(next.get(table + ':' + id)),
        set: async (table, id, value) => next.set(table + ':' + id, structuredClone(value)),
      });
      tables = next; return result;
    });
    tail = pending.catch(() => {}); return pending;
  } };
  const now = () => 1800000000000;
  const campaign = { id: 'two-activity-fixture', title: 'isolated fixture', enabled: false,
    startsAt: now() - 60000, endsAt: now() + 60000, redeemEndsAt: now() + 120000,
    inventory: { version: 1, total: 2, quantities: { cap: 2 } } };
  const prizes = [{ id: 'cap', name: 'fixture cap', kind: 'physical', probability: 100 }];
  const options = { store, campaign, prizes, now, entryId: id => id, adminIds: ['fixture-admin'] };
  await createService(options)('initializePool', {}, 'fixture-admin');
  const config = { baseUrl: 'https://isolated-coupons.invalid', centerId: 'isolated-center', adminToken: 'x'.repeat(64), prizes: { cap: 'fixture-cap' } };
  const info = { service: 'stall-coupon-center', version: 1, centerId: config.centerId, environment: 'production', role: 'admin', capabilities: ['physical-prize-v1', 'lottery-catalog-v1'] };
  const couponCampaign = { id: 'fixture-cap', kind: 'physical', physical: { prizeId: 'cap', quantity: 1 }, quota: 2, issued: 0, enabled: true,
    startsAt: new Date(campaign.startsAt).toISOString(), expiresAt: new Date(campaign.redeemEndsAt).toISOString() };
  let unavailable = false, countsUnavailable = false;
  const fetchFn = async url => {
    assert.equal(new URL(url).origin, config.baseUrl);
    if (unavailable) throw new Error('isolated offline fixture');
    const route = new URL(url).pathname;
    if (route === '/v1/info') return Response.json({ ok: true, data: info });
    if (route === '/v1/campaigns') return Response.json({ ok: true, data: [couponCampaign] });
    if (route === '/v1/coupons' && countsUnavailable) throw new Error('isolated count failure');
    if (route === '/v1/coupons') return Response.json({ ok: true, data: { total: 0 } });
    throw new Error('Unexpected request: ' + route);
  };
  const center = createManagementCenter({ ...options, config, fetchFn });
  const pool = createPoolManagement({ ...options, getCenter: center.read });
  return { ...options, config, info, couponCampaign, center, pool, fetchFn,
    unavailable(value) { unavailable = value; }, countsUnavailable(value) { countsUnavailable = value; } };
}

test('management exposes verified center identity without credentials and marks physical fulfillment ready', async () => {
  const f = await fixture(), snapshot = await f.pool.snapshot();
  assert.deepEqual(snapshot.fulfillment, { ready: true, centerId: f.config.centerId, environment: 'production' });
  assert.equal(snapshot.center.physicalSupported, true);
  assert.equal(snapshot.center.environment, 'production');
  assert.equal(snapshot.center.prizes.cap.quota, 2);
  assert.equal(snapshot.remaining, 2);
  assert.ok(!JSON.stringify(snapshot).includes(f.config.adminToken));
});

test('missing physical capability keeps verified identity but does not claim redemption readiness', async () => {
  const f = await fixture(); f.info.capabilities = ['lottery-catalog-v1'];
  assert.deepEqual((await f.pool.snapshot()).fulfillment, { ready: false, centerId: f.config.centerId, environment: 'production' });
});

test('failed identity or prize mapping never leaves a stale ready identity on a later snapshot', async () => {
  const f = await fixture();
  assert.equal((await f.pool.snapshot()).fulfillment.ready, true);
  for (const [field, value] of [['centerId', 'another-center'], ['environment', 'development'], ['role', 'cashier']]) {
    const old = f.info[field]; f.info[field] = value;
    const snapshot = await f.pool.snapshot();
    assert.deepEqual(snapshot.fulfillment, { ready: false, centerId: '', environment: '' });
    assert.equal(snapshot.center, null); assert.ok(snapshot.centerError);
    f.info[field] = old;
  }
  f.couponCampaign.physical.prizeId = 'wrong-prize';
  assert.equal((await f.pool.snapshot()).fulfillment.ready, false);
  f.couponCampaign.physical.prizeId = 'cap'; f.unavailable(true);
  assert.deepEqual((await f.pool.snapshot()).fulfillment, { ready: false, centerId: '', environment: '' });
});

test('older readers without verified environment cannot advertise fulfillment readiness', async () => {
  const f = await fixture();
  const legacy = createPoolManagement({ ...f, getCenter: async () => ({ centerId: f.config.centerId, physicalSupported: true, prizes: {} }) });
  const snapshot = await legacy.snapshot();
  assert.deepEqual(snapshot.fulfillment, { ready: false, centerId: '', environment: '' });
  assert.equal(snapshot.center.centerId, f.config.centerId);
});

test('redeemed count failure preserves verified connection and reports unknown counts through management HTTP', async () => {
  const f = await fixture(); f.countsUnavailable(true);
  const key = 'a'.repeat(64), handler = createManagementHttp({ ...f, centerConfig: f.config, key });
  const body = JSON.stringify({ campaignId: f.campaign.id, action: 'snapshot' }), time = String(f.now()), nonce = crypto.randomUUID();
  const reply = await handler({ httpMethod: 'POST', body, headers: { 'content-type': 'application/json',
    'x-lottery-time': time, 'x-lottery-nonce': nonce,
    'x-lottery-signature': crypto.createHmac('sha256', key).update(time + '\n' + nonce + '\n' + body).digest('hex') } });
  assert.equal(reply.statusCode, 200);
  const snapshot = JSON.parse(reply.body).data;
  assert.equal(snapshot.fulfillment.ready, true);
  assert.match(snapshot.centerError, /统计暂时不可用/);
  assert.equal(snapshot.center.prizes.cap.redeemed, undefined);
});
