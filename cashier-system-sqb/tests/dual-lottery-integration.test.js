import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { priceOrder, completeOrder } from '../src/orderLogic.js';
import { lotteryDraft, lotteryPayload } from '../src/lotterySettings.js';
import { scarfDraft, scarfPayload } from '../src/scarfSettings.js';
const require = createRequire(import.meta.url);
const { createFixture, STAFF, VISITOR } = require('../scripts/dual-lottery-fixture.cjs');
const { createPreviewServer, isAllowedAction } = require('../scripts/preview-dual-lottery.cjs');
const baseline = require('../lottery-backend/config.js');

async function fixture(t, options) { const f = await createFixture(options); t.after(() => f.close()); return f; }
async function scarfDraw(f, who = VISITOR) { const invitation = await f.scarf.call('grant', {}, STAFF); return f.scarf.call('draw', { inviteCode: invitation.inviteCode }, who); }
async function update(f, kind, operation, fields = {}) {
  const snapshot = await f.payments.dispatch(kind + '-snapshot');
  return f.payments.dispatch(kind + '-update', { revision: snapshot.revision, requestId: crypto.randomUUID(), operation, reason: '双活动隔离集成测试', ...fields });
}
async function originalUpdate(f, operation, fields = {}) {
  const snapshot = await f.payments.dispatch('lottery-snapshot');
  return f.payments.dispatch('lottery-update', { expectedRevision: snapshot.revision, requestId: crypto.randomUUID(), operation, reason: '双活动隔离集成测试', ...fields });
}
async function reserve(f, code, eligibleCents = 0, products = f.products) {
  return f.payments.dispatch('coupon-reserve', { code, products, checkoutId: crypto.randomUUID(), eligibleCents, requestId: crypto.randomUUID() });
}
async function settle(f, ledger, code, goods = []) {
  const eligibleCents = goods.length ? Math.round(priceOrder(goods).total * 100) : 0;
  const line = await reserve(f, code, eligibleCents, ledger.products);
  const draft = { id: crypto.randomUUID(), orderNo: 'DUAL' + crypto.randomBytes(6).toString('hex'), method: '零元结算', ...priceOrder([...goods, line]) };
  assert.equal(draft.total, 0);
  const settled = await f.payments.dispatch('coupon-zero', { draft });
  const next = completeOrder(ledger, settled.draft);
  await f.payments.dispatch('coupon-zero-ack', { id: draft.id });
  assert.throws(() => completeOrder(next, settled.draft));
  await assert.rejects(reserve(f, code, eligibleCents, next.products), /核销|领取|使用/);
  return { ledger: next, line };
}

test('both independent management connections use one verified temporary coupon center without changing production configuration', async t => {
  const source = structuredClone(baseline);
  const f = await fixture(t);
  const [original, scarf] = await Promise.all([f.payments.dispatch('lottery-snapshot'), f.payments.dispatch('scarf-snapshot')]);
  assert.equal(original.title, '此刻在地');
  assert.equal(scarf.campaign.title, '山野有约');
  assert.notEqual(original.campaignId, scarf.campaignId);
  for (const snapshot of [original, scarf]) {
    assert.equal(snapshot.fulfillment.ready, true);
    assert.equal(snapshot.fulfillment.centerId, f.centerId);
    assert.equal(snapshot.fulfillment.environment, 'production');
    assert.doesNotMatch(JSON.stringify(snapshot), /adminToken|tokenSecret|"key":|"token":/);
  }
  assert.equal(original.total, 500); assert.equal(original.prizes.length, 8);
  assert.equal(scarf.inventory.total, 200); assert.equal(scarf.campaign.winProbabilityBps, 5000);
  assert.equal(new Set(f.products.map(p => p.sku)).size, f.products.length);
  assert.ok(original.startsAt < Date.now() && original.endsAt > Date.now());
  assert.deepEqual(baseline, source);
  assert.equal((await f.payments.dispatch('lottery-config')).configured, true);
  assert.equal((await f.payments.dispatch('scarf-config')).configured, true);
});

