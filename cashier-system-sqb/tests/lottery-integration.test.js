import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCouponStore } = require('../coupons/store.cjs');
const { endpoints } = require('../coupons/http.cjs');
const { createCenterLottery } = require('../lottery-backend/center-lottery.cjs');
const { createPhysicalCenter } = require('../lottery-backend/physical-center.cjs');
const { createService } = require('../lottery-backend/service.js');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lottery-integration-'));
  const now = Date.parse('2026-09-21T12:00:00+08:00');
  let time = now;
  const center = createCouponStore({ file: path.join(directory, 'center.sqlite'), environment: 'production', now: () => time });
  t.after(() => { center.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const admin = { id: 'administrator', role: 'admin' };
  const call = (action, payload = {}) => center.dispatch(admin, action, { requestId: crypto.randomUUID(), ...payload });
  const prizes = [{ id: 'cash5', kind: 'cash', amount: 5, name: '5元立减金', probability: 50 }, { id: 'cap', kind: 'physical', name: '棒球帽', probability: 50 }];
  const campaign = { id: 'fixture', enabled: true, startsAt: now - 10000, endsAt: now + 86400000, redeemEndsAt: now + 86400000, cashFulfilment: 'checkout_coupon' };
  const common = { baseUrl: 'https://fixture.invalid', centerId: call('info').centerId, environment: 'production', prizes: {} };
  const cashConfig = structuredClone(common);
  const physicalConfig = { ...structuredClone(common), stage: 'migrating', handoffReadyAt: now - 1 };
  for (const prize of prizes) {
    const physical = prize.kind === 'physical';
    const c = call('create-campaign', { name: prize.name, kind: prize.kind, ...(physical ? { physical: { prizeId: prize.id, quantity: 1 }, redemptionEnabled: false } : {}),
      amountCents: physical ? 0 : 500, minimumCents: 0, quota: 10, startsAt: new Date(campaign.startsAt).toISOString(), expiresAt: new Date(campaign.redeemEndsAt).toISOString() });
    const key = call('create-key', { name: prize.id, role: 'lottery', campaignId: c.id });
    (physical ? physicalConfig : cashConfig).prizes[prize.id] = { campaignId: c.id, token: key.token, minimumCents: 0 };
  }
  const tables = new Map();
  const store = { async transaction(fn) {
    return fn({ get: async (table, id) => structuredClone(tables.get(`${table}:${id}`)),
      set: async (table, id, value) => tables.set(`${table}:${id}`, structuredClone(value)) });
  } };
  const fetchFn = async (url, options) => {
    assert.equal(new URL(url).origin, common.baseUrl);
    const action = Object.entries(endpoints).find(([, [method, route]]) => method === options.method && route === new URL(url).pathname)?.[0];
    assert.ok(action, 'Only known coupon routes may be called');
    try {
      const actor = center.authenticate(options.headers.Authorization.slice(7));
      return new Response(JSON.stringify({ ok: true, data: center.dispatch(actor, action, options.body ? JSON.parse(options.body) : {}) }));
    } catch (error) { return new Response(JSON.stringify({ ok: false, code: error.code }), { status: error.status || 500 }); }
  };
  const options = { store, prizes, campaign, now: () => time, entryId: id => id, adminIds: ['admin'], makeCode: () => 'ABCDEF0123456789', randomTicket: () => 0,
    createService, centerConfig: cashConfig, fetchFn };
  const service = createPhysicalCenter({ ...options, base: createCenterLottery(options), physicalConfig });
  return { service, store, center, call, campaign, physicalConfig, prizes, now, setNow: value => { time = value; }, options };
}

function closeEarlier(f) {
  f.campaign.endsAt = f.now + 1000;
  f.campaign.redemptionEndsAt = f.campaign.endsAt;
  f.call('set-deadline', { campaignIds: f.call('campaigns').map(c => c.id), redemptionEndsAt: new Date(f.campaign.endsAt).toISOString(), reason: 'Fixture deadline' });
}

test('earlier closing preserves issued cash identities and old codes, then blocks draws and unused cash', async t => {
  const f = fixture(t);
  const award = await f.service('draw', {}, 'old');
  const before = await f.store.transaction(tx => tx.get('entries', 'old'));
  closeEarlier(f);
  const active = (await f.service('state', {}, 'old')).entry;
  assert.equal(active.code, award.code);
  assert.equal(active.status, 'pending');
  assert.equal(active.expiresAt, f.campaign.redemptionEndsAt);
  assert.deepEqual(await f.store.transaction(tx => tx.get('entries', 'old')), before);
  f.setNow(f.campaign.endsAt - 1);
  assert.equal((await f.service('state', {}, 'old')).entry.status, 'pending');
  f.setNow(f.campaign.endsAt);
  await assert.rejects(f.service('draw', {}, 'new'), { code: 'ENDED' });
  const ended = await f.service('state', {}, 'old');
  assert.equal(ended.entry.status, 'expired');
  assert.equal(ended.entry.code, '');
  assert.equal(ended.campaign.redeemEndsAt, f.campaign.redemptionEndsAt);
  assert.throws(() => f.call('reserve', { code: award.code, checkoutId: 'late', eligibleCents: 1000 }), { code: 'NOT_AVAILABLE' });
  assert.equal(f.call('coupons').total, 1);
});

test('cash already in payment at cutoff can complete and synchronize exactly once', async t => {
  const f = fixture(t); closeEarlier(f);
  const award = await f.service('draw', {}, 'paying');
  const held = f.call('reserve', { code: award.code, checkoutId: 'pending', eligibleCents: 1000 });
  f.call('prepare', { id: held.reservation.id, orderId: 'order', orderNo: 'POS', eligibleCents: 1000, paidCents: 500 });
  f.setNow(f.campaign.endsAt);
  assert.equal((await f.service('state', {}, 'paying')).entry.status, 'using');
  const receipt = { id: held.reservation.id, orderId: 'order', paidCents: 500, paymentReference: 'fixture-paid' };
  f.call('commit', receipt); f.call('commit', receipt);
  assert.equal((await f.service('state', {}, 'paying')).entry.status, 'redeemed');
  assert.equal(f.call('coupons', { state: 'REDEEMED' }).total, 1);
});

test('cash only reserved before cutoff cannot start payment afterwards', async t => {
  const f = fixture(t); closeEarlier(f);
  const award = await f.service('draw', {}, 'reserved');
  const held = f.call('reserve', { code: award.code, checkoutId: 'held', eligibleCents: 1000 });
  f.setNow(f.campaign.endsAt);
  assert.equal((await f.service('state', {}, 'reserved')).entry.status, 'expired');
  assert.throws(() => f.call('prepare', { id: held.reservation.id, orderId: 'late', orderNo: 'POS', eligibleCents: 1000, paidCents: 500 }), { code: 'EXPIRED' });
  assert.equal(f.call('release', { id: held.reservation.id }).state, 'EXPIRED');
});

test('unmigrated physical history expires without issuing or rewriting old records', async t => {
  const f = fixture(t); closeEarlier(f);
  const entry = { campaignId: f.campaign.id, prize: f.prizes[1], code: 'ABCDEF0123456789', status: 'pending', createdAt: f.now - 1000 };
  await f.store.transaction(async tx => { await tx.set('entries', 'old', entry); await tx.set('codes', entry.code, { entryId: 'old', campaignId: f.campaign.id }); });
  f.physicalConfig.stage = 'active';
  f.setNow(f.campaign.endsAt);
  const shown = (await f.service('state', {}, 'old')).entry;
  assert.equal(shown.status, 'expired'); assert.equal(shown.expiresAt, f.campaign.redemptionEndsAt);
  assert.equal(f.call('coupons').total, 0);
  assert.deepEqual(await f.store.transaction(tx => tx.get('entries', 'old')), entry);
  const legacy = createService(f.options);
  await assert.rejects(legacy('redeem', { code: entry.code }, 'admin'), { code: 'EXPIRED' });
});

test('physical on-demand binding keeps original expiry while the new deadline closes redemption', async t => {
  const f = fixture(t);
  const entry = { campaignId: f.campaign.id, prize: f.prizes[1], code: 'ABCDEF0123456789', status: 'pending', createdAt: f.now - 1000 };
  await f.store.transaction(async tx => { await tx.set('entries', 'old', entry); await tx.set('codes', entry.code, { entryId: 'old', campaignId: f.campaign.id }); });
  f.physicalConfig.stage = 'active';
  f.call('set-campaign', { id: f.physicalConfig.prizes.cap.campaignId, enabled: true, redemptionEnabled: true });
  assert.equal((await f.service('state', {}, 'old')).entry.status, 'pending');
  const before = await f.store.transaction(tx => tx.get('entries', 'old'));
  closeEarlier(f);
  const active = (await f.service('state', {}, 'old')).entry;
  assert.equal(active.code, entry.code); assert.equal(active.status, 'pending');
  const after = await f.store.transaction(tx => tx.get('entries', 'old'));
  assert.deepEqual(after.physicalCenter, before.physicalCenter);
  f.setNow(f.campaign.endsAt);
  assert.equal((await f.service('state', {}, 'old')).entry.status, 'expired');
  assert.throws(() => f.call('reserve', { code: entry.code, checkoutId: 'late', eligibleCents: 0 }), { code: 'NOT_AVAILABLE' });
  assert.equal(f.call('coupons').total, 1);
});

test('lottery cash award becomes unavailable while reserved and redeemed after checkout without another draw', async t => {
  const f = fixture(t);
  const award = await f.service('draw', {}, 'customer');
  assert.match(award.code, /^LJC1_[0-9A-F]{32}$/);
  assert.equal((await f.service('draw', {}, 'customer')).code, award.code);
  const reserved = f.call('reserve', { code: award.code, checkoutId: 'checkout', eligibleCents: 1000 });
  const using = (await f.service('state', {}, 'customer')).entry;
  assert.equal(using.status, 'using'); assert.equal(using.code, '');
  f.call('prepare', { id: reserved.reservation.id, orderId: 'order', orderNo: 'POS', eligibleCents: 1000, paidCents: 500 });
  f.call('commit', { id: reserved.reservation.id, orderId: 'order', paidCents: 500, paymentReference: 'mock-payment' });
  const redeemed = (await f.service('state', {}, 'customer')).entry;
  assert.equal(redeemed.status, 'redeemed'); assert.equal(redeemed.code, '');
  assert.equal(f.call('coupons').total, 1);
});

test('historical physical migration keeps old codes, skips collected prizes and switches phone redemption off', async t => {
  const f = fixture(t);
  const entry = { campaignId: f.campaign.id, prize: f.prizes[1], code: 'ABCDEF0123456789', status: 'pending', createdAt: f.now - 1000 };
  await f.store.transaction(async tx => {
    await tx.set('entries', 'old', entry);
    await tx.set('codes', entry.code, { entryId: 'old', campaignId: f.campaign.id });
    await tx.set('entries', 'collected', { ...entry, code: 'ABCDEF0123456790', status: 'redeemed', redeemedAt: f.now - 10 });
  });
  await assert.rejects(f.service('migratePhysical', { entryIds: ['old'] }, 'customer'), error => error.code === 'FORBIDDEN');
  const migrated = await f.service('migratePhysical', { entryIds: ['old', 'collected'] }, 'admin');
  assert.deepEqual(migrated.entries.map(e => e.status), ['pending', 'redeemed']);
  await f.service('migratePhysical', { entryIds: ['old'] }, 'admin');
  assert.equal(f.call('coupons').total, 1);
  assert.throws(() => f.call('reserve', { code: entry.code, checkoutId: 'early', eligibleCents: 0 }), error => error.code === 'REDEMPTION_PAUSED');
  await assert.rejects(f.service('redeem', { code: entry.code }, 'admin'), error => error.code === 'POS_REQUIRED');
  f.physicalConfig.stage = 'active';
  f.call('set-campaign', { id: f.physicalConfig.prizes.cap.campaignId, enabled: true, redemptionEnabled: true });
  const row = f.call('reserve', { code: entry.code, checkoutId: 'physical', eligibleCents: 0 });
  assert.equal((await f.service('state', {}, 'old')).entry.status, 'using');
  f.call('prepare', { id: row.reservation.id, orderId: 'gift-order', orderNo: 'GIFT', eligibleCents: 0, paidCents: 0 });
  f.call('commit', { id: row.reservation.id, orderId: 'gift-order', paidCents: 0, paymentReference: 'ZERO:gift-order' });
  assert.equal((await f.service('state', {}, 'old')).entry.status, 'redeemed');
  assert.equal(f.call('coupons').total, 1);
});

test('physical cutover without a batch keeps old codes and syncs only the customer opening their award', async t => {
  const f = fixture(t);
  const entry = { campaignId: f.campaign.id, prize: f.prizes[1], code: 'ABCDEF0123456789', status: 'pending', createdAt: f.now - 1000 };
  const untouched = { ...entry, code: 'ABCDEF0123456790' };
  const collected = { ...entry, code: 'ABCDEF0123456791', status: 'redeemed', redeemedAt: f.now - 10 };
  await f.store.transaction(async tx => {
    for (const [id, value] of [['old', entry], ['untouched', untouched], ['collected', collected]]) {
      await tx.set('entries', id, value);
      await tx.set('codes', value.code, { entryId: id, campaignId: f.campaign.id });
    }
  });
  assert.equal((await f.service('state', {}, 'old')).entry.status, 'unavailable');
  assert.equal(f.call('coupons').total, 0);
  assert.deepEqual(await f.store.transaction(tx => tx.get('entries', 'old')), entry);
  f.physicalConfig.stage = 'active';
  f.physicalConfig.handoffReadyAt = f.now + 1;
  assert.equal((await f.service('state', {}, 'old')).entry.status, 'unavailable');
  assert.equal(f.call('coupons').total, 0);
  f.physicalConfig.handoffReadyAt = f.now - 1;
  f.call('set-campaign', { id: f.physicalConfig.prizes.cap.campaignId, enabled: true, redemptionEnabled: true });
  const first = (await f.service('state', {}, 'old')).entry;
  assert.equal(first.status, 'pending');
  assert.equal(first.code, entry.code);
  assert.equal((await f.service('state', {}, 'old')).entry.code, entry.code);
  assert.equal((await f.service('state', {}, 'collected')).entry.status, 'redeemed');
  assert.equal(f.call('coupons').total, 1);
  assert.deepEqual(await f.store.transaction(tx => tx.get('entries', 'untouched')), untouched);
  assert.deepEqual(await f.store.transaction(tx => tx.get('entries', 'collected')), collected);
  await assert.rejects(f.service('redeem', { code: entry.code }, 'admin'), error => error.code === 'POS_REQUIRED');
  const row = f.call('reserve', { code: entry.code, checkoutId: 'on-demand', eligibleCents: 0 });
  assert.equal((await f.service('state', {}, 'old')).entry.status, 'using');
  f.call('prepare', { id: row.reservation.id, orderId: 'on-demand-order', orderNo: 'ON-DEMAND', eligibleCents: 0, paidCents: 0 });
  f.call('commit', { id: row.reservation.id, orderId: 'on-demand-order', paidCents: 0, paymentReference: 'ZERO:on-demand-order' });
  assert.equal((await f.service('state', {}, 'old')).entry.status, 'redeemed');
  assert.throws(() => f.call('reserve', { code: entry.code, checkoutId: 'duplicate', eligibleCents: 0 }));
  assert.equal(f.call('coupons').total, 1);
});
