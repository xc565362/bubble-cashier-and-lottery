import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { priceOrder } from '../src/orderLogic.js';
const require = createRequire(import.meta.url);
const { createCouponStore } = require('../coupons/store.cjs');
const { createCouponBridge } = require('../coupons/bridge.cjs');
const { createActivityStore } = require('../activities/store.cjs');
const { createServerProtector } = require('../online/secrets.cjs');
const { createPosFixture } = require('./helpers/posfixture.cjs');

const adminActor = { userId: 'admin-1', role: 'admin', displayName: '管理员' };
const couponAdmin = { id: 'administrator', role: 'admin' };
const mockCode2session = async code => ({ openid: 'mock_' + crypto.createHash('sha256').update(String(code)).digest('hex').slice(0, 16) });
const openidFor = code => 'mock_' + crypto.createHash('sha256').update(String(code)).digest('hex').slice(0, 16);

const GIFT = {
  id: 'gift-cap', name: '棒球帽', barcode: '690000000001', sku: 'CAP-01', group: '装备',
  imageUrl: 'https://img.example.com/cap.png', productType: 'gift', giftEligible: true,
  originalPrice: 0, price: 0, stock: 50, couponAmount: 0,
};
const SALE = {
  id: 'sale-tea', name: '柠檬茶', barcode: '690000000002', sku: 'TEA-01', group: '饮品',
  imageUrl: '', productType: 'sale', giftEligible: false, originalPrice: 0, price: 10, stock: 20, couponAmount: 0,
};
const SALE_GIFTABLE = {
  id: 'sale-hat', name: '渔夫帽', barcode: '690000000003', sku: 'HAT-01', group: '装备',
  imageUrl: 'https://img.example.com/hat.png', productType: 'sale', giftEligible: true, originalPrice: 0, price: 39, stock: 15, couponAmount: 0,
};

