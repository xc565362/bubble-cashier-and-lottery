const crypto = require('node:crypto');
const jsonMap = require('json-source-map');
const { rsaKey } = require('./credentials.cjs');
const { safeMessage, safeParameters } = require('./diagnostics.cjs');

function signedEnvelope(field, value, privateKey) {
  const raw = JSON.stringify(value);
  const signature = crypto.sign('RSA-SHA256', Buffer.from(raw, 'utf8'), privateKey).toString('base64');
  return `{"${field}":${raw},"signature":${JSON.stringify(signature)}}`;
}

function verifyEnvelope(raw, field, publicKey, appid) {
  const { data, pointers } = jsonMap.parse(raw);
  const range = pointers[`/${field}`];
  if (!range || !data.signature || typeof data[field] !== 'object') throw new Error('收钱吧响应格式不正确');
  // Verify the original signed bytes, preserving whitespace and escaped characters.
  const signed = raw.slice(range.value.pos, range.valueEnd.pos);
  if (!crypto.verify('RSA-SHA256', Buffer.from(signed, 'utf8'), publicKey, Buffer.from(data.signature, 'base64'))) {
    throw new Error('收钱吧签名校验失败，不能确认收款');
  }
  const envelope = data[field];
  if (envelope.head?.appid !== appid || envelope.head?.sign_type !== 'SHA256') throw new Error('收钱吧响应身份不匹配');
  return envelope.body;
}

function validateConfig(config) {
  for (const [key, max] of [['appid', 32], ['brand_code', 32], ['store_sn', 36], ['workstation_sn', 36], ['operator', 32]]) {
    if (typeof config[key] !== 'string' || !config[key].trim() || config[key].length > max) throw new Error(`请填写有效的 ${key}`);
  }
  const url = new URL(config.gateway);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.shouqianba.com') || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname) || (url.port && url.port !== '443')) {
    throw new Error('请填写收钱吧技术支持提供的 HTTPS 网关域名（shouqianba.com 子域名）');
  }
  if (config.notify_url) {
    const notify = new URL(config.notify_url);
    if (notify.protocol !== 'https:' || notify.username || notify.password || config.notify_url.length > 255) throw new Error('通知地址必须是可公网访问的 HTTPS 地址');
  }
  const key = rsaKey(config.platformPublicKey);
  if (config.mode && !['test', 'production'].includes(config.mode)) throw new Error('请选择测试参数或正式参数');
  return { ...config, mode: config.mode || 'test', gateway: url.origin, platformPublicKey: key.export({ type: 'spki', format: 'pem' }) };
}

function purchaseBody(config, draft, code) {
  if (!/^\d{16,32}$/.test(code)) throw new Error('请扫描顾客付款码，不能使用商品条码');
  const amount = Math.round(Number(draft.total) * 100);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 999999999999) throw new Error('收钱吧收款金额必须大于 0，0 元订单请使用0元出库');
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(draft.orderNo)) throw new Error('订单号格式不正确');
  return {
    request_id: crypto.randomUUID(), brand_code: config.brand_code, store_sn: config.store_sn,
    workstation_sn: config.workstation_sn, check_sn: draft.orderNo, sales_sn: draft.orderNo,
    scene: '12', sales_time: new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00'),
    amount: String(amount), currency: '156', subject: '摆摊商品', operator: config.operator,
    industry_code: '0', pos_info: 'stall-cashier/0.7.3', dynamic_id: code,
    ...(config.notify_url ? { notify_url: config.notify_url } : {}),
  };
}

function resultState(data, record) {
  for (const key of ['brand_code', 'store_sn', 'workstation_sn', 'check_sn']) {
    if (String(data[key] ?? '') !== String(record.identity[key])) throw new Error(`支付结果的 ${key} 与本单不符`);
  }
  if (data.order_type !== undefined && String(data.order_type) !== '1') throw new Error('收到的不是销售支付结果');
  if (record.orderSn && data.order_sn !== record.orderSn) throw new Error('支付订单号与已记录订单不一致');
  if (String(data.currency) !== '156' || Number(data.amount) !== record.amount) throw new Error('支付结果金额或币种与本单不符');
  const tenders = Array.isArray(data.tenders) ? data.tenders : [];
  const success = tenders.filter((entry) => Number(entry.pay_status) === 3);
  const paid = success.reduce((sum, entry) => sum + Number(entry.amount), 0);
  const status = Number(data.order_status);
  if (status === 4 && paid === record.amount && success.length && data.order_sn && success.every((entry) => entry.tender_sn)) return 'paid';
  if ([0, 6, 7].includes(status) && paid === 0 && tenders.every((entry) => [1, 7].includes(Number(entry.pay_status)))) return 'failed';
  if (status === 5 || paid > 0 || status === 4) return 'review';
  return 'pending';
}

