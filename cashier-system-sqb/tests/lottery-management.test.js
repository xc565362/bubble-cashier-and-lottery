import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { percentToBps, lotteryDraft, lotteryPayload } from '../src/lotterySettings.js';
const require = createRequire(import.meta.url);
const { createPoolManagement } = require('../lottery-backend/pool-management.cjs');
const { createService } = require('../lottery-backend/service.js');
const { createManagementHttp } = require('../lottery-backend/management-http.cjs');
const { createLotteryBridge } = require('../payments/lottery.cjs');
const { createCouponStore } = require('../coupons/store.cjs');
const { createPosFixture } = require('./helpers/posfixture.cjs');

async function fixture() {
  let tables = new Map(), queue = Promise.resolve();
  const store = { transaction(fn) {
    const job = queue.then(async () => {
      const copy = structuredClone(tables);
      const result = await fn({ get: async (table, id) => structuredClone(copy.get(`${table}:${id}`)), set: async (table, id, value) => copy.set(`${table}:${id}`, structuredClone(value)) });
      tables = copy; return result;
    });
    queue = job.catch(() => {}); return job;
  } };
  const now = () => 1790000000000;
  const prizes = [{ id: 'cap', name: '帽子', kind: 'physical', probability: 50 }, { id: 'tote', name: '购物袋', kind: 'physical', probability: 50 }];
  const campaign = { id: 'fixture-pool', title: '测试活动', enabled: false, inventory: { version: 1, total: 4, quantities: { cap: 2, tote: 2 } }, startsAt: now() - 1, endsAt: now() + 100000, redeemEndsAt: now() + 100000 };
  let ticket = 0, limit = null;
  let capacity = { prizes: { cap: { quota: 100, issued: 0, enabled: true }, tote: { quota: 100, issued: 0, enabled: true } } };
  const service = createService({ store, campaign, prizes, now, randomIndex: n => { limit = n; return ticket; }, makeCode: () => crypto.randomBytes(8).toString('hex').toUpperCase(), entryId: id => id, adminIds: ['admin'] });
  await service('initializePool', {}, 'admin'); campaign.enabled = true;
  const pool = createPoolManagement({ store, campaign, prizes, now, getCenter: async () => capacity });
  const update = async (operation, rest = {}) => pool.update({ requestId: crypto.randomUUID(), expectedRevision: (await pool.snapshot()).revision, operation, reason: '隔离测试', ...rest });
  return { store, pool, service, campaign, prizes, now, update, setTicket: n => { ticket = n; }, getLimit: () => limit, setCapacity: value => { capacity = value; }, tables: () => structuredClone(tables) };
}

test('existing pool remains untouched until an explicit update; old awards and codes survive quota and mode changes', async () => {
  const f = await fixture();
  const first = await f.service('draw', {}, 'old');
  const original = f.tables(); await f.pool.snapshot(); assert.deepEqual(f.tables(), original);
  await f.update('pause');
  await f.update('configure', { mode: 'fixed', quantities: { cap: 3, tote: 2 }, weightsBps: { cap: 1000, tote: 9000 } });
  const current = f.tables();
  assert.deepEqual(current.get('entries:old'), original.get('entries:old'));
  assert.deepEqual(current.get('codes:' + first.code), original.get('codes:' + first.code));
  assert.equal((await f.service('draw', {}, 'old')).code, first.code);
  assert.equal((await f.pool.snapshot()).allocated, 1);
  await assert.rejects(f.service('draw', {}, 'new'), e => e.code === 'PAUSED');
});

test('fixed mode uses exact basis-point ranges independent of remaining quantities', async () => {
  const f = await fixture(); await f.update('pause');
  await f.update('configure', { mode: 'fixed', quantities: { cap: 3, tote: 90 }, weightsBps: { cap: 2500, tote: 7500 } });
  await f.update('resume'); f.setTicket(2499);
  assert.equal((await f.service('draw', {}, 'one')).prize.id, 'cap'); assert.equal(f.getLimit(), 10000);
  f.setTicket(2500); assert.equal((await f.service('draw', {}, 'two')).prize.id, 'tote');
  f.setTicket(9999); assert.equal((await f.service('draw', {}, 'three')).prize.id, 'tote');
  const state = await f.service('state', {}, 'new');
  assert.deepEqual(state.prizes.map(p => p.probability), [25, 75]);
});

