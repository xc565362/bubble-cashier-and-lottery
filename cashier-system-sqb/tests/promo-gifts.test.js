import test from 'node:test';
import assert from 'node:assert/strict';
import { addLineToCart, canBePromoGift, giftEligibility, promoGiftLine } from '../src/cartLogic.js';
import { basketLineKey, priceOrder, reconcileStock, completeOrder, completeSqbOrder, reviseOrder, suspendBasket, retrieveBasket, orderExportRows } from '../src/orderLogic.js';
import { remainingLines, adjustmentPlan, applyAdjustment, financialExportRows } from '../src/afterSales.js';

const product = (stock = 5) => ({ id: 'same', name: 'Dual product', barcode: 'BB001', sku: 'BB001', productType: 'sale', price: 20, stock, giftEligible: true });
const gift = (rule = 'rule') => promoGiftLine(product(), rule);
const lines = () => [{ ...product(), qty: 1, discount: 2 }, { ...gift(), qty: 2 }];
const ledger = () => ({ products: [product()], orders: [], heldCarts: [] });
const draft = () => ({ id: 'order', orderNo: 'POS1', method: '扫码收款', items: lines() });

test('gift eligibility is explicit on sale products and compatible with old pure gifts', () => {
  assert.equal(canBePromoGift(product()), true);
  assert.equal(canBePromoGift({ ...product(), giftEligible: false }), false);
  assert.equal(canBePromoGift({ productType: 'gift' }), true);
  assert.equal(canBePromoGift({ productType: 'coupon', giftEligible: true }), false);
  for (const value of ['false', '否', '0', undefined, false]) assert.equal(giftEligibility(value), false);
  for (const value of ['true', '是', '1', true, '可参与买赠']) assert.equal(giftEligibility(value), true);
  assert.throws(() => promoGiftLine({ ...product(), giftEligible: false }, 'rule'), /可参与买赠/);
});

test('creating a free line never mutates its paid catalog product', () => {
  const original = product();
  const free = promoGiftLine(original, 'rule');
  assert.equal(original.price, 20);
  assert.equal(original.productType, 'sale');
  assert.equal(free.price, 0);
  assert.equal(free.discount, 0);
  assert.equal(free.productType, 'gift');
  assert.equal(free.id, original.id);
  assert.equal(free.barcode, original.barcode);
  assert.equal(free.sku, original.sku);
  assert.notEqual(basketLineKey(free), basketLineKey(original));
});

test('paid then free and free then paid keep independent price and quantity', () => {
  for (const sequence of [[product(), gift()], [gift(), product()]]) {
    let cart = [];
    for (const line of sequence) cart = addLineToCart(cart, line).next;
    cart = addLineToCart(cart, product()).next;
    cart = addLineToCart(cart, gift()).next;
    assert.equal(cart.length, 2);
    assert.equal(cart.find(item => item.productType === 'sale').qty, 2);
    assert.equal(cart.find(item => item.productType === 'gift').qty, 2);
    assert.equal(priceOrder(cart).total, 40);
  }
});

test('all paid and free lines compete for one stock pool in either direction', () => {
  for (const firstFree of [true, false]) {
    const first = firstFree ? gift() : product();
    const second = firstFree ? product() : gift();
    const cart = addLineToCart([], first, 4).next;
    const added = addLineToCart(cart, second, 2);
    assert.equal(added.addedQty, 1);
    assert.equal(added.next.reduce((sum, item) => sum + item.qty, 0), 5);
    assert.equal(addLineToCart(added.next, second).added, false);
    assert.equal(addLineToCart(added.next, first).added, false);
  }
});

test('separate promotion rules retain separate lines while sharing stock', () => {
  let cart = addLineToCart([], product(), 2).next;
  cart = addLineToCart(cart, gift('rule-one')).next;
  cart = addLineToCart(cart, gift('rule-two')).next;
  assert.equal(cart.length, 3);
  assert.equal(new Set(cart.map(basketLineKey)).size, 3);
  assert.equal(addLineToCart(cart, gift('rule-two'), 5).addedQty, 1);
});

test('legacy promotional and manual gift lines cannot merge into paid lines', () => {
  const legacy = { ...product(), productType: 'gift', price: 0, qty: 1, source: 'promo', promoRuleId: 'rule' };
  assert.equal(basketLineKey(legacy), basketLineKey(gift()));
  const merged = addLineToCart([legacy], gift()).next;
  assert.equal(merged.length, 1);
  assert.equal(merged[0].qty, 2);
  const manual = { ...legacy, source: 'gift', promoRuleId: '' };
  const paid = addLineToCart([manual], product()).next;
  assert.equal(paid.length, 2);
  assert.equal(priceOrder(paid).total, 20);
});

test('discount remains only on paid line and incoming quantity must be integral', () => {
  let cart = [{ ...product(), qty: 1, discount: 3 }];
  cart = addLineToCart(cart, gift()).next;
  cart = addLineToCart(cart, product()).next;
  assert.equal(cart[0].discount, 3);
  assert.equal(cart[1].discount, 0);
  assert.equal(priceOrder(cart).total, 37);
  for (const qty of [0, -1, 0.5, NaN]) assert.equal(addLineToCart([], product(), qty).added, false);
});

test('checkout decrements combined quantities once without overwriting catalog pricing', () => {
  const paid = completeOrder(ledger(), draft());
  assert.equal(paid.products[0].stock, 2);
  assert.equal(paid.products[0].price, 20);
  assert.equal(paid.products[0].productType, 'sale');
  assert.equal(paid.products[0].giftEligible, true);
  assert.equal(paid.orders[0].total, 18);
  assert.throws(() => completeOrder(paid, draft()), /重复/);
  assert.throws(() => reconcileStock([product(2)], [], lines()), /库存不足/);
});