function refundBody(config, record) {
  if (!Number.isSafeInteger(record.amount) || record.amount <= 0 || !record.allocations?.length) throw new Error('退款金额无效');
  if (record.allocations.reduce((sum, item) => sum + item.amount, 0) !== record.amount) throw new Error('退款分摊与金额不一致');
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
  return { request_id: record.requestId, ...record.identity, sales_sn: record.salesSn || record.parentId,
    sales_time: now, amount: String(-record.amount), currency: '156', subject: '商品退换',
    operator: config.operator, industry_code: '0', pos_info: 'stall-cashier/0.7.3',
    ...(config.notify_url ? { notify_url: config.notify_url } : {}),
    tenders: record.allocations.map((item) => ({ transaction_sn: item.transactionSn,
      original_tender_sn: item.tenderSn, amount: String(-item.amount), pay_status: '0', operation: '9' })) };
}

function validateIdentity(data, record) {
  for (const key of ['brand_code', 'store_sn', 'workstation_sn', 'check_sn']) {
    if (String(data[key] ?? '') !== String(record.identity[key])) throw new Error(`退款结果的 ${key} 与本单不符`);
  }
  if (!data.order_sn || (record.orderSn && data.order_sn !== record.orderSn)) throw new Error('退款订单身份不匹配');
}

function refundResultState(data, record) {
  validateIdentity(data, record);
  if (String(data.order_type) !== '2' || String(data.currency) !== '156' || Number(data.amount) !== -record.amount) throw new Error('退款类型、金额或币种不符');
  const tenders = Array.isArray(data.tenders) ? data.tenders : [];
  const success = tenders.filter((item) => Number(item.pay_status) === 5);
  const used = new Set();
  for (const tender of success) {
    const allocation = record.allocations.find((item) => tender.transaction_sn ? item.transactionSn === tender.transaction_sn
      : tender.original_tender_sn ? item.tenderSn === tender.original_tender_sn : record.allocations.length === 1);
    if (!allocation || used.has(allocation.transactionSn) || Number(tender.amount) !== -allocation.amount
      || (tender.original_tender_sn && tender.original_tender_sn !== allocation.tenderSn) || !tender.tender_sn) throw new Error('退款流水与原支付不匹配');
    used.add(allocation.transactionSn);
  }
  if (Number(data.order_status) === 4 && used.size === record.allocations.length) return 'refunded';
  if ([0, 6, 7].includes(Number(data.order_status)) && !success.length && tenders.every((item) => [1, 6, 7].includes(Number(item.pay_status)))) return 'failed';
  if (success.length || [4, 5].includes(Number(data.order_status))) return 'review';
  return 'pending';
}

async function requestApi(config, privateKey, path, body, fetchFn = fetch, terminalIp, observe = () => {}) {
  const request = {
    head: { version: '1.0.0', sign_type: 'SHA256', appid: config.appid, request_time: new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00') },
    body,
  };
  observe({ phase: 'request', endpoint: path, parameters: safeParameters(body) });
  const response = await fetchFn(`${config.gateway}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', ...(terminalIp ? { 'X-Forwarded-For': terminalIp } : {}) },
    body: signedEnvelope('request', request, privateKey), signal: AbortSignal.timeout(45000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`收钱吧连接异常 (${response.status})，请查单确认`);
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error('收钱吧响应过大');
  const result = verifyEnvelope(text, 'response', config.platformPublicKey, config.appid);
  observe({ phase: 'response', endpoint: path, parameters: safeParameters(result.biz_response?.data || result.biz_response || result) });
  if (String(result.result_code) !== '200' || String(result.biz_response?.result_code) !== '200') {
    const code = result.biz_response?.error_code || result.error_code || 'UNKNOWN';
    const safeCode = String(code).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80);
    const reason = safeMessage(result.biz_response?.error_message || result.biz_response?.reason || result.error_message);
    const error = new Error(`收钱吧返回 ${safeCode}${reason ? `：${reason}` : '，请查单或联系技术支持'}`);
    error.gatewayCode = safeCode;
    error.verifiedResponse = true;
    throw error;
  }
  if (!result.biz_response.data) throw new Error('收钱吧未返回支付明细');
  return result.biz_response.data;
}

module.exports = { signedEnvelope, verifyEnvelope, validateConfig, purchaseBody, resultState, requestApi, refundBody, refundResultState, validateIdentity };