test('any depleted positive-probability prize blocks every new draw without reallocating probability', async () => {
  const f = await fixture(); await f.update('pause');
  await f.update('configure', { mode: 'fixed', quantities: { cap: 1, tote: 3 }, weightsBps: { cap: 1000, tote: 9000 } });
  await f.update('resume'); await f.service('draw', {}, 'winner'); f.setTicket(9000);
  const before = f.tables();
  await assert.rejects(f.service('draw', {}, 'blocked'), e => e.code === 'FIXED_STOCK_EMPTY');
  assert.deepEqual(f.tables(), before);
  assert.match((await f.service('state', {}, 'blocked')).drawError, /固定概率抽奖已暂停/);
  assert.ok((await f.service('draw', {}, 'winner')).code);
  await f.update('pause'); await assert.rejects(f.update('resume'), e => e.code === 'FIXED_STOCK_EMPTY');
  await f.update('configure', { mode: 'fixed', quantities: { cap: 1, tote: 3 }, weightsBps: { cap: 0, tote: 10000 } });
  await f.update('resume'); assert.equal((await f.service('draw', {}, 'recovered')).prize.id, 'tote');
});

test('inventory mode still samples remaining slots and does not use stored fixed weights', async () => {
  const f = await fixture(); f.setTicket(1);
  assert.equal((await f.service('draw', {}, 'one')).prize.id, 'cap'); assert.equal(f.getLimit(), 4);
  assert.equal((await f.service('draw', {}, 'two')).prize.id, 'tote'); assert.equal(f.getLimit(), 3);
});

test('edits require pause, valid totals and weights, and can never erase allocated awards', async () => {
  const f = await fixture(); await f.service('draw', {}, 'one');
  const change = { mode: 'fixed', quantities: { cap: 2, tote: 2 }, weightsBps: { cap: 5000, tote: 5000 } };
  await assert.rejects(f.update('configure', change), e => e.code === 'POOL_ACTIVE'); await f.update('pause');
  for (const patch of [{ quantities: { cap: 0, tote: 2 } }, { quantities: { cap: 1.5, tote: 2 } }, { weightsBps: { cap: 5000, tote: 4999 } }, { weightsBps: { cap: -1, tote: 10001 } }, { mode: 'bogus' }, { quantities: { cap: 1, tote: 2, extra: 1 } }]) {
    const before = f.tables(); await assert.rejects(f.update('configure', { ...change, ...patch })); assert.deepEqual(f.tables(), before);
  }
  await f.update('configure', { ...change, quantities: { cap: 1, tote: 1 }, weightsBps: { cap: 0, tote: 10000 } });
  assert.equal((await f.pool.snapshot()).remaining, 1);
});

test('concurrent admin revisions conflict; retried identical request cannot double-adjust quota', async () => {
  const f = await fixture();
  const input = { operation: 'pause', expectedRevision: 0, requestId: crypto.randomUUID(), reason: '暂停' };
  const results = await Promise.allSettled([f.pool.update(input), f.pool.update({ ...input, requestId: crypto.randomUUID() })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  assert.equal((await f.pool.update(input)).duplicate, true);
  await assert.rejects(f.pool.update({ ...input, reason: '篡改原因' }));
  assert.equal((await f.pool.snapshot()).audit.length, 1);
});

test('failed and concurrent draws never oversell a fixed prize; configuration and pool mutate atomically', async () => {
  const f = await fixture(); await f.update('pause'); await f.update('configure', { mode: 'fixed', quantities: { cap: 1, tote: 10 }, weightsBps: { cap: 10000, tote: 0 } }); await f.update('resume');
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => f.service('draw', {}, 'customer' + i)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await f.pool.snapshot()).allocated, 1);
});

