import { priceOrder, isCoupon, isExternalPhysical, reconcileStock, orderExportRows } from './orderLogic.js';

const portion = (cents, qty, total) => Number(BigInt(cents) * BigInt(qty) / BigInt(total));

export const toCents = (value) => {
  const cents = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('金额无效');
  return cents;
};

export function saleLines(order) {
  const priced = priceOrder(order.items, order.method === '0元出库');
  const goods = priced.items.map((item, index) => ({ ...item, lineId: `${order.id}:${index}`, originalQty: item.qty }))
    .filter((item) => !isCoupon(item));
  const base = goods.reduce((sum, item) => sum + toCents(item.lineTotal), 0);
  const coupon = toCents(priced.couponDiscount);
  const shares = goods.map((item, index) => {
    const weighted = BigInt(toCents(item.lineTotal)) * BigInt(coupon);
    return { index, cents: base ? Number(weighted / BigInt(base)) : 0, remainder: base ? weighted % BigInt(base) : 0n };
  });
  let rest = coupon - shares.reduce((sum, item) => sum + item.cents, 0);
  for (const share of [...shares].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)) {
    if (rest <= 0) break;
    share.cents++; rest--;
  }
  return goods.map((item, index) => ({ ...item, netCents: toCents(item.lineTotal) - shares[index].cents, returnedQty: 0 }));
}

export function remainingLines(order) {
  const lines = saleLines(order);
  for (const adjustment of order.afterSales || []) {
    for (const returned of adjustment.plan.returns) {
      const line = lines.find((item) => item.lineId === returned.lineId);
      if (!line || line.returnedQty + returned.qty > line.originalQty) throw new Error('退换货记录不一致，请核实原订单');
      line.returnedQty += returned.qty;
    }
    lines.push(...adjustment.plan.newLines.map((line) => ({ ...line, returnedQty: 0 })));
  }
  return lines.map((item) => ({ ...item, qty: item.originalQty - item.returnedQty,
    remainingCents: item.netCents - portion(item.netCents, item.returnedQty, item.originalQty) })).filter((item) => item.qty > 0);
}

export function adjustmentPlan(order, request) {
  if (!request || !/^[a-zA-Z0-9-]{1,64}$/.test(request.id || '')) throw new Error('退换货编号无效');
  if (!['return', 'exchange'].includes(request.type)) throw new Error('请选择退货或换货');
  if (order.status === '已取消' || order.status === '待收款') throw new Error('该订单不能退换货');
  if (order.revisions?.length && order.payment?.provider === 'sqb') throw new Error('这笔旧订单曾在外部调整，请先人工核对，不能直接自动退款');
  const available = remainingLines(order);
  if (!Array.isArray(request.returns) || !request.returns.length) throw new Error('请选择退回商品');
  const seen = new Set();
  const returns = request.returns.map((selected) => {
    const line = available.find((item) => item.lineId === selected.lineId);
    if (!line || seen.has(line.lineId)) throw new Error('退货商品不存在或重复');
    seen.add(line.lineId);
    const qty = Number(selected.qty);
    const restockQty = Number(selected.restockQty);
    if (!Number.isSafeInteger(qty) || qty <= 0 || qty > line.qty) throw new Error(`${line.name} 超过可退数量`);
    if (!Number.isSafeInteger(restockQty) || restockQty < 0 || restockQty > qty) throw new Error(`${line.name} 入库数量无效`);
    const creditCents = portion(line.netCents, line.returnedQty + qty, line.originalQty)
      - portion(line.netCents, line.returnedQty, line.originalQty);
    return { ...line, qty, restockQty, creditCents };
  });
  const incoming = request.type === 'exchange' ? request.newItems || [] : [];
  if (request.type === 'exchange' && !incoming.length) throw new Error('请选择换入商品');
  if (incoming.some(isCoupon)) throw new Error('换货不新增优惠券，原券优惠已分摊在可退金额中');
  if (incoming.some(item => item.externalCoupon)) throw new Error('换货不新增抽奖奖品权益，请使用独立领取订单');
  const priced = incoming.length ? priceOrder(incoming) : { items: [], total: 0 };
  const newLines = priced.items.map((item, index) => ({ ...item, lineId: `${request.id}:${index}`, originalQty: item.qty, netCents: toCents(item.lineTotal), returnedQty: 0 }));
  const creditCents = returns.reduce((sum, line) => sum + line.creditCents, 0);
  const replacementCents = toCents(priced.total);
  const deltaCents = replacementCents - creditCents;
  return { id: request.id, parentId: order.id, type: request.type, revision: (order.afterSales || []).length,
    returns, newLines, creditCents, replacementCents, deltaCents,
    refundCents: Math.max(0, -deltaCents), chargeCents: Math.max(0, deltaCents),
    reason: String(request.reason || '').trim().slice(0, 200) };
}