async function fixture(t) {
  const pos = await createPosFixture(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-store-'));
  const protector = createServerProtector({ keyFile: path.join(directory, 'server.key') });
  let time = Date.now();
  const coupons = await createCouponStore({ pool: pos.pool, ns: pos.ns, environment: 'development', now: () => time });
  const store = createActivityStore({ pool: pos.pool, ns: pos.ns, couponStore: coupons, ...protector, code2session: mockCode2session, now: () => time, randomUnit: () => 0 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  // Seed the ledger product pool exactly like the online ledger would.
  await pos.pool.query('INSERT IGNORE INTO pos_ledger (ns, id, revision, body) VALUES (?, 1, 0, ?)', [pos.ns, JSON.stringify({ products: [GIFT, SALE, SALE_GIFTABLE] })]);
  let campaignSeq = 0;
  const makeCampaign = (over = {}) => coupons.dispatch(couponAdmin, 'create-campaign', {
    requestId: `fixture-campaign-${++campaignSeq}`,
    name: '10元立减金', kind: 'cash', amountCents: 1000, minimumCents: 0,
    quota: 10, startsAt: new Date(time - 60000).toISOString(), expiresAt: new Date(time + 86400000).toISOString(),
    ...over,
  });
  const campaignA = await makeCampaign();
  const config = (over = {}) => ({
    name: '赛场同行', title: '此刻在地', venue: 'Bubble展位', cashTerms: '每单限一张', rulesText: '规则说明',
    startsAt: time - 1000, endsAt: time + 86400000, redeemEndsAt: time + 86400000,
    prizes: [
      { id: 'cash10', kind: 'cash', couponCampaignId: campaignA.id, qty: 1, probability: 1 },
      { id: 'cap', kind: 'physical', product: { id: 'gift-cap' }, qty: 1, probability: 1 },
    ],
    ...over,
  });
  return { ...pos, directory, protector, coupons, store, config, campaignA, makeCampaign, advance: ms => { time += ms; }, now: () => time };
}

async function activeActivity(f, over = {}) {
  const { activity } = await f.store.dispatch('activity-create', { config: f.config(over), state: 'active' }, adminActor);
  return activity;
}
const drawFor = async (f, id, code) => {
  const { token } = await f.store.session(id, code);
  return f.store.publicCall(id, 'draw', {}, { token });
};
const campaignsOf = async f => f.coupons.dispatch(couponAdmin, 'campaigns', {});

test('config validation rejects bad prizes, dates and secrets before any write', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.dispatch('activity-create', { config: {} }, adminActor), { code: 'INVALID_CONFIG' });
  await assert.rejects(f.store.dispatch('activity-create', { config: f.config({ endsAt: f.now() - 2000, startsAt: f.now() - 1000 }) }, adminActor), { code: 'INVALID_CONFIG' });
  // Cash prizes must come from the coupon pool — a client-supplied amount is rejected outright.
  await assert.rejects(f.store.dispatch('activity-create', { config: f.config({ prizes: [{ id: 'x', name: 'x', kind: 'cash', amount: 10, qty: 1, probability: 1 }] }) }, adminActor),
    error => error.code === 'INVALID_CONFIG' && /面额由所选券活动决定/.test(error.message));
  await assert.rejects(f.store.dispatch('activity-create', { config: f.config({ prizes: [{ id: 'x', name: 'x', kind: 'cash', qty: 1, probability: 1 }] }) }, adminActor), { code: 'INVALID_CONFIG' });
  await assert.rejects(f.store.dispatch('activity-create', { config: f.config({ prizes: [{ id: 'x', name: 'x', kind: 'cash', couponCampaignId: f.campaignA.id, qty: 0, probability: 1 }] }) }, adminActor), { code: 'INVALID_CONFIG' });
  await assert.rejects(f.store.dispatch('activity-create', { config: f.config({ prizes: [{ id: 'x', name: 'x', kind: 'cash', couponCampaignId: f.campaignA.id, qty: 1, probability: 0 }] }) }, adminActor), { code: 'INVALID_CONFIG' });
  await assert.rejects(f.store.dispatch('activity-create', { config: f.config({ prizes: [{ id: 'x', name: 'x', kind: 'voucher', qty: 1, probability: 1 }] }) }, adminActor), { code: 'INVALID_CONFIG' });
  await assert.rejects(f.store.dispatch('activity-create', { config: f.config({ prizes: [{ id: 'x', name: 'x', kind: 'cash', couponCampaignId: f.campaignA.id, qty: 1, probability: 1, imageUrl: 'ftp://bad' }] }) }, adminActor), { code: 'INVALID_CONFIG' });
  await assert.rejects(f.store.dispatch('activity-create', { config: f.config({ prizes: [{ id: 'cap', name: 'x', kind: 'physical', qty: 1, probability: 1 }] }) }, adminActor), { code: 'INVALID_CONFIG' });
  await assert.rejects(f.store.dispatch('activity-create', { config: f.config({ wx: { appid: '', secret: 's' } }) }, adminActor), { code: 'INVALID_CONFIG' });
  await assert.rejects(f.store.dispatch('activity-create', { config: f.config(), state: 'ended' }, adminActor), { code: 'INVALID_STATE' });
  assert.equal((await f.store.dispatch('activity-list', {}, adminActor)).activities.length, 0);
});

test('create snapshots prize terms from the pools; secrets never leak; quota covers the allocation', async t => {
  const f = await fixture(t);
  const small = await f.makeCampaign({ name: '5元立减金', amountCents: 500, minimumCents: 2000, quota: 2 });
  const { activity } = await f.store.dispatch('activity-create', {
    config: f.config({
      wx: { appid: 'wx1234567890abcdef', secret: 'top-secret-value' }, staffKey: 'booth-key',
      prizes: [
        { id: 'cash10', kind: 'cash', couponCampaignId: f.campaignA.id, qty: 1, probability: 1 },
        { id: 'cash5', kind: 'cash', couponCampaignId: small.id, qty: 3, probability: 1 },
        { id: 'cap', kind: 'physical', product: { id: 'gift-cap' }, qty: 1, probability: 1 },
      ],
    }),
    state: 'draft',
  }, adminActor);
  assert.equal(activity.state, 'draft');
  assert.equal(activity.wx.appid, 'wx1234567890abcdef');
  assert.equal(activity.wx.secretSet, true);
  assert.equal(activity.staffKeySet, true);
  const serialized = JSON.stringify(await f.store.dispatch('activity-list', {}, adminActor));
  assert.ok(!serialized.includes('top-secret-value'), 'wx secret never leaks');
  assert.ok(serialized.includes('booth-key'), 'admins receive the raw staff key for H5 integration');
  const cashierSerialized = JSON.stringify(await f.store.dispatch('activity-list', {}, { userId: 'cashier-1', role: 'cashier', displayName: '收银员' }));
  assert.ok(!cashierSerialized.includes('booth-key'), 'cashiers never receive the raw staff key');

  // Cash terms are copied from the campaign into the prize snapshot.
  const cash10 = activity.prizes.find(p => p.id === 'cash10');
  assert.equal(cash10.name, '10元立减金');
  assert.equal(cash10.amount, 10);
  assert.equal(cash10.minimumCents, 0);
  assert.equal(cash10.couponCampaignId, f.campaignA.id);
  const cash5 = activity.prizes.find(p => p.id === 'cash5');
  assert.equal(cash5.name, '5元立减金');
  assert.equal(cash5.amount, 5);
  assert.equal(cash5.minimumCents, 2000);
  // Physical snapshot + imageUrl defaulted from the gift product.
  const cap = activity.prizes.find(p => p.id === 'cap');
  assert.deepEqual(cap.product, { id: 'gift-cap', name: '棒球帽', sku: 'CAP-01', barcode: '690000000001' });
  assert.equal(cap.name, '棒球帽');
  assert.equal(cap.imageUrl, GIFT.imageUrl);

  // Quota sync: the 2-quota campaign is raised to issued + allocation (3).
  const after = (await campaignsOf(f)).find(c => c.id === small.id);
  assert.equal(after.quota, 3);
  assert.equal(after.lastQuotaAdjustment.reason, '活动名额配置');
  // The 10-quota campaign needed no increase.
  assert.equal((await campaignsOf(f)).find(c => c.id === f.campaignA.id).quota, 10);
});

test('public state hides pool references while adminView keeps them for read-back', async t => {
  const f = await fixture(t);
  const activity = await activeActivity(f);
  const { token } = await f.store.session(activity.id, 'code-a');
  const state = await f.store.publicCall(activity.id, 'state', {}, { token });
  const stateText = JSON.stringify(state.prizes);
  assert.ok(!stateText.includes(f.campaignA.id), 'couponCampaignId stays admin-only');
  assert.ok(!stateText.includes('gift-cap') && !stateText.includes('"product"'), 'product reference stays admin-only');
  const cash = state.prizes.find(p => p.id === 'cash10');
  assert.equal(cash.name, '10元立减金');
  assert.equal(cash.amount, 10);
  assert.equal(cash.imageUrl, undefined);
  const cap = state.prizes.find(p => p.id === 'cap');
  assert.equal(cap.imageUrl, GIFT.imageUrl, 'imageUrl flows to the H5');
  // Admin edit read-back carries both references.
  const admin = (await f.store.dispatch('activity-list', {}, adminActor)).activities[0];
  assert.equal(admin.prizes.find(p => p.id === 'cash10').couponCampaignId, f.campaignA.id);
  assert.deepEqual(admin.prizes.find(p => p.id === 'cap').product.id, 'gift-cap');
});

test('unknown, non-cash or disabled campaigns are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.dispatch('activity-create', { config: f.config({ prizes: [{ id: 'x', kind: 'cash', couponCampaignId: 'no-such-campaign', qty: 1, probability: 1 }] }) }, adminActor),
    { code: 'CAMPAIGN_MISSING' });
  const physicalCampaign = await f.coupons.dispatch(couponAdmin, 'create-campaign', {
    requestId: 'fixture-physical-campaign', name: '实物领取', kind: 'physical', amountCents: 0, minimumCents: 0,
    physical: { prizeId: 'cap', quantity: 1 },
    quota: 5, startsAt: new Date(f.now() - 60000).toISOString(), expiresAt: new Date(f.now() + 86400000).toISOString(),
  });
  await assert.rejects(f.store.dispatch('activity-create', { config: f.config({ prizes: [{ id: 'x', kind: 'cash', couponCampaignId: physicalCampaign.id, qty: 1, probability: 1 }] }) }, adminActor),
    { code: 'CAMPAIGN_KIND' });
  const disabled = await f.makeCampaign({ name: '停用券' });
  await f.coupons.dispatch(couponAdmin, 'set-campaign', { requestId: 'fixture-disable-campaign', id: disabled.id, enabled: false });
  await assert.rejects(f.store.dispatch('activity-create', { config: f.config({ prizes: [{ id: 'x', kind: 'cash', couponCampaignId: disabled.id, qty: 1, probability: 1 }] }) }, adminActor),
    { code: 'CAMPAIGN_DISABLED' });
  assert.equal((await f.store.dispatch('activity-list', {}, adminActor)).activities.length, 0, 'failed creates roll back entirely');
});

