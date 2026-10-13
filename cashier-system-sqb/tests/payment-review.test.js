import test from 'node:test';
import assert from 'node:assert/strict';
import { completeBrowserPayment, retainPaymentReview, paymentReviewMessage, shouldOpenPayment } from '../src/paymentReview.js';

function fixture({ acknowledged = false, stock = 10, missing = false } = {}) {
  const product = { id: 'old-product', name: '旧订单商品', barcode: 'OLD-ITEM', productType: 'sale', price: 10, stock };
  const draft = { id: 'old-payment', orderNo: 'POS-OLD', method: '收钱吧', items: [{ ...product, qty: 1, discount: 0 }], total: 10 };
  const record = { id: draft.id, draft, state: 'paid', acknowledged, amount: 1000, orderSn: 'SQB-OLD',
    identity: { check_sn: draft.orderNo }, updatedAt: '2026-09-18T12:00:00+08:00', tenders: [] };
  const ledger = { products: missing ? [] : [product], orders: [], pendingPayment: { draft, started: true, record } };
  return { ledger, record };
}

test('acknowledged receipt with no local order never repeats inventory deduction even if catalog matches', () => {
  const { ledger, record } = fixture({ acknowledged: true });
  const before = JSON.stringify(ledger);
  assert.throws(() => completeBrowserPayment(ledger, record), /不能在这里重复入账/);
  assert.equal(JSON.stringify(ledger), before);
});

test('missing and insufficient inventory give contextual paid-order errors without creating products', () => {
  for (const options of [{ missing: true }, { stock: 0 }]) {
    const { ledger, record } = fixture(options);
    const before = JSON.stringify(ledger);
    assert.throws(() => completeBrowserPayment(ledger, record), error => {
      assert.match(error.message, /收款已确认.*当前浏览器.*重复收款/);
      if (options.missing) {
        assert.match(error.message, /缺少原订单商品「旧订单商品」/);
        assert.doesNotMatch(error.message, /已删除/);
      }
      return true;
    });
    assert.equal(JSON.stringify(ledger), before);
  }
});

test('dismissal retains the receipt and original pending draft without changing inventory, orders or acknowledgement', () => {
  const { ledger, record } = fixture({ acknowledged: true, missing: true });
  const before = JSON.stringify(ledger);
  const next = retainPaymentReview(ledger, record, paymentReviewMessage(ledger, record), true);
  assert.equal(next.products, ledger.products); assert.equal(next.orders, ledger.orders);
  assert.equal(next.pendingPayment.draft, ledger.pendingPayment.draft);
  assert.equal(next.pendingPayment.record, record);
  assert.equal(next.pendingPayment.record.acknowledged, true);
  assert.equal(next.pendingPayment.review.dismissed, true);
  assert.equal(shouldOpenPayment(next.pendingPayment), false);
  assert.equal(shouldOpenPayment(JSON.parse(JSON.stringify(next)).pendingPayment), false);
  assert.equal(JSON.stringify(ledger), before);
});

test('dismissal is never offered as a way to resolve unconfirmed or mismatched payments', () => {
  const { ledger, record } = fixture();
  for (const patch of [{ state: 'pending' }, { state: 'failed' }, { id: 'other' }, { orderSn: '' }, { amount: 1 }, { identity: { check_sn: 'OTHER' } }]) {
    assert.throws(() => retainPaymentReview(ledger, { ...record, ...patch }, 'test', true), /不一致/);
  }
  assert.throws(() => retainPaymentReview({ ...ledger, pendingPayment: null }, record, 'test'), /不一致/);
});

test('normal new payment still saves once and matching recorded order may finish idempotently', () => {
  const { ledger, record } = fixture();
  const completed = completeBrowserPayment(ledger, record);
  assert.equal(completed.products[0].stock, 9);
  assert.equal(completed.orders.length, 1);
  assert.equal(completed.pendingPayment, null);
  const reconciled = completeBrowserPayment({ ...completed, pendingPayment: ledger.pendingPayment }, { ...record, acknowledged: true });
  assert.equal(reconciled.products, completed.products);
  assert.equal(reconciled.orders, completed.orders);
  assert.equal(reconciled.pendingPayment, null);
  assert.throws(() => completeBrowserPayment(completed, { ...record, orderSn: 'WRONG' }), /支付结果与已存订单不一致/);
});

test('new pending payments still open while retained reviews stay hidden', () => {
  const { ledger, record } = fixture();
  assert.equal(shouldOpenPayment(ledger.pendingPayment), true);
  assert.equal(shouldOpenPayment(null), false);
  assert.equal(shouldOpenPayment(retainPaymentReview(ledger, record, 'save failed').pendingPayment), true);
});