test('changing either activity through the same cashier leaves the other configuration unchanged and its H5 sees only its own updates', async t => {
  const f = await fixture(t);
  const scarfBefore = await f.payments.dispatch('scarf-snapshot');
  const originalBefore = await f.payments.dispatch('lottery-snapshot');
  const quantities = Object.fromEntries(originalBefore.prizes.map(p => [p.id, p.quota]));
  const weightsBps = Object.fromEntries(originalBefore.prizes.map(p => [p.id, p.weightBps]));
  weightsBps.cash50 += 100; weightsBps.cash10 -= 100;
  await originalUpdate(f, 'pause');
  await originalUpdate(f, 'configure', { mode: 'fixed', quantities, weightsBps });
  await originalUpdate(f, 'resume');
  const originalAfter = await f.payments.dispatch('lottery-snapshot');
  assert.equal(originalAfter.mode, 'fixed');
  assert.equal(originalAfter.prizes.find(p => p.id === 'cash50').effectiveProbability, 2);
  assert.deepEqual(await f.payments.dispatch('scarf-snapshot'), scarfBefore);
  assert.equal((await f.original.call('state', {}, VISITOR)).prizes.find(p => p.id === 'cash50').probability, 2);

  await update(f, 'scarf', 'pause');
  const bottle = f.products.find(p => p.sku === 'DEMO-BOTTLE');
  await update(f, 'scarf', 'configure', { total: 210,
    campaign: { title: scarfBefore.campaign.title, venue: scarfBefore.campaign.venue, startsAt: scarfBefore.campaign.startsAt, endsAt: scarfBefore.campaign.endsAt, redeemEndsAt: scarfBefore.campaign.redeemEndsAt, winProbabilityBps: 2500 },
    prize: { id: 'dual-scarf-bottle', name: '赛事运动水壶', imageUrl: '', product: { id: bottle.id, name: bottle.name, sku: bottle.sku, barcode: bottle.barcode } } });
  await update(f, 'scarf', 'resume');
  assert.deepEqual(await f.payments.dispatch('lottery-snapshot'), originalAfter);
  const scarfAfter = await f.scarf.call('state', {}, VISITOR);
  assert.equal(scarfAfter.campaign.winProbabilityBps, 2500);
  assert.equal(scarfAfter.prize.name, '赛事运动水壶');
  assert.equal(scarfAfter.inventory.total, 210);
  assert.ok(f.counters.originalManagementRequests > 0 && f.counters.scarfManagementRequests > 0);
});

test('cashier rule edits round-trip through both signed management bridges to the correct H5 and can restore defaults', async t => {
  const f = await fixture(t);
  const reason = '隔离测试活动说明同步';
  const originalText = '此刻在地 · 现场参与说明\n请在 Bubble 展位出示中奖凭证。\n\n<script>示例文字</script>';
  const scarfText = '山野有约 · 关注抽好礼\n工作人员确认关注后扫码参加。\n中奖后凭领取码到收银台领取。';
  await originalUpdate(f, 'pause');
  await update(f, 'scarf', 'pause');
  const beforeOriginal = await f.payments.dispatch('lottery-snapshot');
  const beforeScarf = await f.payments.dispatch('scarf-snapshot');
  assert.ok(beforeOriginal.capabilities.includes('rules-text-v1'));
  assert.ok(beforeScarf.capabilities.includes('rules-text-v1'));
  const saveOriginal = async rulesText => {
    const current = await f.payments.dispatch('lottery-snapshot');
    const draft = { ...lotteryDraft(current), rulesText };
    return f.payments.dispatch('lottery-update', { ...lotteryPayload(current, draft, reason), requestId: crypto.randomUUID() });
  };
  const saveScarf = async rulesText => {
    const current = await f.payments.dispatch('scarf-snapshot');
    const draft = { ...scarfDraft(current), rulesText };
    return f.payments.dispatch('scarf-update', { ...scarfPayload(current, draft, reason, f.products), requestId: crypto.randomUUID() });
  };
  await saveOriginal(originalText);
  assert.equal((await f.original.call('state', {}, VISITOR)).campaign.rulesText, originalText);
  assert.equal((await f.scarf.call('state', {}, VISITOR)).campaign.rulesText, '');
  await saveScarf(scarfText);
  assert.equal((await f.scarf.call('state', {}, VISITOR)).campaign.rulesText, scarfText);
  assert.equal((await f.original.call('state', {}, VISITOR)).campaign.rulesText, originalText);
  const afterOriginal = await f.payments.dispatch('lottery-snapshot');
  const afterScarf = await f.payments.dispatch('scarf-snapshot');
  assert.equal(afterOriginal.rulesText, originalText);
  assert.equal(afterScarf.campaign.rulesText, scarfText);
  assert.deepEqual(afterOriginal.prizes, beforeOriginal.prizes);
  assert.deepEqual(afterScarf.prize, beforeScarf.prize);
  assert.deepEqual(afterScarf.inventory, beforeScarf.inventory);
  assert.equal(afterScarf.campaign.winProbabilityBps, beforeScarf.campaign.winProbabilityBps);
  await saveOriginal('');
  await saveScarf('');
  assert.equal((await f.original.call('state', {}, VISITOR)).campaign.rulesText, '');
  assert.equal((await f.scarf.call('state', {}, VISITOR)).campaign.rulesText, '');
  assert.equal(f.counters.blockedExternalRequests, 0);
});