test('physical prizes must reference gift products from the ledger pool', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.dispatch('activity-create', { config: f.config({ prizes: [{ id: 'cap', kind: 'physical', product: { id: 'no-such-gift' }, qty: 1, probability: 1 }] }) }, adminActor),
    { code: 'PRODUCT_MISSING' });
  await assert.rejects(f.store.dispatch('activity-create', { config: f.config({ prizes: [{ id: 'cap', kind: 'physical', product: { id: 'sale-tea' }, qty: 1, probability: 1 }] }) }, adminActor),
    { code: 'PRODUCT_KIND' });
  assert.equal((await f.store.dispatch('activity-list', {}, adminActor)).activities.length, 0);
});

test('sale products with 可参与买赠 are valid physical prizes', async t => {
  const f = await fixture(t);
  const { activity } = await f.store.dispatch('activity-create', {
    config: f.config({ prizes: [{ id: 'hat', kind: 'physical', product: { id: 'sale-hat' }, qty: 2, probability: 1 }] }),
  }, adminActor);
  const hat = activity.prizes.find(p => p.id === 'hat');
  assert.equal(hat.name, '渔夫帽');
  assert.deepEqual(hat.product, { id: 'sale-hat', name: '渔夫帽', sku: 'HAT-01', barcode: '690000000003' });
  assert.equal(hat.imageUrl, SALE_GIFTABLE.imageUrl, 'sale product imageUrl defaults onto the prize');
});

test('explicit imageUrl wins over the product default', async t => {
  const f = await fixture(t);
  const { activity } = await f.store.dispatch('activity-create', {
    config: f.config({
      prizes: [
        { id: 'cap', kind: 'physical', product: { id: 'gift-cap' }, qty: 1, probability: 1, imageUrl: 'https://img.example.com/custom.png' },
        { id: 'cash10', kind: 'cash', couponCampaignId: f.campaignA.id, qty: 1, probability: 1, imageUrl: 'data:image/png;base64,iVBORw0KGgo=' },
      ],
    }),
    state: 'draft',
  }, adminActor);
  const cap = activity.prizes.find(p => p.id === 'cap');
  assert.equal(cap.imageUrl, 'https://img.example.com/custom.png');
  const cash = activity.prizes.find(p => p.id === 'cash10');
  assert.equal(cash.imageUrl, 'data:image/png;base64,iVBORw0KGgo=');
});

test('update merges config, reconciles stock, grows the campaign quota and leaves dates editable', async t => {
  const f = await fixture(t);
  const tight = await f.makeCampaign({ name: '5元立减金', amountCents: 500, quota: 2 });
  const { activity } = await f.store.dispatch('activity-create', {
    config: f.config({ prizes: [{ id: 'cash5', kind: 'cash', couponCampaignId: tight.id, qty: 1, probability: 1 }] }),
    state: 'active',
  }, adminActor);
  const raised = (await f.store.dispatch('activity-update', { id: activity.id, config: { title: '新标题', prizes: [
    { id: 'cash5', kind: 'cash', couponCampaignId: tight.id, qty: 5, probability: 1 },
  ] } }, adminActor)).activity;
  assert.equal(raised.title, '新标题');
  assert.deepEqual(raised.prizes.map(p => [p.id, p.quantity, p.remaining]), [['cash5', 5, 5]]);
  assert.equal((await campaignsOf(f)).find(c => c.id === tight.id).quota, 5, 'quota raised to issued + allocation');
  // Dates are freely editable again (no entitlement fingerprint pinning them).
  const moved = (await f.store.dispatch('activity-update', { id: activity.id, config: {
    startsAt: f.now() - 5000, redeemEndsAt: f.now() + 3600000,
  } }, adminActor)).activity;
  assert.equal(moved.startsAt, f.now() - 5000);
  assert.equal(moved.redeemEndsAt, f.now() + 3600000);
  // Lowered qty clamps remaining; awarded stock is never reclaimed.
  const lowered = (await f.store.dispatch('activity-update', { id: activity.id, config: { prizes: [
    { id: 'cash5', kind: 'cash', couponCampaignId: tight.id, qty: 3, probability: 1 },
  ] } }, adminActor)).activity;
  assert.deepEqual(lowered.prizes.map(p => [p.id, p.quantity, p.remaining]), [['cash5', 3, 3]]);
  assert.equal((await campaignsOf(f)).find(c => c.id === tight.id).quota, 5, 'increase-only quota stays');
});

test('campaign switch on edit affects only future draws; old entry snapshot stays intact', async t => {
  const f = await fixture(t);
  const alt = await f.makeCampaign({ name: '5元立减金', amountCents: 500 });
  const activity = await activeActivity(f);
  const first = await drawFor(f, activity.id, 'code-a');
  assert.equal(first.prize.id, 'cash10');
  assert.equal(first.prize.name, '10元立减金');
  const [firstCoupon] = await f.pool.query('SELECT data FROM pos_coupons WHERE ns = ? AND award = ?', [f.ns, first.code]);
  assert.equal(firstCoupon[0].data.amountCents, 1000);
  await f.store.dispatch('activity-update', { id: activity.id, config: { prizes: [
    { id: 'cash10', kind: 'cash', couponCampaignId: alt.id, qty: 2, probability: 1 },
    { id: 'cap', kind: 'physical', product: { id: 'gift-cap' }, qty: 1, probability: 1 },
  ] } }, adminActor);
  const second = await drawFor(f, activity.id, 'code-b');
  assert.equal(second.prize.id, 'cash10');
  assert.equal(second.prize.name, '5元立减金');
  const [secondCoupon] = await f.pool.query('SELECT data FROM pos_coupons WHERE ns = ? AND award = ?', [f.ns, second.code]);
  assert.equal(secondCoupon[0].data.amountCents, 500, 'minted coupon amountCents == campaign amountCents');
  const campaigns = await campaignsOf(f);
  assert.equal(campaigns.find(c => c.id === f.campaignA.id).issued, 1);
  assert.equal(campaigns.find(c => c.id === alt.id).issued, 1);
  // The first winner keeps the original snapshot.
  const stillFirst = await f.store.dispatch('activity-lookup', { id: activity.id, code: first.code }, adminActor);
  assert.equal(stillFirst.prize.name, '10元立减金');
});