export function validateAdjustmentStock(products, plan) {
  return reconcileStock(products, plan.returns.filter((line) => line.restockQty > 0).map((line) => ({ ...line, qty: line.restockQty })), plan.newLines);
}

export function applyAdjustment(ledger, record) {
  const done = record.kind === 'refund' ? record.state === 'refunded'
    : record.kind === 'exchange-charge' ? record.state === 'paid' : record.state === 'completed';
  if (!done || !record.plan || record.plan.parentId !== record.parentId) throw new Error('退换货资金结果尚未确认');
  const original = ledger.orders.find((order) => order.id === record.parentId);
  if (!original) throw new Error('未找到退换货原订单，请恢复正确的经营备份');
  const existing = (original.afterSales || []).find((item) => item.id === record.id);
  if (existing) {
    if (existing.orderSn !== (record.orderSn || '') || existing.plan.deltaCents !== record.plan.deltaCents) throw new Error('退换货记录不一致');
    return { ...ledger, pendingAdjustment: null };
  }
  if ((original.afterSales || []).length !== record.plan.revision) throw new Error('订单已更新，请先同步先前退换货');
  const plan = adjustmentPlan(original, { ...record.plan, newItems: record.plan.newLines });
  if (plan.deltaCents !== record.plan.deltaCents || JSON.stringify(plan.returns.map((item) => [item.lineId, item.qty, item.restockQty, item.creditCents]))
    !== JSON.stringify(record.plan.returns.map((item) => [item.lineId, item.qty, item.restockQty, item.creditCents]))) throw new Error('退换货金额与原订单不一致');
  const nextProducts = validateAdjustmentStock(ledger.products, record.plan);
  const entry = { id: record.id, kind: record.kind, plan: record.plan, state: record.state, orderSn: record.orderSn || '',
    identity: record.identity, tenders: record.tenders || [], completedAt: record.completedAt || record.updatedAt,
    amount: record.amount, mode: record.mode };
  const order = { ...original, afterSales: [...(original.afterSales || []), entry], updatedAt: entry.completedAt };
  return { ...ledger, products: nextProducts, orders: ledger.orders.map((item) => item.id === order.id ? order : item), pendingAdjustment: null };
}

export function channelName(tender) {
  return ({ 301: '微信', 302: '支付宝', 402: '花呗分期', 201: '银行卡' })[Number(tender.subTenderType)] || tender.channel || '移动支付';
}

export function transactionTime(tenders, fallback) {
  const times = (tenders || []).map((item) => item.payTime).filter((time) => typeof time === 'string' && Number.isFinite(Date.parse(time)));
  return times.sort((a, b) => Date.parse(b) - Date.parse(a))[0] || fallback;
}

export function financialEvents(order) {
  if (['待收款', '已取消'].includes(order.status)) return [];
  const main = { id: order.id, parentId: order.id, type: '收款', amount: Number(order.total),
    at: transactionTime(order.payment?.tenders, order.paidAt || order.createdAt), tenders: order.payment?.tenders || [], orderSn: order.payment?.orderSn || '' };
  return [main, ...(order.afterSales || []).map((entry) => ({ id: entry.id, parentId: order.id,
    type: entry.plan.deltaCents < 0 ? '退款' : entry.plan.deltaCents > 0 ? '换货补款' : '零差价调整',
    amount: entry.plan.deltaCents / 100, at: transactionTime(entry.tenders, entry.completedAt),
    tenders: entry.tenders, orderSn: entry.orderSn, plan: entry.plan }))];
}

