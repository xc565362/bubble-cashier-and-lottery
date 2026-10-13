import test from 'node:test';
import assert from 'node:assert/strict';
import { completeOrder, reviseOrder, reconcileStock, priceOrder, isCompleted, orderExportRows, suspendBasket, retrieveBasket } from '../src/orderLogic.js';

const products = () => [
  { id: 'a', name: 'Sale A', barcode: '001', sku: 'A', price: 10, stock: 5, productType: 'sale' },
  { id: 'b', name: 'Sale B', barcode: '002', sku: 'B', price: 15, stock: 3, productType: 'sale' },
  { id: 'g', name: 'Gift', barcode: '003', price: 0, stock: 8, productType: 'gift' },
];
const ledger = () => ({ products: products(), orders: [], heldCarts: [] });
const draft = (items = [{ ...products()[0], qty: 2, discount: 1 }], method = '扫码收款') => ({ id: 'order-1', orderNo: 'POS1', method, items });

test('preparing and discarding payment does not allocate stock or create an order', () => {
  const initial = ledger();
  const snapshot = structuredClone(initial);
  const pending = priceOrder(draft().items);
  reconcileStock(initial.products, [], pending.items);
  assert.deepEqual(initial, snapshot);
  assert.equal(initial.orders.length, 0);
});

test('confirmation records payment and decrements stock exactly once', () => {
  const initial = ledger();
  const paid = completeOrder(initial, draft(), '2026-09-08T08:00:00Z');
  assert.equal(paid.orders[0].total, 19);
  assert.equal(paid.orders[0].status, '已收款');
  assert.equal(paid.products[0].stock, 3);
  assert.equal(initial.products[0].stock, 5);
  assert.throws(() => completeOrder(paid, draft()), /重复/);
});

test('confirmation validates fresh stock without partial changes', () => {
  const initial = ledger();
  initial.products[0].stock = 0;
  const snapshot = structuredClone(initial);
  assert.throws(() => completeOrder(initial, draft()), /库存不足/);
  assert.deepEqual(initial, snapshot);
});

test('confirmation rejects deleted products and aggregate over-allocation', () => {
  const initial = ledger();
  assert.throws(() => completeOrder(initial, draft([{ id: 'deleted', name: 'Deleted', qty: 1, price: 1 }])), /已删除/);
  const line = { ...products()[0], qty: 3 };
  assert.throws(() => completeOrder(initial, draft([line, line])), /库存不足/);
});

test('zero-value dispatch zeroes every line but decrements normal stock', () => {
  const initial = ledger();
  const paid = completeOrder(initial, draft([{ ...products()[0], qty: 2, discount: 1 }, { ...products()[1], qty: 1 }], '0元出库'));
  assert.equal(paid.orders[0].total, 0);
  assert.ok(paid.orders[0].items.every((line) => line.price === 0 && line.discount === 0 && line.lineTotal === 0));
  assert.equal(paid.products[0].stock, 3);
  assert.equal(paid.products[1].stock, 2);
  assert.equal(paid.products[0].price, 10);
});

test('gift lines remain free and decimal totals are calculated in cents', () => {
  const priced = priceOrder([{ id: 'x', qty: 3, price: 0.1 }, { id: 'g', productType: 'gift', qty: 1, price: 99 }]);
  assert.equal(priced.total, 0.3);
  assert.equal(priced.items[1].price, 0);
  assert.throws(() => priceOrder([{ qty: 0.5, price: 10 }]), /正整数/);
  assert.throws(() => priceOrder([{ qty: 1, price: 'invalid' }]), /金额/);
});

test('exchange returns old items and deducts new items, updating the same order', () => {
  const paid = completeOrder(ledger(), draft());
  const changed = reviseOrder(paid, 'order-1', [{ ...products()[1], qty: 2, discount: 2 }]);
  assert.equal(changed.products[0].stock, 5);
  assert.equal(changed.products[1].stock, 1);
  assert.equal(changed.orders.length, 1);
  assert.equal(changed.orders[0].total, 28);
  assert.equal(changed.orders[0].createdAt, paid.orders[0].createdAt);
  assert.equal(changed.orders[0].revisions[0].previous.total, 19);
});

test('same-product exchange can reuse the original allocation at zero remaining stock', () => {
  const paid = completeOrder(ledger(), draft([{ ...products()[0], qty: 5 }]));
  const changed = reviseOrder(paid, 'order-1', [{ ...products()[0], qty: 4, discount: 3 }]);
  assert.equal(changed.products[0].stock, 1);
  assert.equal(changed.orders[0].total, 37);
});