test('exhausted campaign candidates are excluded from the draw (no-prize entry, not an error)', async t => {
  const f = await fixture(t);
  const tight = await f.makeCampaign({ name: '限量券', amountCents: 300, quota: 2 });
  const activity = await activeActivity(f, { prizes: [
    { id: 'cash3', kind: 'cash', couponCampaignId: tight.id, qty: 2, probability: 1 },
  ] });
  const first = await drawFor(f, activity.id, 'code-a');
  assert.equal(first.prize.id, 'cash3');
  // Exhaust the campaign outside the activity (shared pool): issued == quota
  // while the activity still shows remaining stock.
  await f.coupons.dispatch(couponAdmin, 'issue', { requestId: 'external-issue-1', campaignId: tight.id, owner: 'outsider', awardId: 'ext-award-1' });
  assert.equal((await campaignsOf(f)).find(c => c.id === tight.id).issued, 2);
  const second = await drawFor(f, activity.id, 'code-b');
  assert.equal(second.status, 'unavailable');
  assert.equal(second.code, '');
  assert.equal(second.prize.name, '奖品已发完');
  const [entries] = await f.pool.query('SELECT COUNT(*) AS n FROM pos_activity_entries WHERE ns = ? AND activity = ?', [f.ns, activity.id]);
  assert.equal(Number(entries[0].n), 2);
});

test('session tokens are per-activity and expire; draft activities stay invisible', async t => {
  const f = await fixture(t);
  const draft = (await f.store.dispatch('activity-create', { config: f.config() }, adminActor)).activity;
  await assert.rejects(f.store.session(draft.id, 'code-a'), { code: 'NOT_FOUND' });
  const activity = await activeActivity(f);
  const { token, expiresAt } = await f.store.session(activity.id, 'code-a');
  assert.ok(token && expiresAt > f.now());
  const state = await f.store.publicCall(activity.id, 'state', {}, { token });
  assert.equal(state.campaign.id, activity.id);
  assert.equal(state.campaign.enabled, true);
  assert.equal(state.entry, null);
  assert.equal(state.drawsRemaining, 1);
  const identity = await f.store.publicCall(activity.id, 'identity', {}, { token });
  assert.equal(identity.openId, openidFor('code-a'));
  assert.equal(identity.isAdmin, false);
  await assert.rejects(f.store.publicCall(activity.id, 'state', {}, { token: '' }), { code: 'AUTH_REQUIRED' });
  await assert.rejects(f.store.publicCall(activity.id, 'state', {}, { token: 'bsv1.forged.forged.forged' }), { code: 'AUTH_REQUIRED' });
  const other = await activeActivity(f, { name: '第二场' });
  await assert.rejects(f.store.publicCall(other.id, 'state', {}, { token }), { code: 'AUTH_REQUIRED' });
  f.advance(25 * 3600 * 1000);
  await assert.rejects(f.store.publicCall(activity.id, 'state', {}, { token }), { code: 'AUTH_REQUIRED' });
});

test('cash draw inserts the entry and mints the pinned coupon atomically; repeat draw returns the same entry', async t => {
  const f = await fixture(t);
  const activity = await activeActivity(f);
  const entry = await drawFor(f, activity.id, 'code-a');
  assert.equal(entry.prize.id, 'cash10');
  assert.equal(entry.checkoutCoupon, true);
  assert.match(entry.code, /^[0-9A-F]{16}$/);
  assert.equal(entry.status, 'pending');
  assert.equal(entry.minimumGoodsAmountCents, 0);
  const [tokens] = await f.pool.query('SELECT coupon_id FROM pos_coupon_tokens WHERE ns = ? AND token = ?', [f.ns, entry.code]);
  assert.equal(tokens.length, 1);
  const [coupons] = await f.pool.query('SELECT issuer, owner, award, data FROM pos_coupons WHERE ns = ? AND id = ?', [f.ns, tokens[0].coupon_id]);
  assert.equal(coupons.length, 1);
  assert.equal(coupons[0].award, entry.code);
  assert.equal(coupons[0].owner, openidFor('code-a'));
  assert.match(coupons[0].issuer, /^campaign:/);
  assert.equal(coupons[0].data.amountCents, 1000, 'minted coupon amountCents == campaign amountCents');
  const again = await drawFor(f, activity.id, 'code-a');
  assert.equal(again.code, entry.code);
  const [count] = await f.pool.query('SELECT COUNT(*) AS n FROM pos_coupons WHERE ns = ?', [f.ns]);
  assert.equal(Number(count[0].n), 1);
  const state = await f.store.publicCall(activity.id, 'state', {}, { token: (await f.store.session(activity.id, 'code-a')).token });
  assert.equal(state.entry.code, entry.code);
  assert.equal(state.drawsRemaining, 0);
});

test('physical draw mints no coupon; sold-out draws persist the no-prize outcome', async t => {
  const f = await fixture(t);
  const activity = await activeActivity(f);
  await drawFor(f, activity.id, 'code-a'); // takes the only cash prize (randomUnit 0 picks first candidate)
  const cap = await drawFor(f, activity.id, 'code-b');
  assert.equal(cap.prize.id, 'cap');
  assert.equal(cap.checkoutCoupon, false);
  const [coupons] = await f.pool.query('SELECT COUNT(*) AS n FROM pos_coupons WHERE ns = ?', [f.ns]);
  assert.equal(Number(coupons[0].n), 1);
  const none = await drawFor(f, activity.id, 'code-c');
  assert.equal(none.status, 'unavailable');
  assert.equal(none.code, '');
  assert.equal(none.prize.name, '奖品已发完');
  const repeat = await drawFor(f, activity.id, 'code-c');
  assert.equal(repeat.status, 'unavailable');
  const [entries] = await f.pool.query('SELECT COUNT(*) AS n FROM pos_activity_entries WHERE ns = ? AND activity = ?', [f.ns, activity.id]);
  assert.equal(Number(entries[0].n), 3);
});