test('original physical prize, original cash coupon and scarf prize all redeem once through one cashier without crossing activities', async t => {
  let ticket = 325;
  const f = await fixture(t, { randomIndex: () => ticket, randomBps: () => 0 });
  const physical = await f.original.call('draw', {}, VISITOR);
  assert.equal(physical.prize.id, 'cap');
  const scarf = await scarfDraw(f);
  assert.equal(scarf.entry.outcome, 'won');
  assert.equal(scarf.entry.fulfillment, 'cashier');
  assert.notEqual(physical.code, scarf.entry.code);
  await assert.rejects(f.original.call('lookup', { code: scarf.entry.code }, STAFF), e => e.code === 'NOT_FOUND');
  await assert.rejects(f.scarf.call('lookup', { code: physical.code }, STAFF), e => e.code === 'NOT_FOUND');
  await assert.rejects(f.original.call('redeem', { code: physical.code }, STAFF), /收银/);
  await assert.rejects(f.scarf.call('redeem', { code: scarf.entry.code }, STAFF), /收银/);
  assert.equal((await f.original.call('draw', {}, VISITOR)).code, physical.code);
  assert.equal((await scarfDraw(f)).entry.code, scarf.entry.code);
  let ledger = { products: structuredClone(f.products), orders: [] };
  let result = await settle(f, ledger, physical.code); ledger = result.ledger;
  assert.equal(result.line.sku, 'BB250005');
  result = await settle(f, ledger, scarf.entry.code); ledger = result.ledger;
  assert.equal(result.line.sku, 'DEMO-SCARF');
  assert.equal((await f.original.call('state', {}, VISITOR)).entry.status, 'redeemed');
  assert.equal((await f.scarf.call('state', {}, VISITOR)).entry.status, 'redeemed');

  ticket = 0;
  const cashUser = 'oDual_CashVisitor0002';
  const cash = await f.original.call('draw', {}, cashUser);
  assert.equal(cash.prize.id, 'cash50');
  assert.match(cash.code, /^LJC1_[A-F0-9]{32}$/);
  await assert.rejects(f.scarf.call('lookup', { code: cash.code }, STAFF), e => e.code === 'INVALID_CODE');
  const goods = [{ ...ledger.products.find(p => p.sku === 'DEMO-BOTTLE'), qty: 1, discount: 0 }];
  result = await settle(f, ledger, cash.code, goods); ledger = result.ledger;
  assert.equal(result.line.productType, 'coupon');
  assert.equal(result.line.couponAmount, 50);
  assert.equal(result.line.externalCoupon.centerId, f.centerId);
  assert.equal((await f.original.call('state', {}, cashUser)).entry.status, 'redeemed');
  assert.equal(ledger.orders.length, 3);
  for (const sku of ['BB250005', 'DEMO-SCARF', 'DEMO-BOTTLE']) assert.equal(ledger.products.find(p => p.sku === sku).stock, 199);
  const [original, scarfAfter] = await Promise.all([f.payments.dispatch('lottery-snapshot'), f.payments.dispatch('scarf-snapshot')]);
  assert.equal(original.allocated, 2); assert.equal(original.remaining, 498);
  assert.equal(original.center.prizes.cap.redeemed, 1); assert.equal(original.center.prizes.cash50.redeemed, 1);
  assert.equal(scarfAfter.inventory.awarded, 1); assert.equal(scarfAfter.inventory.redeemed, 1); assert.equal(scarfAfter.inventory.remaining, 199);
  assert.equal(f.couponStore.dispatch(f.admin, 'coupons', {}).total, 3);
});

test('a persisted scarf loss does not consume the same participant eligibility or stock in the original activity', async t => {
  const f = await fixture(t, { randomIndex: () => 325, randomBps: () => 9999 });
  const loss = await scarfDraw(f);
  assert.equal(loss.entry.outcome, 'lost'); assert.equal(loss.entry.code, undefined);
  assert.equal((await scarfDraw(f)).entry.outcome, 'lost');
  const original = await f.original.call('draw', {}, VISITOR);
  assert.equal(original.prize.id, 'cap');
  assert.equal((await f.scarf.call('state', {}, VISITOR)).inventory.remaining, 200);
  assert.equal((await f.payments.dispatch('lottery-snapshot')).remaining, 499);
  assert.equal(f.couponStore.dispatch(f.admin, 'coupons', {}).total, 1);
});