test('failed exchanges leave orders and inventory unchanged', () => {
  const paid = completeOrder(ledger(), draft());
  const snapshot = structuredClone(paid);
  assert.throws(() => reviseOrder(paid, 'order-1', [{ ...products()[1], qty: 4 }]), /库存不足/);
  assert.throws(() => reviseOrder(paid, 'order-1', []), /至少/);
  assert.deepEqual(paid, snapshot);
});

test('cancellation after multiple exchanges restores only the final allocation', () => {
  let current = completeOrder(ledger(), draft());
  current = reviseOrder(current, 'order-1', [{ ...products()[1], qty: 2 }]);
  current = reviseOrder(current, 'order-1', [{ ...products()[0], qty: 1 }, { ...products()[2], qty: 2 }]);
  current = reviseOrder(current, 'order-1', [], true);
  assert.deepEqual(current.products.map((item) => item.stock), [5, 3, 8]);
  assert.equal(current.orders[0].total, 0);
  assert.equal(current.orders[0].status, '已取消');
  assert.equal(current.orders[0].revisions.length, 3);
  assert.equal(isCompleted(current.orders[0]), false);
  assert.throws(() => reviseOrder(current, 'order-1', [], true), /已取消/);
});

test('cancellation restores a deleted product from its order snapshot', () => {
  const paid = completeOrder(ledger(), draft());
  paid.products = paid.products.filter((item) => item.id !== 'a');
  const cancelled = reviseOrder(paid, 'order-1', [], true);
  assert.equal(cancelled.products.find((item) => item.id === 'a').stock, 2);
});

test('legacy pending orders are excluded from revenue and can return reserved stock', () => {
  const legacy = completeOrder(ledger(), draft());
  legacy.orders[0].status = '待收款';
  assert.equal(isCompleted(legacy.orders[0]), false);
  const cancelled = reviseOrder(legacy, 'order-1', [], true);
  assert.equal(cancelled.products[0].stock, 5);
});

test('CSV rows are child lines whose revenue sums to the revised parent', () => {
  let paid = completeOrder(ledger(), draft());
  paid = reviseOrder(paid, 'order-1', [{ ...products()[0], qty: 2, discount: 3 }, { ...products()[1], qty: 1 }]);
  const rows = orderExportRows(paid.orders);
  assert.equal(rows.length, 3);
  assert.equal(rows[1][1], 'POS1-001');
  assert.equal(rows[2][1], 'POS1-002');
  assert.equal(rows[1][7], '001');
  assert.equal(rows.slice(1).reduce((sum, row) => sum + row[15], 0), paid.orders[0].total);
  assert.equal(rows.slice(1).reduce((sum, row) => sum + row[16], 0), 3);
  const cancelled = orderExportRows(reviseOrder(paid, 'order-1', [], true).orders);
  assert.ok(cancelled.slice(1).every((row) => row[15] === 0 && row[16] === 0));
});

test('suspending persists discounts and gift choices without changing inventory', () => {
  const initial = ledger();
  const basket = { id: 'held-1', items: draft().items, giftChoiceQueue: [{ id: 'choice', gifts: [{ productId: 'g', qty: 1 }] }] };
  const held = suspendBasket(initial, basket);
  const restored = JSON.parse(JSON.stringify(held));
  assert.deepEqual(restored.products, initial.products);
  assert.equal(restored.orders.length, 0);
  assert.deepEqual(restored.heldCarts[0], basket);
});

test('retrieving swaps the active basket and uses current stock', () => {
  const first = { id: 'held-1', items: draft().items, giftChoiceQueue: [{ id: 'choice' }] };
  const second = { id: 'held-2', items: [{ ...products()[1], qty: 1 }], giftChoiceQueue: [] };
  const held = suspendBasket(ledger(), first);
  held.products[0].stock = 0;
  const result = retrieveBasket(held, first.id, second);
  assert.equal(result.ledger.heldCarts.length, 1);
  assert.equal(result.ledger.heldCarts[0].id, second.id);
  assert.equal(result.basket.items[0].stock, 0);
  assert.deepEqual(result.basket.giftChoiceQueue, first.giftChoiceQueue);
  assert.throws(() => completeOrder(result.ledger, draft(result.basket.items)), /库存不足/);
  assert.throws(() => retrieveBasket(result.ledger, first.id), /不存在/);
});