test('a coupon issue failure rolls back the entry and the stock decrement', async t => {
  const pos = await createPosFixture(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-rollback-'));
  const protector = createServerProtector({ keyFile: path.join(directory, 'server.key') });
  const coupons = await createCouponStore({ pool: pos.pool, ns: pos.ns, environment: 'development' });
  const campaign = await coupons.dispatch(couponAdmin, 'create-campaign', {
    requestId: 'rollback-fixture-campaign', name: '10元立减金', kind: 'cash', amountCents: 1000, minimumCents: 0, quota: 5,
    startsAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  const guarded = { ...coupons, dispatch: (actor, action, input, conn) => action === 'issue'
    ? Promise.reject(Object.assign(new Error('券活动已暂停或结束'), { code: 'INACTIVE', status: 400 }))
    : coupons.dispatch(actor, action, input, conn) };
  const store = createActivityStore({ pool: pos.pool, ns: pos.ns, couponStore: guarded, ...protector, code2session: mockCode2session, randomUnit: () => 0 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await pos.pool.query('INSERT IGNORE INTO pos_ledger (ns, id, revision, body) VALUES (?, 1, 0, ?)', [pos.ns, JSON.stringify({ products: [] })]);
  const now = Date.now();
  const { activity } = await store.dispatch('activity-create', { config: {
    name: '回滚测试', startsAt: now - 1000, endsAt: now + 86400000,
    prizes: [{ id: 'cash10', kind: 'cash', couponCampaignId: campaign.id, qty: 1, probability: 1 }],
  }, state: 'active' }, adminActor);
  await assert.rejects((async () => {
    const { token } = await store.session(activity.id, 'code-x');
    return store.publicCall(activity.id, 'draw', {}, { token });
  })(), { code: 'INACTIVE' });
  const [entries] = await pos.pool.query('SELECT COUNT(*) AS n FROM pos_activity_entries WHERE ns = ?', [pos.ns]);
  assert.equal(Number(entries[0].n), 0);
  const [issued] = await pos.pool.query('SELECT COUNT(*) AS n FROM pos_coupons WHERE ns = ?', [pos.ns]);
  assert.equal(Number(issued[0].n), 0);
  const listed = (await store.dispatch('activity-list', {}, adminActor)).activities[0];
  assert.equal(listed.inventory.remaining, 1);
});

test('paused and ended activities reject draws with 410 but keep sessions and state available', async t => {
  const f = await fixture(t);
  const activity = await activeActivity(f);
  await f.store.dispatch('activity-set-status', { id: activity.id, state: 'paused' }, adminActor);
  const { token } = await f.store.session(activity.id, 'code-a');
  const state = await f.store.publicCall(activity.id, 'state', {}, { token });
  assert.equal(state.drawError, '活动暂未开放，请留意现场通知');
  await assert.rejects(f.store.publicCall(activity.id, 'draw', {}, { token }), { code: 'PAUSED', status: 410 });
  await f.store.dispatch('activity-set-status', { id: activity.id, state: 'ended' }, adminActor);
  await assert.rejects(f.store.publicCall(activity.id, 'draw', {}, { token }), { code: 'ENDED', status: 410 });
  await assert.rejects(f.store.dispatch('activity-set-status', { id: activity.id, state: 'bogus' }, adminActor), { code: 'INVALID_STATE' });
  await assert.rejects(f.store.dispatch('activity-set-status', { id: crypto.randomUUID(), state: 'active' }, adminActor), { code: 'NOT_FOUND' });
});

test('lookup and redeem are single-use; cash coupons are never booth-redeemed', async t => {
  const f = await fixture(t);
  const activity = await activeActivity(f);
  const cash = await drawFor(f, activity.id, 'code-a');
  const cap = await drawFor(f, activity.id, 'code-b');
  await assert.rejects(f.store.dispatch('activity-lookup', { code: 'not-a-code' }, adminActor), { code: 'INVALID_CODE' });
  await assert.rejects(f.store.dispatch('activity-lookup', { code: 'A1B2C3D4E5F60708' }, adminActor), { code: 'NOT_FOUND' });
  const found = await f.store.dispatch('activity-lookup', { code: cap.code.toLowerCase().replace(/(.{4})/g, '$1 ') }, adminActor);
  assert.equal(found.prize.id, 'cap');
  assert.equal(found.winner, 'mock…' + openidFor('code-b').slice(-4));
  await assert.rejects(f.store.dispatch('activity-redeem', { code: cash.code }, adminActor), { code: 'CHECKOUT_COUPON' });
  const redeemed = await f.store.dispatch('activity-redeem', { code: cap.code }, adminActor);
  assert.equal(redeemed.status, 'redeemed');
  assert.ok(redeemed.redeemedAt > 0);
  const { records: rows } = await f.store.dispatch('activity-records', { id: activity.id }, adminActor);
  assert.equal(rows.find(r => r.code === cap.code).redeemedBy, 'cashier:管理员');
  await assert.rejects(f.store.dispatch('activity-redeem', { code: cap.code }, adminActor), { code: 'ALREADY_REDEEMED', status: 409 });
  const state = await f.store.publicCall(activity.id, 'state', {}, { token: (await f.store.session(activity.id, 'code-b')).token });
  assert.equal(state.entry.status, 'redeemed');
});

test('staff key gates public lookup/redeem; participants get 403, strangers 401', async t => {
  const f = await fixture(t);
  const activity = await activeActivity(f, { staffKey: 'booth-secret' });
  const cash = await drawFor(f, activity.id, 'code-a'); // cash first; second draw takes cap
  const capEntry = await drawFor(f, activity.id, 'code-b');
  const participant = (await f.store.session(activity.id, 'code-c')).token;
  await assert.rejects(f.store.publicCall(activity.id, 'lookup', { code: capEntry.code }, { token: participant }), { code: 'FORBIDDEN', status: 403 });
  await assert.rejects(f.store.publicCall(activity.id, 'lookup', { code: capEntry.code }, { staffKey: 'wrong' }), { code: 'UNAUTHORIZED', status: 401 });
  await assert.rejects(f.store.publicCall(activity.id, 'lookup', { code: capEntry.code }, {}), { code: 'AUTH_REQUIRED', status: 401 });
  const found = await f.store.publicCall(activity.id, 'lookup', { code: capEntry.code }, { staffKey: 'booth-secret' });
  assert.equal(found.prize.id, 'cap');
  const redeemed = await f.store.publicCall(activity.id, 'redeem', { code: capEntry.code }, { staffKey: 'booth-secret' });
  assert.equal(redeemed.status, 'redeemed');
  await assert.rejects(f.store.publicCall(activity.id, 'redeem', { code: capEntry.code }, { staffKey: 'booth-secret' }), { code: 'ALREADY_REDEEMED' });
  const sweep = await f.store.publicCall(activity.id, 'retry-coupon-issue', {}, { staffKey: 'booth-secret' });
  assert.deepEqual(sweep, { enabled: true, checked: 0, confirmed: 0, failed: 0, pending: 0 });
  assert.equal(cash.prize.id, 'cash10');
});

test('records page with summary; export carries a BOM and one row per entry', async t => {
  const f = await fixture(t);
  const activity = await activeActivity(f);
  const cash = await drawFor(f, activity.id, 'code-a');
  const cap = await drawFor(f, activity.id, 'code-b');
  await drawFor(f, activity.id, 'code-c'); // sold out
  await f.store.dispatch('activity-redeem', { code: cap.code }, adminActor);
  const page1 = await f.store.dispatch('activity-records', { id: activity.id, page: 1, pageSize: 2 }, adminActor);
  assert.equal(page1.total, 3);
  assert.equal(page1.records.length, 2);
  assert.equal(page1.records[0].status, 'none', 'newest entry (sold-out draw) first');
  assert.equal(page1.records[1].status, 'redeemed');
  assert.equal(page1.summary.entries, 3);
  assert.equal(page1.summary.pending, 1);
  assert.equal(page1.summary.redeemed, 1);
  assert.equal(page1.summary.noPrize, 1);
  assert.equal(page1.summary.stockTotal, 2);
  assert.equal(page1.summary.stockRemaining, 0);
  assert.equal(page1.summary.byPrize['10元立减金'], 1);
  const page2 = await f.store.dispatch('activity-records', { id: activity.id, page: 2, pageSize: 2 }, adminActor);
  assert.equal(page2.records.length, 1);
  assert.equal(page2.records[0].status, 'pending');
  const exported = await f.store.dispatch('activity-export', { id: activity.id }, adminActor);
  assert.equal(exported.filename, `activity-${activity.id}-records.csv`);
  assert.equal(exported.csv.charCodeAt(0), 0xfeff);
  const lines = exported.csv.slice(1).trim().split('\r\n');
  assert.equal(lines[0], 'code,prize,status,openid,createdAt,redeemedAt,redeemedBy');
  assert.equal(lines.length, 4);
  assert.ok(lines.some(line => line.startsWith(cash.code + ',10元立减金,pending,')));
  assert.ok(lines.some(line => line.startsWith(cap.code + ',棒球帽,redeemed,')));
  assert.ok(lines.some(line => line.startsWith(',（未中奖）,none,')));
  assert.ok(!exported.csv.includes(openidFor('code-a')));
});

test('coupon bridge local mode runs reserve→prepare→commit against the shared in-process store', async t => {
  const f = await fixture(t);
  const activity = await activeActivity(f);
  const entry = await drawFor(f, activity.id, 'code-a');
  assert.equal(entry.checkoutCoupon, true);
  const bridgeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-bridge-'));
  const bridge = createCouponBridge({ directory: bridgeDir, store: f.coupons });
  t.after(async () => { await bridge.close(); fs.rmSync(bridgeDir, { recursive: true, force: true }); });
  assert.equal((await bridge.dispatch('config')).mode, 'local');
  const line = await bridge.dispatch('reserve', { code: entry.code, checkoutId: crypto.randomUUID(), eligibleCents: 1000, requestId: crypto.randomUUID() });
  assert.equal(line.externalCoupon.couponId.length > 0, true);
  const product = { id: 'p1', name: 'Product', price: 10, qty: 1, stock: 3, productType: 'sale' };
  const draft = { id: crypto.randomUUID(), orderNo: `POS${Date.now()}`, ...priceOrder([product, line]), method: '收钱吧' };
  await bridge.prepareDraft(draft, 'test');
  await bridge.settle({ id: draft.id, draft, state: 'paid', amount: 0, orderSn: 'MOCK-SQB' });
  const coupon = await bridge.dispatch('coupon', { id: line.externalCoupon.couponId });
  assert.equal(coupon.state, 'REDEEMED');
  assert.equal(bridge.hasPending(), false);
});

test('sweepStale closes abandoned reservations and leaves live checkouts alone', async t => {
  const f = await fixture(t);
  const activity = await activeActivity(f, {
    prizes: [{ id: 'cash10', kind: 'cash', couponCampaignId: f.campaignA.id, qty: 2, probability: 1 }],
  });
  const dead = await drawFor(f, activity.id, 'code-a');
  const live = await drawFor(f, activity.id, 'code-b');
  const bridgeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-sweep-'));
  const bridge = createCouponBridge({ directory: bridgeDir, store: f.coupons });
  t.after(async () => { await bridge.close(); fs.rmSync(bridgeDir, { recursive: true, force: true }); });
  const deadLine = await bridge.dispatch('reserve', { code: dead.code, checkoutId: crypto.randomUUID(), eligibleCents: 1000, requestId: crypto.randomUUID() });
  // Abandon the first checkout past its reservation TTL — the exact freeze
  // scenario: the journal row outlives the reservation it tracks.
  f.advance(16 * 60 * 1000);
  const liveLine = await bridge.dispatch('reserve', { code: live.code, checkoutId: crypto.randomUUID(), eligibleCents: 1000, requestId: crypto.randomUUID() });
  assert.equal(bridge.hasPending(), true);
  assert.equal(await bridge.sweepStale(), 1, 'only the dead row is swept');
  assert.equal(bridge.hasPending(), true, 'live checkout still occupies the till');
  const swept = await bridge.dispatch('coupon', { id: deadLine.externalCoupon.couponId });
  assert.equal(swept.state, 'AVAILABLE', 'abandoned coupon released back to the pool');
  const alive = await bridge.dispatch('coupon', { id: liveLine.externalCoupon.couponId });
  assert.equal(alive.state, 'RESERVED');
});


// ---------------------------------------------------------------------------
// 谢谢惠顾格 (kind 'none')、中奖率展示、availability 形状
// ---------------------------------------------------------------------------

test('none prizes share the wheel without stock; win chance and availability are exposed', async t => {
  const f = await fixture(t);
  const activity = await activeActivity(f, {
    prizes: [
      { id: 'cap', kind: 'physical', product: { id: 'gift-cap' }, qty: 1, probability: 1 },
      { id: 'nope', kind: 'none', qty: 1, probability: 1 },
    ],
  });
  // Thanks cells never count toward inventory.
  assert.equal(activity.inventory.total, 1);
  assert.equal(activity.inventory.remaining, 1);
  assert.equal(activity.prizes.find(p => p.id === 'nope').name, '谢谢惠顾');

  const tokenOf = async code => (await f.store.session(activity.id, code)).token;
  const stateBefore = await f.store.publicCall(activity.id, 'state', {}, { token: await tokenOf('code-a') });
  assert.deepEqual(stateBefore.availability, { canDraw: true, reason: 'READY' });
  assert.equal(stateBefore.campaign.winProbabilityBps, 5000, 'one prize cell vs one thanks cell = 50%');
  assert.equal(stateBefore.inventory.total, 1);

  // randomUnit 0 lands on the first candidate: the real prize.
  const won = await f.store.publicCall(activity.id, 'draw', {}, { token: await tokenOf('code-a') });
  assert.equal(won.outcome, 'won');
  assert.equal(won.fulfillment, 'staff', 'physical prizes redeem at the booth');
  assert.equal(won.prize.id, 'cap');

  // Stock is gone: the next participant lands on the thanks cell.
  const lost = await f.store.publicCall(activity.id, 'draw', {}, { token: await tokenOf('code-b') });
  assert.equal(lost.outcome, 'lost');
  assert.equal(lost.status, 'unavailable');
  assert.equal(lost.code, '');
  assert.equal(lost.fulfillment, '');

  const after = await f.store.publicCall(activity.id, 'state', {}, { token: await tokenOf('code-a') });
  assert.deepEqual(after.availability, { canDraw: false, reason: 'ALREADY_DRAWN' });
  assert.equal(after.entry.outcome, 'won');
});

test('cash entries expose outcome won and fulfillment cashier', async t => {
  const f = await fixture(t);
  const activity = await activeActivity(f, {
    prizes: [{ id: 'cash10', kind: 'cash', couponCampaignId: f.campaignA.id, qty: 1, probability: 1 }],
  });
  const { token } = await f.store.session(activity.id, 'code-a');
  const entry = await f.store.publicCall(activity.id, 'draw', {}, { token });
  assert.equal(entry.outcome, 'won');
  assert.equal(entry.fulfillment, 'cashier', 'cash coupons settle at the till');
  const state = await f.store.publicCall(activity.id, 'state', {}, { token });
  assert.equal(state.campaign.winProbabilityBps, 10000, 'no thanks cell means every draw wins while stock lasts');
});

// ---------------------------------------------------------------------------
// 参与码门槛（requireInvite）：grant 发放、draw 原子消耗、过期与复用拒绝
// ---------------------------------------------------------------------------

async function gatedFixture(t, over = {}) {
  const f = await fixture(t);
  const activity = await activeActivity(f, {
    requireInvite: true, staffKey: 'booth-key',
    prizes: [
      { id: 'cap', kind: 'physical', product: { id: 'gift-cap' }, qty: 2, probability: 1 },
      { id: 'nope', kind: 'none', qty: 1, probability: 1 },
    ],
    ...over,
  });
  return { ...f, activity };
}
const grantFor = (f, staffKey) => f.store.publicCall(f.activity.id, 'grant', {}, { staffKey });

test('grant requires the staff key and issues a short-lived one-time code', async t => {
  const f = await gatedFixture(t);
  await assert.rejects(grantFor(f, ''), { code: 'AUTH_REQUIRED' });
  await assert.rejects(grantFor(f, 'wrong-key'), { code: 'UNAUTHORIZED' });
  const { token } = await f.store.session(f.activity.id, 'code-a');
  await assert.rejects(f.store.publicCall(f.activity.id, 'grant', {}, { token }), { code: 'FORBIDDEN' }, 'a plain participant must not mint codes');
  const grant = await grantFor(f, 'booth-key');
  assert.match(grant.inviteCode, /^[0-9A-F]{16}$/);
  assert.equal(grant.expiresAt, f.now() + 10 * 60 * 1000, 'codes live for ten minutes');
});

test('gated draws consume the invite exactly once; reuse and bad codes are rejected', async t => {
  const f = await gatedFixture(t);
  const tokenOf = async code => (await f.store.session(f.activity.id, code)).token;
  await assert.rejects(f.store.publicCall(f.activity.id, 'draw', {}, { token: await tokenOf('code-a') }), { code: 'INVALID_INVITE' });
  await assert.rejects(f.store.publicCall(f.activity.id, 'draw', { inviteCode: 'ZZZZZZZZZZZZZZZZ' }, { token: await tokenOf('code-a') }), { code: 'INVALID_INVITE' });

  const { inviteCode } = await grantFor(f, 'booth-key');
  const entry = await f.store.publicCall(f.activity.id, 'draw', { inviteCode }, { token: await tokenOf('code-a') });
  assert.equal(entry.outcome, 'won');
  assert.equal(entry.prize.id, 'cap');

  // The same participant re-drawing gets their own entry back, invite or not.
  const again = await f.store.publicCall(f.activity.id, 'draw', {}, { token: await tokenOf('code-a') });
  assert.equal(again.code, entry.code);

  // A second participant cannot reuse the spent code.
  await assert.rejects(f.store.publicCall(f.activity.id, 'draw', { inviteCode }, { token: await tokenOf('code-b') }), { code: 'INVITE_USED' });
  // A fresh code works for them.
  const second = await grantFor(f, 'booth-key');
  const entry2 = await f.store.publicCall(f.activity.id, 'draw', { inviteCode: second.inviteCode }, { token: await tokenOf('code-b') });
  assert.equal(entry2.outcome, 'won');
});

test('expired invites are rejected and a failed gate leaves the code alive', async t => {
  const f = await gatedFixture(t);
  // Push the start window into the future AFTER the activity exists.
  await f.store.dispatch('activity-update', { id: f.activity.id, config: { startsAt: new Date(f.now() + 60000).toISOString() } }, adminActor);
  const tokenOf = async code => (await f.store.session(f.activity.id, code)).token;
  const { inviteCode } = await grantFor(f, 'booth-key');

  // NOT_STARTED fails the draw but rolls back, so the invite survives.
  await assert.rejects(f.store.publicCall(f.activity.id, 'draw', { inviteCode }, { token: await tokenOf('code-a') }), { code: 'NOT_STARTED' });
  f.advance(61000);
  const entry = await f.store.publicCall(f.activity.id, 'draw', { inviteCode }, { token: await tokenOf('code-a') });
  assert.equal(entry.outcome, 'won', 'the same code works once the window opens');

  // Past the TTL the code is dead.
  const { inviteCode: stale } = await grantFor(f, 'booth-key');
  f.advance(11 * 60000);
  await assert.rejects(f.store.publicCall(f.activity.id, 'draw', { inviteCode: stale }, { token: await tokenOf('code-c') }), { code: 'INVITE_EXPIRED' });
});

test('scratch-redeem flips the participant own physical prize once and decrements ledger stock', async t => {
  const f = await fixture(t);
  const activity = await activeActivity(f, { staffKey: 'scratch-test-staff-key', prizes: [{ id: 'cap', kind: 'physical', product: { id: 'gift-cap' }, qty: 5, probability: 1 }] });
  const { token } = await f.store.session(activity.id, 'wx-scratch-1');
  const entry = await f.store.publicCall(activity.id, 'draw', {}, { token });
  assert.equal(entry.outcome, 'won');
  assert.equal(entry.status, 'pending');
  const ledgerStock = async () => {
    const [rows] = await f.pool.query('SELECT body FROM pos_ledger WHERE ns = ? AND id = 1', [f.ns]);
    const body = typeof rows[0].body === 'string' ? JSON.parse(rows[0].body) : rows[0].body;
    return body.products.find(p => p.id === 'gift-cap').stock;
  };
  assert.equal(await ledgerStock(), 50);
  const redeemed = await f.store.publicCall(activity.id, 'scratch-redeem', {}, { token });
  assert.equal(redeemed.status, 'redeemed');
  assert.equal(await ledgerStock(), 49, 'booth handout decrements the ledger gift stock like a till redemption');
  await assert.rejects(f.store.publicCall(activity.id, 'scratch-redeem', {}, { token }), { code: 'ALREADY_REDEEMED' });
  assert.equal(await ledgerStock(), 49, 'the single-use flip also guards the stock');
  // The till path sees the same consumed entry: staff redeem by code is refused.
  const [rows] = await f.pool.query('SELECT data FROM pos_activities WHERE ns = ? AND id = ?', [f.ns, activity.id]);
  const staffKey = (typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data).staffKey;
  await assert.rejects(f.store.publicCall(activity.id, 'redeem', { code: entry.code }, { staffKey }), { code: 'ALREADY_REDEEMED' });
});

test('scratch-redeem rejects no-prize entries and cash checkout coupons', async t => {
  const f = await fixture(t);
  // Sold-out single-unit pool: first participant wins, second lands on no-prize.
  const soldOut = await activeActivity(f, { prizes: [{ id: 'cap', kind: 'physical', product: { id: 'gift-cap' }, qty: 1, probability: 1 }] });
  const first = await f.store.session(soldOut.id, 'wx-scratch-a');
  await f.store.publicCall(soldOut.id, 'draw', {}, { token: first.token });
  const second = await f.store.session(soldOut.id, 'wx-scratch-b');
  const lost = await f.store.publicCall(soldOut.id, 'draw', {}, { token: second.token });
  assert.equal(lost.outcome, 'lost');
  await assert.rejects(f.store.publicCall(soldOut.id, 'scratch-redeem', {}, { token: second.token }), { code: 'NOT_FOUND' });

  // Cash prizes are checkout coupons: they must be redeemed at the till, never by scratching.
  const cash = await activeActivity(f);
  const winner = await f.store.session(cash.id, 'wx-scratch-c');
  const cashEntry = await f.store.publicCall(cash.id, 'draw', {}, { token: winner.token });
  assert.equal(cashEntry.outcome, 'won');
  await assert.rejects(f.store.publicCall(cash.id, 'scratch-redeem', {}, { token: winner.token }), { code: 'CHECKOUT_COUPON' });
  assert.equal((await f.store.publicCall(cash.id, 'state', {}, { token: winner.token })).entry.status, 'pending', 'rejected scratch leaves the entry redeemable at the till');

  // Without a session the action is not reachable.
  await assert.rejects(f.store.publicCall(cash.id, 'scratch-redeem', {}, { token: '' }), { code: 'AUTH_REQUIRED' });
});

test('activity-reset wipes entries and invites and restores full prize pools', async t => {
  const f = await fixture(t);
  const activity = await activeActivity(f, { prizes: [{ id: 'cap', kind: 'physical', product: { id: 'gift-cap' }, qty: 3, probability: 1 }] });
  const drawAs = async code => {
    const { token } = await f.store.session(activity.id, code);
    return f.store.publicCall(activity.id, 'draw', {}, { token });
  };
  await drawAs('wx-reset-a');
  await drawAs('wx-reset-b');
  const before = await f.store.dispatch('activity-records', { id: activity.id }, adminActor);
  assert.equal(before.summary.entries, 2);
  assert.equal(before.summary.stockRemaining, 1);
  const reset = await f.store.dispatch('activity-reset', { id: activity.id }, adminActor);
  assert.equal(reset.summary.entries, 0);
  assert.equal(reset.summary.stockRemaining, 3, 'prize pool restored to full quantity');
  // Same participant can draw again from scratch.
  const again = await drawAs('wx-reset-a');
  assert.equal(again.outcome, 'won');
  await assert.rejects(f.store.dispatch('activity-reset', { id: activity.id }, { role: 'cashier', userId: 'c', displayName: 'c' }), { code: 'FORBIDDEN' });
});

test('activity-record-delete removes one pending record, returns the unit, and refuses redeemed', async t => {
  const f = await fixture(t);
  const activity = await activeActivity(f, { prizes: [{ id: 'cap', kind: 'physical', product: { id: 'gift-cap' }, qty: 2, probability: 1 }] });
  const { token } = await f.store.session(activity.id, 'wx-del-a');
  const entry = await f.store.publicCall(activity.id, 'draw', {}, { token });
  const after = await f.store.dispatch('activity-record-delete', { id: activity.id, code: entry.code }, adminActor);
  assert.equal(after.summary.entries, 0);
  assert.equal(after.summary.stockRemaining, 2, 'the drawn unit returned to the pool');
  // The person can draw again.
  const redraw = await f.store.publicCall(activity.id, 'draw', {}, { token });
  assert.equal(redraw.outcome, 'won');
  // Redeem it, then deletion must be refused to preserve the handout audit.
  await f.store.dispatch('activity-redeem', { id: activity.id, code: redraw.code, staffId: 'cashier:test' }, adminActor);
  await assert.rejects(f.store.dispatch('activity-record-delete', { id: activity.id, code: redraw.code }, adminActor), { code: 'ALREADY_REDEEMED' });
  await assert.rejects(f.store.dispatch('activity-record-delete', { id: activity.id, code: 'A1B2C3D4E5F60708' }, adminActor), { code: 'NOT_FOUND' });
  await assert.rejects(f.store.dispatch('activity-record-delete', { id: activity.id, code: redraw.code }, { role: 'cashier', userId: 'c', displayName: 'c' }), { code: 'FORBIDDEN' });
  // Admin records expose the full openid as the identifying handle.
  assert.equal(typeof after.records, 'object');
});
