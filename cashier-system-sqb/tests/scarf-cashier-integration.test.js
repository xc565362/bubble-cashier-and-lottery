import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { priceOrder, completeOrder } from '../src/orderLogic.js';
const require = createRequire(import.meta.url);
const { createFixture } = require('../scripts/scarf-cashier-fixture.cjs');
const STAFF = 'oScarf_PreviewStaff0001', USER = 'oScarf_TestVisitor0001';
async function fixture(t, options) { const f = await createFixture(options); t.after(() => f.close()); return f; }
async function draw(f, who = USER) { const invite = await f.call('grant', {}, STAFF); return f.call('draw', { inviteCode: invite.inviteCode }, who); }
async function update(f, operation, fields = {}) {
  const snapshot = await f.payments.dispatch('scarf-snapshot');
  return f.payments.dispatch('scarf-update', { revision: snapshot.revision, requestId: crypto.randomUUID(), operation, reason: '隔离集成测试', ...fields });
}
async function reserve(f, code, products = f.products) {
  return f.payments.dispatch('coupon-reserve', { code, products, checkoutId: crypto.randomUUID(), eligibleCents: 0, requestId: crypto.randomUUID() });
}

test('scarf H5 winner enters the real cashier zero-order flow, deducts stock once and syncs redemption', async t => {
  const f = await fixture(t, { randomBps: () => 0 });
  const state = await draw(f), code = state.entry.code;
  assert.equal(state.entry.fulfillment, 'cashier');
  assert.equal(state.entry.status, 'pending');
  assert.match(code, /^[A-F0-9]{16}$/);
  await assert.rejects(f.call('redeem', { code }, STAFF), /收银/);
  const line = await reserve(f, code);
  assert.equal(line.externalCoupon.kind, 'physical');
  assert.equal(line.sku, 'DEMO-SCARF');
  const draft = { id: crypto.randomUUID(), orderNo: 'SCARF' + Date.now(), method: '零元结算', ...priceOrder([line]) };
  assert.equal(draft.total, 0);
  const settled = await f.payments.dispatch('coupon-zero', { draft });
  const ledger = completeOrder({ products: f.products, orders: [] }, settled.draft);
  assert.equal(ledger.products.find(p => p.sku === 'DEMO-SCARF').stock, 199);
  assert.equal(ledger.orders.length, 1);
  await f.payments.dispatch('coupon-zero-ack', { id: draft.id });
  const after = await f.call('state', {}, USER);
  assert.equal(after.entry.status, 'redeemed');
  assert.equal(after.entry.code, undefined);
  await assert.rejects(reserve(f, code), /核销|领取|使用/);
  assert.throws(() => completeOrder(ledger, settled.draft));
  assert.equal((await f.call('state', {}, USER)).inventory.remaining, 199);
});

test('cashier changes probability and merchandise; H5 updates while old prizes remain redeemable', async t => {
  const f = await fixture(t, { randomBps: () => 0 });
  const original = await draw(f);
  const before = await f.payments.dispatch('scarf-snapshot');
  await update(f, 'pause');
  await update(f, 'configure', { total: 220,
    campaign: { title: before.campaign.title, venue: before.campaign.venue, startsAt: before.campaign.startsAt, endsAt: before.campaign.endsAt, redeemEndsAt: before.campaign.redeemEndsAt, winProbabilityBps: 2500 },
    prize: { id: 'scarf-bottle-test', name: '赛事运动水壶', imageUrl: 'https://assets.example.com/bottle.png', product: { id: f.products[1].id, name: f.products[1].name, sku: f.products[1].sku, barcode: f.products[1].barcode } },
  });
  const changed = await f.call('state', {}, 'oScarf_NewVisitor0002');
  assert.equal(changed.campaign.winProbabilityBps, 2500);
  assert.equal(changed.prize.name, '赛事运动水壶');
  assert.equal(changed.inventory.total, 220);
  assert.equal(changed.availability.canDraw, false);
  assert.equal((await f.call('state', {}, USER)).entry.prize.name, original.entry.prize.name);
  await update(f, 'resume');
  const newWinner = await draw(f, 'oScarf_NewVisitor0002');
  assert.equal(newWinner.entry.prize.name, '赛事运动水壶');
  const oldLine = await reserve(f, original.entry.code);
  assert.equal(oldLine.sku, 'DEMO-SCARF');
  await f.payments.dispatch('coupon-release', { id: oldLine.externalCoupon.reservationId });
  const newLine = await reserve(f, newWinner.entry.code);
  assert.equal(newLine.sku, 'DEMO-BOTTLE');
  await f.payments.dispatch('coupon-release', { id: newLine.externalCoupon.reservationId });
});

test('losing participation stays used and cannot mint a redeemable coupon on retry', async t => {
  const f = await fixture(t, { randomBps: () => 9999 });
  const loss = await draw(f);
  assert.equal(loss.entry.outcome, 'lost');
  assert.equal(loss.entry.code, undefined);
  const invite = await f.call('grant', {}, STAFF);
  const again = await f.call('draw', { inviteCode: invite.inviteCode }, USER);
  assert.equal(again.entry.outcome, 'lost');
  assert.equal(again.inventory.remaining, 200);
  assert.equal(f.couponStore.dispatch(f.admin, 'coupons', {}).total, 0);
});

test('a second computer matches scarf by SKU and rejects duplicates or exhausted local stock', async t => {
  const f = await fixture(t, { randomBps: () => 0 });
  const winner = await draw(f);
  const duplicate = [...f.products, { ...f.products[0], id: 'duplicate-local-id' }];
  await assert.rejects(reserve(f, winner.entry.code, duplicate), /重复|多个|唯一/);
  const empty = f.products.map(p => ({ ...p, stock: 0 }));
  await assert.rejects(reserve(f, winner.entry.code, empty), /库存/);
  const otherMachine = f.products.map(p => ({ ...p, id: 'other-' + p.id }));
  const line = await reserve(f, winner.entry.code, otherMachine);
  assert.equal(line.id, 'other-demo-scarf');
  assert.equal(line.qty, 1);
  await f.payments.dispatch('coupon-release', { id: line.externalCoupon.reservationId });
});
