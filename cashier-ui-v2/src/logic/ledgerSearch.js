import { financialEvents, financialExportRows, orderDisplayStatus, orderNet } from './afterSales.js';
import { isExternalPhysical } from './orderLogic.js';

export const LEDGER_EXPORT_HEADER = financialExportRows([])[0];
const moneyFields = new Set(['单价', '商品金额', '优惠金额', '实收金额', '优惠券面额', '渠道顾客实付或实退(整笔)', '渠道商户收付(整笔)']);
const quantityFields = new Set(['数量', '有效销售数量', '实际入库数量', '实物奖品发放数量']);
const dateFields = new Set(['下单时间', '最后修改时间', '资金发生时间']);
const productFields = new Set(['产品名称', '条码', '货品编码', '商品分组', '商品类型']);
const fieldGroup = (label) => productFields.has(label) ? '商品与优惠券'
  : moneyFields.has(label) || quantityFields.has(label) ? '明细金额与数量'
    : dateFields.has(label) ? '时间' : '订单与交易';

export const LEDGER_SEARCH_FIELDS = [
  ...LEDGER_EXPORT_HEADER.map((label, column) => ({ id: label, label, column, group: fieldGroup(label),
    kind: moneyFields.has(label) ? 'money' : quantityFields.has(label) ? 'number' : dateFields.has(label) ? 'date' : 'text' })),
  { id: 'orderStatus', label: '订单当前状态', group: '订单汇总', kind: 'text' },
  { id: 'orderNet', label: '订单净额', group: '订单汇总', kind: 'money' },
  { id: 'orderSubtotal', label: '订单原金额', group: '订单汇总', kind: 'money' },
  { id: 'orderDiscount', label: '订单总优惠', group: '订单汇总', kind: 'money' },
  { id: 'orderTotal', label: '订单原实收', group: '订单汇总', kind: 'money' },
  { id: 'changeCount', label: '变更次数', group: '订单汇总', kind: 'number' },
  { id: 'paymentMode', label: '收款环境', group: '订单汇总', kind: 'text' },
  { id: 'physicalStatus', label: '实物奖品核销状态', group: '订单汇总', kind: 'text' },
  { id: 'reason', label: '退换货原因', group: '退换货与支付', kind: 'text' },
  { id: 'eventType', label: '资金类型', group: '退换货与支付', kind: 'text' },
  { id: 'tenderSn', label: '支付单号', group: '退换货与支付', kind: 'text' },
  { id: 'tenderAmount', label: '渠道原支付或退款金额', group: '退换货与支付', kind: 'money' },
];

export const LEDGER_SEARCH_GROUPS = [...new Set(LEDGER_SEARCH_FIELDS.map(field => field.group))];
const fieldById = new Map(LEDGER_SEARCH_FIELDS.map(field => [field.id, field]));
const timeColumn = LEDGER_EXPORT_HEADER.indexOf('资金发生时间');

export function ledgerDateKey(at) {
  const value = new Date(at);
  if (!Number.isFinite(value.getTime())) return '';
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

const onDate = (at, date) => !date || ledgerDateKey(at) === date;
const normalize = value => String(value ?? '').normalize('NFKC').trim().toLowerCase();

function matches(value, keyword, kind) {
  if (value == null || value === '') return false;
  if (kind === 'money' || kind === 'number') {
    const numeric = keyword.replace(/[¥￥元,\s]/g, '');
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(numeric)) return false;
    const number = Number(numeric);
    if (!Number.isFinite(number)) return false;
    return Number(value) === number;
  }
  if (kind === 'date') {
    const at = new Date(value);
    if (!Number.isFinite(at.getTime())) return normalize(value).includes(keyword);
    const local = `${ledgerDateKey(value)} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}:${String(at.getSeconds()).padStart(2, '0')}`;
    return [value, local, at.toLocaleString('zh-CN')].some(text => normalize(text).includes(keyword));
  }
  return normalize(value).includes(keyword);
}

// Keep the export schema as the source of searchable detail fields. Index once per ledger update.
export function createLedgerSearchIndex(orders) {
  return orders.map(order => ({ order, rows: financialExportRows([order]).slice(1), events: financialEvents(order) }));
}

function valuesFor(field, order, rows, events) {
  if (field.column != null) return rows.map(row => row[field.column]);
  switch (field.id) {
    case 'orderStatus': return [orderDisplayStatus(order)];
    case 'orderNet': return [orderNet(order)];
    case 'orderSubtotal': return [order.subtotal ?? order.total];
    case 'orderDiscount': return [order.discount ?? 0];
    case 'orderTotal': return [order.total];
    case 'changeCount': return [(order.revisions?.length || 0) + (order.afterSales?.length || 0)];
    case 'paymentMode': return [order.payment?.mode === 'test' ? '测试商户' : order.payment?.mode === 'production' ? '正式商户' : ''];
    case 'physicalStatus': return order.items.some(isExternalPhysical)
      ? [order.physicalFulfilled ? '实物奖品已核销' : '实物奖品领取确认待同步'] : [];
    case 'reason': return events.map(event => event.plan?.reason);
    case 'eventType': return events.map(event => event.type);
    case 'tenderSn': return events.flatMap(event => (event.tenders || []).map(tender => tender.tenderSn));
    case 'tenderAmount': return events.flatMap(event => (event.tenders || []).map(tender => tender.amount == null ? null : Number(tender.amount) / 100));
    default: return [];
  }
}

export function queryLedger(index, { date = '', field = '', keyword = '' } = {}) {
  const term = normalize(keyword);
  const definition = fieldById.get(field);
  const result = { orders: [], rows: [LEDGER_EXPORT_HEADER], events: [], received: 0, refunded: 0, net: 0 };
  // A keyword without a selected field must never silently turn into an all-fields search.
  if (term && !definition) return result;
  for (const entry of index) {
    const rows = entry.rows.filter(row => onDate(row[timeColumn], date));
    const events = entry.events.filter(event => onDate(event.at, date));
    if (!rows.length && !events.length) continue;
    if (term && !valuesFor(definition, entry.order, rows, events).some(value => matches(value, term, definition.kind))) continue;
    result.orders.push(entry.order);
    // Match an order, then retain all its details in the selected date scope, including coupon/refund lines.
    result.rows.push(...rows);
    result.events.push(...events);
  }
  const receivedCents = result.events.reduce((sum, event) => sum + Math.max(0, Math.round(event.amount * 100)), 0);
  const refundedCents = result.events.reduce((sum, event) => sum + Math.max(0, -Math.round(event.amount * 100)), 0);
  result.received = receivedCents / 100;
  result.refunded = refundedCents / 100;
  result.net = (receivedCents - refundedCents) / 100;
  return result;
}
