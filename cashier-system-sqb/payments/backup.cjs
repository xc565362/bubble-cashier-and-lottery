const crypto = require('node:crypto');
const { publicFingerprint } = require('./credentials.cjs');

function validateBusiness(business, records) {
  if (business?.type !== 'stall-cashier-backup' || !Array.isArray(business.products) || !Array.isArray(business.orders) || !Array.isArray(business.heldCarts)) throw new Error('经营备份格式无效');
  const ids = new Set();
  for (const order of business.orders) {
    if (!order.id || ids.has(order.id)) throw new Error('备份订单编号重复或缺失');
    ids.add(order.id);
    if (order.payment?.provider !== 'sqb') continue;
    const source = records[order.id];
    if (!source || source.state !== 'paid' || source.orderSn !== order.payment.orderSn) throw new Error('经营订单缺少匹配的支付记录，请使用原电脑的完整备份');
    const lines = (items) => JSON.stringify(items.map((item) => [item.id, Number(item.qty), Number(item.price), Number(item.discount || 0), item.productType, Number(item.couponAmount || 0)]));
    if (!order.revisions?.length && (Math.round(order.total * 100) !== source.amount || lines(order.items) !== lines(source.draft.items))) throw new Error('原订单金额或商品与已确认支付不一致，不能生成可退款备份');
    const history = Object.values(records).filter((item) => item.parentId === order.id && ['paid', 'refunded', 'completed'].includes(item.state));
    if (history.length !== (order.afterSales || []).length || history.some((item) => !(order.afterSales || []).some((entry) => entry.id === item.id && JSON.stringify(entry.plan) === JSON.stringify(item.plan)))) throw new Error('经营数据与退换货记录不同步，请先完成对账');
  }
  for (const record of Object.values(records)) {
    if (record.state === 'failed') continue;
    if (!record.acknowledged || !['paid', 'refunded', 'completed'].includes(record.state)) throw new Error('还有未完成收退款，不能迁移');
    if (!ids.has(record.parentId || record.id)) throw new Error('支付记录缺少对应经营订单，请勿覆盖旧账');
  }
}

function createBackup(business, records, config, publicKey, privateKey) {
  validateBusiness(business, records);
  const content = JSON.stringify({ business, records, merchant: {
    appid: config.appid, brand_code: config.brand_code, store_sn: config.store_sn, workstation_sn: config.workstation_sn,
    mode: config.mode || 'test', fingerprint: publicFingerprint(publicKey),
  } });
  return { type: 'stall-cashier-signed-backup', version: 3, content,
    signature: crypto.sign('RSA-SHA256', Buffer.from(content), privateKey).toString('base64') };
}

function verifyBackup(bundle, currentRecords, config, publicKey) {
  if (bundle?.type !== 'stall-cashier-signed-backup' || bundle.version !== 3 || typeof bundle.content !== 'string' || !publicKey) throw new Error('请先导入原电脑的收钱吧加密配置，再恢复完整经营备份');
  if (!crypto.verify('RSA-SHA256', Buffer.from(bundle.content), publicKey, Buffer.from(String(bundle.signature), 'base64'))) throw new Error('备份签名校验失败，文件已修改或不是原商户密钥');
  const data = JSON.parse(bundle.content);
  for (const field of ['appid', 'brand_code', 'store_sn', 'workstation_sn', 'mode']) {
    if (data.merchant?.[field] !== config[field]) throw new Error('当前配置与备份商户不一致，请先导入原加密配置');
  }
  if (data.merchant.fingerprint !== publicFingerprint(publicKey)) throw new Error('备份密钥不一致');
  validateBusiness(data.business, data.records);
  for (const existing of Object.values(currentRecords)) {
    if (existing.state === 'failed') continue;
    const incoming = data.records[existing.id];
    if (!incoming || incoming.state !== existing.state || incoming.orderSn !== existing.orderSn || incoming.amount !== existing.amount
      || incoming.fingerprint !== existing.fingerprint || JSON.stringify(incoming.plan) !== JSON.stringify(existing.plan)) throw new Error('备份早于本机支付记录或存在冲突，不能回滚资金账');
  }
  return { business: data.business, records: { ...currentRecords, ...data.records } };
}

module.exports = { createBackup, verifyBackup, validateBusiness };