export function orderNet(order) {
  return financialEvents(order).reduce((sum, event) => sum + Math.round(event.amount * 100), 0) / 100;
}

export function orderDisplayStatus(order) {
  if (!order.afterSales?.length) return order.status || '已收款';
  if (orderNet(order) === 0 && order.total > 0) return '已全额退款';
  return order.afterSales.at(-1).plan.type === 'exchange' ? '已换货' : '已部分退货';
}

export function tenderTotals(tenders, field) {
  if (!tenders?.length || tenders.some((item) => item[field] == null)) return null;
  return tenders.reduce((sum, item) => sum + Math.abs(Number(item[field])), 0) / 100;
}

export function financialExportRows(orders, date = '') {
  const dateKey = (at) => {
    const value = new Date(at);
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  };
  const included = (at) => !date || dateKey(at) === date;
  const extra = ['记录类型', '资金发生时间', '关联原订单', '退换货编号', '实际入库数量', '渠道顾客实付或实退(整笔)', '渠道商户收付(整笔)', '金额口径'];
  const baseHeader=orderExportRows([])[0],prizeColumn=baseHeader.indexOf('实物奖品发放数量');
  // Append new prize columns after the existing financial schema to preserve old CSV column positions.
  const rows = [baseHeader.slice(0,prizeColumn).concat(extra,baseHeader.slice(prizeColumn))];
  for (const order of orders) {
    const events = financialEvents(order);
    const main = events[0];
    const at = main?.at || order.createdAt;
    if (included(at)) {
      orderExportRows([order]).slice(1).forEach((row, index) => {
        row[20] = (order.payment?.tenders || []).map(channelName).join(' / ');
        rows.push([...row.slice(0,prizeColumn), '原订单', at, order.orderNo || order.id, '', '',
          index === 0 ? tenderTotals(main?.tenders, 'paidAmount') ?? '' : '',
          index === 0 ? tenderTotals(main?.tenders, 'collectedAmount') ?? '' : '', '原订单含券抵扣，渠道整笔金额仅首行列出',...row.slice(prizeColumn)]);
      });
    }
    for (const event of events.slice(1)) {
      if (!included(event.at)) continue;
      const serial = event.tenders.map((item) => item.internalTransactionSn).filter(Boolean).join(' / ');
      const lines = [...event.plan.returns.map((line) => ({ ...line, amount: -line.creditCents, signedQty: -line.qty, recordType: '退回商品' })),
        ...event.plan.newLines.map((line) => ({ ...line, amount: line.netCents, signedQty: line.qty, recordType: '换出商品', restockQty: 0 }))];
      lines.forEach((line, index) => {
        const sign = event.amount < 0 ? -1 : 1;
        rows.push([serial, `${event.id}-${index + 1}`, order.createdAt, event.at, '已完成', order.method,
          line.name, line.barcode, line.sku, line.group, line.productType === 'gift' ? '赠品' : '售卖品', line.price, line.signedQty,
          line.amount / 100, 0, line.amount / 100, line.productType === 'gift' || isExternalPhysical(line) ? 0 : line.signedQty, order.orderNo || order.id, event.orderSn, serial,
          event.tenders.map(channelName).join(' / '), event.tenders.map((item) => item.channelSn).filter(Boolean).join(' / '), '',
          line.recordType, event.at, order.orderNo || order.id, event.id, line.restockQty,
          index === 0 && tenderTotals(event.tenders, 'paidAmount') != null ? sign * tenderTotals(event.tenders, 'paidAmount') : '',
          index === 0 && tenderTotals(event.tenders, 'collectedAmount') != null ? sign * tenderTotals(event.tenders, 'collectedAmount') : '', '原券已分摊；商品实收合计等于退换差额',isExternalPhysical(line) ? line.signedQty : 0,line.externalCoupon?.couponId || '']);
      });
    }
  }
  return rows;
}
