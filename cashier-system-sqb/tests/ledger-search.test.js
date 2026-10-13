import test from 'node:test';
import assert from 'node:assert/strict';
import { financialExportRows, adjustmentPlan } from '../src/afterSales.js';
import { createLedgerSearchIndex, queryLedger, LEDGER_SEARCH_FIELDS, LEDGER_EXPORT_HEADER, ledgerDateKey } from '../src/ledgerSearch.js';
import { searchOrders } from './fixtures/ledger-search.js';

process.env.TZ = 'Asia/Shanghai';
const orders = searchOrders();
const index = createLedgerSearchIndex(orders);
const search = (field, keyword, date = '') => queryLedger(index, { field, keyword, date });

test('every exported ledger field is selectable and searches its own column', () => {
  assert.equal(new Set(LEDGER_SEARCH_FIELDS.map(field => field.id)).size, LEDGER_SEARCH_FIELDS.length);
  for (const [column, label] of LEDGER_EXPORT_HEADER.entries()) {
    assert.ok(LEDGER_SEARCH_FIELDS.some(field => field.id === label && field.column === column), label);
    const entry = index.find(entry => entry.rows.some(row => row[column] != null && row[column] !== ''));
    assert.ok(entry, `${label} has fixture coverage`);
    const row = entry.rows.find(row => row[column] != null && row[column] !== '');
    assert.ok(search(label, String(row[column])).orders.includes(entry.order), label);
  }
});

test('query requires a field and text matching is case insensitive with trimmed whitespace', () => {
  assert.equal(search('', 'BB250005').orders.length, 0);
  assert.equal(search('unknown', 'BB250005').orders.length, 0);
  assert.equal(search('', '   ').orders.length, 4);
  assert.deepEqual(search('条码', '  001aBc-011  ').orders.map(order => order.id), ['search-other']);
  assert.equal(search('产品名称', 'bb240011').orders.length, 0);
  assert.equal(search('产品名称', '腰包').orders.length, 1);
  assert.equal(search('货品编码', 'BB240011').orders.length, 1);
  assert.equal(search('条码', '<script>').orders.length, 0);
});

test('money and quantities match exactly, including formatted values, zero and negative refunds', () => {
  assert.equal(search('单价', '20').orders.length, 0);
  assert.equal(search('单价', '￥120.00元').orders[0].id, 'search-other');
  assert.equal(search('实收金额', '-95.00').orders[0].id, 'search-original');
  assert.equal(search('实收金额', '0.00').orders.length, 3);
  assert.equal(search('实际入库数量', '1.0').orders.length, 1);
  assert.equal(search('实际入库数量', '0').orders.length, 0, 'blank is not zero');
  assert.equal(search('数量', '1.1').orders.length, 0);
  assert.equal(search('单价', 'NaN').orders.length, 0);
  assert.equal(search('单价', '元').orders.length, 0);
  assert.equal(search('单价', '120.001').orders.length, 0);
});

test('date filtering follows payment and refund time, and exports complete matched orders within that day', () => {
  const first = search('条码', '001Abc-005', '2026-09-28');
  assert.equal(first.received, 95); assert.equal(first.refunded, 0);
  assert.ok(first.rows.some(row => row.includes('LJC1_TEST123')), 'retain coupon allocation context');
  assert.ok(first.rows.some(row => row.includes('测试赠品')), 'retain gifts');
  const refund = search('流水号', 'SERIAL-REFUND', '2026-09-29');
  assert.equal(refund.orders.length, 1); assert.equal(refund.refunded, 95); assert.equal(refund.net, -95);
  assert.equal(refund.rows.length, 2);
  assert.equal(search('流水号', 'SERIAL-ORIGINAL', '2026-09-29').orders.length, 0);
  assert.equal(search('条码', 'LJC1_TEST123', '2026-09-29').orders.length, 0);
  assert.deepEqual(refund.rows, financialExportRows(refund.orders, '2026-09-29'));
  assert.equal(search('资金发生时间', '2026-09-29 10:00').orders.length, 1);
});

test('all-dates totals net refunds once and cancelled orders contribute no revenue', () => {
  const all = queryLedger(index);
  assert.equal(all.orders.length, 4); assert.equal(all.received, 215); assert.equal(all.refunded, 95); assert.equal(all.net, 120);
  assert.deepEqual(all.rows, financialExportRows(orders));
  const cancelled = search('状态', '已取消');
  assert.equal(cancelled.orders.length, 1); assert.equal(cancelled.net, 0);
  const empty = search('产品名称', '不存在');
  assert.equal(empty.net, 0); assert.deepEqual(empty.rows, [LEDGER_EXPORT_HEADER]);
});

test('summary, coupon, physical prize, payment and after-sales fields are searchable without changing data', () => {
  const before = JSON.stringify(orders);
  for (const [field, value, id] of [
    ['orderStatus', '已全额退款', 'search-original'], ['orderNet', '120', 'search-other'],
    ['orderSubtotal', '120', 'search-other'], ['orderDiscount', '5', 'search-original'],
    ['orderTotal', '95', 'search-original'], ['changeCount', '1', 'search-original'],
    ['reason', '尺码不合适', 'search-original'], ['eventType', '退款', 'search-original'],
    ['tenderSn', 'TENDER-REFUND', 'search-original'], ['tenderAmount', '-95', 'search-original'],
    ['paymentMode', '测试商户', 'search-original'], ['physicalStatus', '实物奖品已核销', 'search-physical'],
    ['优惠券面额', '5.00', 'search-original'], ['关联奖品权益ID', 'AWARD-TEST', 'search-physical'],
  ]) assert.ok(search(field, value).orders.some(order => order.id === id), field);
  assert.equal(search('reason', '尺码', '2026-09-28').orders.length, 0);
  assert.equal(search('tenderSn', 'TENDER-ORIGINAL', '2026-09-29').orders.length, 0);
  assert.equal(JSON.stringify(orders), before);
});

test('exchanged products are matched on their financial date with full adjustment details', () => {
  const order = structuredClone(orders[1]);
  const plan = adjustmentPlan(order, { id: 'exchange-1', type: 'exchange', reason: '换颜色',
    returns: [{ lineId: `${order.id}:0`, qty: 1, restockQty: 1 }],
    newItems: [{ id: 'new', name: '换入的新商品', sku: 'NEW-SKU', barcode: 'NEW-CODE', price: 150, qty: 1, productType: 'sale' }] });
  order.afterSales = [{ id: plan.id, plan, completedAt: '2026-09-29T11:00:00+08:00', tenders: [], orderSn: '' }];
  const result = queryLedger(createLedgerSearchIndex([order]), { date: '2026-09-29', field: '货品编码', keyword: 'new-sku' });
  assert.equal(result.orders.length, 1); assert.equal(result.net, 30); assert.equal(result.rows.length, 3);
  assert.ok(result.rows.some(row => row.includes('运动腰包')));
  assert.equal(ledgerDateKey('invalid'), '');
});
