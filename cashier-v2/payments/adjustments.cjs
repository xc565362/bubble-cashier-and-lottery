const crypto = require('node:crypto');

const successful = (record) => ['paid', 'refunded', 'completed'].includes(record.state);
const digest = (plan) => crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');

async function buildPlan(records, config, parentId, request) {
  const root = records[parentId];
  if (!root || root.kind || root.state !== 'paid' || !root.acknowledged) throw new Error('原收款尚未完成对账，或缺少支付记录，请先恢复完整备份');
  for (const key of ['brand_code', 'store_sn', 'workstation_sn']) {
    if (root.identity[key] !== config[key]) throw new Error('当前支付配置与原收款门店或收银机不一致，请恢复原配置');
  }
  if (root.mode !== (config.mode || 'test')) throw new Error('测试与正式交易不可混用');
  const history = Object.values(records).filter((item) => item.parentId === parentId && successful(item)).sort((a, b) => a.plan.revision - b.plan.revision);
  if (history.some((item, index) => item.plan.revision !== index)) throw new Error('退换货历史缺失，请恢复最新备份');
  const order = { ...root.draft, status: '已收款', payment: { provider: 'sqb' }, afterSales: history };
  const { adjustmentPlan } = await import('../src/afterSales.js');
  const plan = adjustmentPlan(order, request);
  return { root, plan, digest: digest(plan), history };
}

function allocateRefund(records, parentId, amount) {
  const funding = Object.values(records).filter((item) => (item.id === parentId || item.parentId === parentId && item.kind === 'exchange-charge') && item.state === 'paid');
  const previous = Object.values(records).filter((item) => item.parentId === parentId && item.kind === 'refund' && item.state === 'refunded');
  const allocations = [];
  let remaining = amount;
  for (const record of funding) {
    for (const tender of record.tenders || []) {
      if (tender.payStatus !== 3 || !tender.tenderSn) continue;
      const used = previous.flatMap((item) => item.allocations).filter((item) => item.tenderSn === tender.tenderSn).reduce((sum, item) => sum + item.amount, 0);
      const available = tender.amount - used;
      if (!Number.isSafeInteger(available) || available < 0) throw new Error('已退金额与原支付不一致');
      const part = Math.min(remaining, available);
      if (part > 0) allocations.push({ sourceId: record.id, tenderSn: tender.tenderSn, amount: part, transactionSn: crypto.randomUUID() });
      remaining -= part;
    }
  }
  if (remaining) throw new Error('可原路退款余额不足，请核对历史收退款记录');
  return { allocations, funding };
}

module.exports = { buildPlan, allocateRefund, successful, digest };