test('payment success duplicates do not deduct shared stock twice', () => {
  const pending = { ...ledger(), pendingPayment: { draft: draft() } };
  const record = { id: 'order', state: 'paid', orderSn: 'remote1', identity: { check_sn: 'POS1' }, amount: 1800, updatedAt: '2026-09-26T00:00:00Z', tenders: [] };
  const paid = completeSqbOrder(pending, record);
  const repeated = completeSqbOrder(paid, record);
  assert.equal(repeated.products[0].stock, 2);
  assert.equal(repeated.orders.length, 1);
  assert.equal(repeated.orders[0].total, 18);
});

test('held baskets preserve free lines and recheck current shared stock', () => {
  const held = suspendBasket(ledger(), { id: 'held', items: lines(), giftChoiceQueue: [] });
  const restored = JSON.parse(JSON.stringify(held));
  restored.products[0].stock = 2;
  const { basket } = retrieveBasket(restored, 'held');
  assert.equal(basket.items[1].price, 0);
  assert.equal(basketLineKey(basket.items[1]), basketLineKey(gift()));
  assert.equal(restored.products[0].giftEligible, true);
  assert.throws(() => completeOrder(restored, { ...draft(), items: basket.items }), /库存不足/);
});

test('cancellation returns shared stock and a deleted gift snapshot restores the sale product', () => {
  const paid = completeOrder(ledger(), draft());
  const cancelled = reviseOrder(paid, 'order', [], true);
  assert.equal(cancelled.products[0].stock, 5);
  const restored = reconcileStock([], [{ ...gift(), qty: 1 }]);
  assert.equal(restored[0].stock, 1);
  assert.equal(restored[0].price, 20);
  assert.equal(restored[0].productType, 'sale');
  assert.equal(restored[0].giftEligible, true);
  assert.equal(restored[0].lineKey, undefined);
});

test('returns distinguish paid and gift units and only restock actual returns', () => {
  const paid = completeOrder(ledger(), draft());
  const available = remainingLines(paid.orders[0]);
  assert.notEqual(available[0].lineId, available[1].lineId);
  assert.deepEqual(available.map(item => item.remainingCents), [1800, 0]);
  const plan = adjustmentPlan(paid.orders[0], { id: 'refund1', type: 'return', returns: [
    { lineId: available[0].lineId, qty: 1, restockQty: 1 },
    { lineId: available[1].lineId, qty: 2, restockQty: 1 }
  ] });
  assert.equal(plan.refundCents, 1800);
  const record = { id: 'refund1', parentId: 'order', kind: 'refund', state: 'refunded', plan, tenders: [], completedAt: '2026-09-26T01:00:00Z' };
  const returned = applyAdjustment(paid, record);
  assert.equal(returned.products[0].stock, 4);
  assert.equal(applyAdjustment(returned, record).products[0].stock, 4);
  const rows = financialExportRows(returned.orders).slice(1);
  assert.equal(rows.reduce((sum, row) => sum + row[16], 0), 0);
  assert.equal(rows.reduce((sum, row) => sum + row[15], 0), 0);
});

test('gift-only return does not refund the same SKU retail price', () => {
  const paid = completeOrder(ledger(), draft());
  const free = remainingLines(paid.orders[0]).find(item => item.productType === 'gift');
  const plan = adjustmentPlan(paid.orders[0], { id: 'returngift', type: 'return', returns: [{ lineId: free.lineId, qty: 1, restockQty: 1 }] });
  assert.equal(plan.refundCents, 0);
});

test('coupon discounts are calculated from paid items only and one-coupon limit stays enforced', () => {
  const coupon = { id: 'coupon', name: 'Coupon', productType: 'coupon', couponAmount: 5, price: 0 };
  const cart = addLineToCart(lines(), coupon).next;
  assert.equal(priceOrder(cart).total, 13);
  assert.equal(addLineToCart(cart, { ...coupon, id: 'other' }).reason, 'coupon-limit');
  const order = { ...draft(), items: cart };
  assert.deepEqual(remainingLines(order).map(item => item.remainingCents), [1300, 0]);
});

test('physical lottery redemption keeps its own identity and stock with sale and promotion', () => {
  const physical = { ...product(), productType: 'gift', price: 0, discount: 0, qty: 1, lineKey: 'lottery-gift:award', externalCoupon: { kind: 'physical', couponId: 'award', reservationId: 'r' } };
  const cart = [...lines(), physical];
  assert.equal(new Set(cart.map(basketLineKey)).size, 3);
  assert.equal(priceOrder(cart).total, 18);
  assert.equal(reconcileStock([product()], [], cart)[0].stock, 1);
  assert.equal(addLineToCart(cart, { productType: 'coupon', couponAmount: 5 }).reason, 'coupon-limit');
});

test('CSV distinguishes paid and free lines without inflating sales quantity', () => {
  const rows = orderExportRows(completeOrder(ledger(), draft()).orders).slice(1);
  assert.deepEqual(rows.map(row => row[8]), ['BB001', 'BB001']);
  assert.deepEqual(rows.map(row => row[10]), ['售卖品', '赠品']);
  assert.deepEqual(rows.map(row => row[12]), [1, 2]);
  assert.deepEqual(rows.map(row => row[16]), [1, 0]);
  assert.deepEqual(rows.map(row => row[15]), [18, 0]);
});