test('center caps block expansion or resume, but unavailable center cannot prevent pause', async () => {
  const f = await fixture(); f.setCapacity(null); await f.update('pause');
  const change = { mode: 'inventory', quantities: { cap: 3, tote: 2 }, weightsBps: { cap: 5000, tote: 5000 } };
  await assert.rejects(f.update('configure', change), e => e.code === 'CENTER_CAPACITY');
  await f.update('configure', { ...change, quantities: { cap: 1, tote: 2 } });
  await assert.rejects(f.update('resume'), e => e.code === 'CENTER_CAPACITY');
  f.setCapacity({ prizes: { cap: { quota: 10, issued: 2 }, tote: { quota: 10, issued: 0 } } });
  await assert.rejects(f.update('resume'), e => e.code === 'CENTER_CAPACITY');
});

test('pool corruption and expired activity fail closed; initialization cannot reset managed awards', async () => {
  const f = await fixture(); await f.update('pause');
  f.campaign.enabled = false;
  await assert.rejects(f.service('initializePool', {}, 'admin'), e => e.code === 'POOL_ACTIVE');
  f.campaign.endsAt = f.now() - 1; await assert.rejects(f.update('resume'));
  await f.store.transaction(async tx => { const stock = await tx.get('pools', f.campaign.id + ':stock'); await tx.set('pools', f.campaign.id + ':stock', { ...stock, remaining: 99 }); });
  await assert.rejects(f.pool.snapshot(), e => e.code === 'POOL_CORRUPT');
});

test('admin gateway rejects missing identity, modified messages, stale timestamps and replay', async () => {
  const f = await fixture(), key = 'a'.repeat(64);
  const handler = createManagementHttp({ ...f, key, now: f.now });
  const signed = (payload, time = String(f.now())) => {
    const body = JSON.stringify(payload), nonce = crypto.randomUUID();
    return { httpMethod: 'POST', body, headers: { 'content-type': 'application/json', 'x-lottery-time': time, 'x-lottery-nonce': nonce,
      'x-lottery-signature': crypto.createHmac('sha256', key).update(time + '\n' + nonce + '\n' + body).digest('hex') } };
  };
  const input = { action: 'snapshot', campaignId: f.campaign.id };
  assert.equal((await handler({ httpMethod: 'POST', body: JSON.stringify(input) })).statusCode, 401);
  const modified = signed(input); modified.body += ' '; assert.equal((await handler(modified)).statusCode, 401);
  assert.equal((await handler(signed(input, String(f.now() - 121000)))).statusCode, 401);
  const request = signed(input); const result = await handler(request); assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse((await handler(request)).body).code, 'REPLAY');
  assert.equal((await handler(signed({ ...input, campaignId: 'other' }))).statusCode, 400);
  const browser = signed(input); browser.headers.origin = 'https://attacker.invalid'; assert.equal((await handler(browser)).statusCode, 401);
});

test('cashier management connection keeps signing key off public responses and supports encrypted transfer', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lottery-client-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const key = 'b'.repeat(64), campaignId = 'fixture-pool';
  let calls = 0;
  const fetchFn = async (url, options) => {
    assert.equal(url, 'https://fixture.invalid/lottery'); assert.equal(options.redirect, 'error');
    const h = options.headers;
    assert.equal(h['X-Lottery-Signature'], crypto.createHmac('sha256', key).update(h['X-Lottery-Time'] + '\n' + h['X-Lottery-Nonce'] + '\n' + options.body).digest('hex'));
    assert.ok(!options.body.includes(key)); calls++;
    return Response.json({ ok: true, data: { service: 'bubble-lottery-management', version: 1, campaignId } });
  };
  const bridge = createLotteryBridge({ directory, fetchFn, protect: value => 'protected:' + value, unprotect: value => value.slice(10) });
  assert.equal((await bridge.dispatch('config')).configured, false);
  await bridge.dispatch('connect', { url: 'https://fixture.invalid/lottery', key, campaignId });
  assert.ok(!JSON.stringify(await bridge.dispatch('config')).includes(key));
  const bundle = await bridge.dispatch('export-connection', { password: 'test-password-long' });
  assert.ok(!JSON.stringify(bundle).includes(key));
  await assert.rejects(bridge.dispatch('import-connection', { bundle, password: 'wrong-password-long' }));
  await bridge.dispatch('import-connection', { bundle, password: 'test-password-long' });
  assert.equal(calls, 2);
  await assert.rejects(bridge.dispatch('connect', { url: 'http://fixture.invalid/lottery', key, campaignId }));
});