test('independent H5 sessions and fresh participant entries keep both gateways isolated', async t => {
  const f = await fixture(t, { randomIndex: () => 325, randomBps: () => 0 });
  const origin = 'http://127.0.0.1:5211', gateways = f.createGateways(origin);
  const event = (kind, endpoint, body, token) => ({ httpMethod: 'POST', path: '/' + kind + '-api/' + endpoint,
    headers: { origin, 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  const enter = async (kind, fresh = false) => {
    const location = await gateways.enter(kind, { fresh });
    const parameters = new URLSearchParams(location.split('?')[1]);
    const response = await gateways[kind](event(kind, 'session', { code: parameters.get('wx_code') }));
    assert.equal(response.statusCode, 200);
    return { token: JSON.parse(response.body).data.token, invitation: parameters.get('inviteCode'), parameters };
  };
  const a = await enter('original'), b = await enter('scarf');
  assert.equal((await gateways.scarf(event('scarf', 'call', { action: 'state', payload: {} }, a.token))).statusCode, 401);
  assert.equal((await gateways.original(event('original', 'call', { action: 'state', payload: {} }, b.token))).statusCode, 401);
  assert.notEqual((await gateways.original(event('original', 'session', { code: a.parameters.get('wx_code') }))).statusCode, 200);
  const originalDraw = await gateways.original(event('original', 'call', { action: 'draw', payload: {} }, a.token));
  assert.equal(originalDraw.statusCode, 200); assert.equal(JSON.parse(originalDraw.body).data.requiresPos, true);
  const scarfWinner = await gateways.scarf(event('scarf', 'call', { action: 'draw', payload: { inviteCode: b.invitation } }, b.token));
  assert.equal(scarfWinner.statusCode, 200); assert.equal(JSON.parse(scarfWinner.body).data.entry.outcome, 'won');
  const fresh = await enter('original', true);
  const newState = await gateways.original(event('original', 'call', { action: 'state', payload: {} }, fresh.token));
  assert.equal(newState.statusCode, 200); assert.equal(JSON.parse(newState.body).data.entry, null);
  assert.throws(() => f.createGateways('https://example.com'), /本机/);
});

test('preview denies real payments, connection imports and every outbound destination outside its in-memory transports', async t => {
  const f = await fixture(t);
  for (const action of ['pay', 'start', 'refund', 'activate', 'config-import', 'coupon-connect', 'lottery-connect', 'scarf-connect', 'coupon-import-connection', 'scarf-export-connection']) assert.equal(isAllowedAction(action), false, action);
  for (const action of ['lottery-snapshot', 'lottery-update', 'scarf-snapshot', 'scarf-update', 'coupon-reserve', 'coupon-zero', 'coupon-zero-ack']) assert.equal(isAllowedAction(action), true, action);
  await assert.rejects(f.mockFetch('https://example.com/'), /阻止外部网络/);
  assert.equal(f.counters.blockedExternalRequests, 1);
});

test('one localhost HTTP server routes both static H5s, authenticated entries and cashier API while blocking real payment', async t => {
  const f = await fixture(t);
  const root = path.join(f.directory, 'http-smoke-dist');
  fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><head><title>Cashier fixture</title></head><body><main>Cashier</main></body></html>');
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const preview = await createPreviewServer({ port, fixture: f, root });
  t.after(() => preview.close());
  await new Promise((resolve, reject) => { preview.server.once('error', reject); preview.server.listen(port, '127.0.0.1', resolve); });
  const origin = preview.origin;
  const request = (route, body) => fetch(origin + route, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const cashier = await fetch(origin + '/');
  assert.equal(cashier.status, 200);
  assert.match(cashier.headers.get('content-security-policy'), /connect-src 'self'/);
  const cashierHtml = await cashier.text();
  assert.match(cashierHtml, /本机隔离演示/); assert.match(cashierHtml, /stall_cashier_ledger_v2/);
  for (const kind of ['original', 'scarf']) {
    const page = await fetch(origin + '/' + kind + '/');
    assert.equal(page.status, 200); assert.match(await page.text(), /本机隔离演示/);
    const runtime = await fetch(origin + '/' + kind + '/runtime-config.js');
    assert.match(await runtime.text(), new RegExp('/' + kind + '-api'));
    assert.equal((await fetch(origin + '/' + kind + '/app.mjs')).status, 200);
    const entry = await fetch(origin + '/' + kind + '-enter?fresh=1', { redirect: 'manual' });
    assert.equal(entry.status, 302);
    const parameters = new URLSearchParams(entry.headers.get('location').split('?')[1]);
    const session = await request('/' + kind + '-api/session', { code: parameters.get('wx_code') });
    assert.equal(session.status, 200); assert.equal((await session.json()).ok, true);
  }
  for (const kind of ['lottery', 'scarf']) {
    const snapshot = await request('/api/sqb/' + kind + '-snapshot', {});
    assert.equal(snapshot.status, 200);
    assert.equal((await snapshot.json()).data.fulfillment.centerId, f.centerId);
  }
  const denied = await request('/api/sqb/pay', {});
  assert.equal(denied.status, 403); assert.match((await denied.json()).error, /不连接真实收款/);
  assert.equal((await fetch(origin + '/original/%2e%2e%2f%2e%2e%2fserver/package.json')).status, 404);
  assert.equal(f.counters.blockedExternalRequests, 0);
});
