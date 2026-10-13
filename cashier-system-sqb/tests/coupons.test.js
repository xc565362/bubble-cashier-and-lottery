import test from 'node:test';
import assert from 'node:assert/strict';
import { priceOrder, completeOrder, reviseOrder, orderExportRows, orderSerial, suspendBasket, retrieveBasket } from '../src/orderLogic.js';

const product = { id: 'goods', barcode: 'ABC-001/Blue', name: 'Goods', productType: 'sale', price: 20, stock: 4 };
const coupon = { id: 'coupon', barcode: '6900000000002', name: '5 off', productType: 'coupon', price: 0, couponAmount: 5, stock: 0 };
const items = () => [{ ...product, qty: 2, discount: 3 }, { ...coupon, qty: 1 }];
const ledger = () => ({ products: [product, coupon], orders: [], heldCarts: [] });
const draft = () => ({ id: 'order', orderNo: 'LOCAL1', items: items(), method: '扫码收款' });

test('coupon is a separate negative line after item discounts, in exact cents', () => {
  const result = priceOrder(items());
  assert.equal(result.total, 32);
  assert.equal(result.subtotal, 40);
  assert.equal(result.discount, 8);
  assert.equal(result.couponDiscount, 5);
  assert.equal(result.items[1].lineTotal, -5);
  assert.equal(priceOrder([{ ...product, qty: 3, price: 0.1 }, { ...coupon, qty: 1, couponAmount: 0.1 }]).total, 0.2);
});

test('coupon never overdraws the payable amount or produces a negative order', () => {
  const result = priceOrder([{ ...product, qty: 1, price: 2, discount: 1 }, { ...coupon, qty: 1 }]);
  assert.equal(result.total, 0);
  assert.equal(result.items[1].couponAmount, 5);
  assert.equal(result.items[1].couponDeduction, 1);
  assert.equal(result.discount, 2);
});

test('one coupon per order is enforced for duplicate and different barcodes and quantity', () => {
  assert.throws(() => priceOrder([...items(), { ...coupon, qty: 1, id: 'other', barcode: 'COUPON-other' }]), /一张/);
  assert.throws(() => priceOrder([...items(), { ...coupon, qty: 1 }]), /一张/);
  assert.throws(() => priceOrder([{ ...coupon, qty: 2 }]), /一张/);
  for (const couponAmount of [0, -1, 'NaN', Infinity]) assert.throws(() => priceOrder([{ ...coupon, qty: 1, couponAmount }]));
});

test('coupon-only checkout is blocked, coupon stock is unchanged on payment or cancellation', () => {
  assert.throws(() => completeOrder(ledger(), { ...draft(), items: [{ ...coupon, qty: 1 }] }), /不能单独/);
  const paid = completeOrder(ledger(), draft());
  assert.equal(paid.products[0].stock, 2);
  assert.equal(paid.products[1].stock, 0);
  const cancelled = reviseOrder(paid, 'order', [], true);
  assert.equal(cancelled.products[0].stock, 4);
  assert.equal(cancelled.products[1].stock, 0);
  assert.equal(cancelled.orders[0].total, 0);
});

test('exchange recomputes coupon cap and removal restores payable; zero dispatch does not redeem it', () => {
  const paid = completeOrder(ledger(), draft());
  const changed = reviseOrder(paid, 'order', [{ ...product, qty: 1, price: 2 }, { ...coupon, qty: 1 }]);
  assert.equal(changed.orders[0].total, 0);
  assert.equal(changed.orders[0].items[1].couponDeduction, 2);
  assert.equal(reviseOrder(changed, 'order', [{ ...product, qty: 1, price: 2 }]).orders[0].total, 2);
  const zero = completeOrder(ledger(), { ...draft(), method: '0元出库' });
  assert.equal(zero.orders[0].total, 0);
  assert.equal(zero.orders[0].couponDiscount, 0);
});

test('held cart and JSON backup retain coupon configuration and reprice on retrieval', () => {
  const held = suspendBasket(ledger(), { id: 'held', items: items() });
  const restored = JSON.parse(JSON.stringify(held));
  assert.equal(priceOrder(retrieveBasket(restored, 'held').basket.items).total, 32);
});

test('CSV coupon deduction reconciles exactly with revenue without counting coupon as goods sold', () => {
  const order = completeOrder(ledger(), draft()).orders[0];
  const rows = orderExportRows([order]);
  assert.equal(rows[2][10], '优惠券');
  assert.equal(rows[2][15], -5);
  assert.equal(rows[2][16], 0);
  assert.equal(rows.slice(1).reduce((sum, row) => sum + row[15], 0), order.total);
  assert.equal(rows.slice(1).reduce((sum, row) => sum + row[14], 0), order.discount);
});

test('SQB internal transaction numbers are primary in UI and CSV; local and light POS IDs remain separate', () => {
  const order = completeOrder(ledger(), draft()).orders[0];
  order.payment = { provider: 'sqb', orderSn: 'LIGHTPOS', tenders: [
    { internalTransactionSn: '100000000000000001', payStatus: 3, channel: '微信', channelSn: 'WX1' },
    { internalTransactionSn: 'FAILED', payStatus: 7 },
  ] };
  assert.equal(orderSerial(order), '100000000000000001');
  const row = orderExportRows([order])[1];
  assert.equal(row[0], '100000000000000001');
  assert.equal(row[17], 'LOCAL1');
  assert.equal(row[18], 'LIGHTPOS');
  assert.equal(row[19], '100000000000000001');
  assert.equal(row[20], '微信');
  order.payment.tenders = [];
  assert.equal(orderSerial(order), '');
});