test('coupon quota increases are admin-only, idempotent and never reduce commitments', async t => {
  const pos = await createPosFixture(t);
  const center = await createCouponStore({ pool: pos.pool, ns: pos.ns });
  const actor = { id: 'admin', role: 'admin' };
  const c = await center.dispatch(actor, 'create-campaign', { requestId: crypto.randomUUID(), name: 'test', kind: 'cash', amountCents: 500, minimumCents: 0, quota: 5, startsAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() });
  const input = { requestId: crypto.randomUUID(), id: c.id, quota: 10, reason: '补充五份' };
  assert.equal((await center.dispatch(actor, 'increase-quota', input)).quota, 10);
  assert.equal((await center.dispatch(actor, 'increase-quota', input)).lastQuotaAdjustment.reason, input.reason);
  assert.equal((await center.dispatch(actor, 'increase-quota', input)).quota, 10);
  await assert.rejects(center.dispatch(actor, 'increase-quota', { ...input, requestId: crypto.randomUUID(), quota: 8 }));
  await assert.rejects(center.dispatch({ id: 'lottery', role: 'lottery', campaignId: c.id }, 'increase-quota', { ...input, requestId: crypto.randomUUID() }));
});

test('management accepts historical cash campaigns without kind and does not rewrite their records', async () => {
  const { createManagementCenter } = require('../lottery-backend/management-center.cjs');
  const campaign = { startsAt: 1790000000000, redeemEndsAt: 1790100000000 };
  const old = { id: 'old-cash', amountCents: 500, quota: 100, issued: 6, enabled: true,
    startsAt: new Date(campaign.startsAt).toISOString(), expiresAt: new Date(campaign.redeemEndsAt).toISOString() };
  const before = structuredClone(old);
  const center = createManagementCenter({ campaign, prizes: [{ id: 'cash5', kind: 'cash', amount: 5 }],
    config: { baseUrl: 'https://fixture.invalid', centerId: 'test', adminToken: 'a'.repeat(64), prizes: { cash5: old.id } },
    fetchFn: async (url, options) => {
      assert.equal(options.method, 'GET');
      const route = new URL(url).pathname;
      return Response.json({ ok: true, data: route === '/v1/info' ? { service: 'stall-coupon-center', centerId: 'test', environment: 'production', role: 'admin' }
        : route === '/v1/campaigns' ? [old] : { total: 2 } });
    } });
  assert.equal((await center.counts()).prizes.cash5.redeemed, 2);
  assert.deepEqual(old, before);
});

test('UI converts decimal percentages exactly, validates totals and preserves server revision', () => {
  assert.equal(percentToBps('0.01'), 1); assert.equal(percentToBps('33.33'), 3333);
  for (const value of ['1.001', '-1', '101', 'NaN', '1e2', '']) assert.throws(() => percentToBps(value));
  const snapshot = { revision: 3, mode: 'fixed', prizes: [{ id: 'cap', name: '帽子', quota: 10, allocated: 2, weightBps: 3333 }, { id: 'tote', name: '袋子', quota: 20, allocated: 3, weightBps: 6667 }] };
  const draft = lotteryDraft(snapshot), payload = lotteryPayload(snapshot, draft, '核对');
  assert.equal(payload.expectedRevision, 3); assert.equal(payload.weightsBps.cap, 3333);
  assert.throws(() => lotteryPayload(snapshot, { ...draft, quantities: { cap: '1', tote: '20' } }, '核对'));
});
