function safeMessage(value) {
  const text = String(value || '');
  if (/PRIVATE KEY|BEGIN .*KEY/i.test(text)) return '返回信息含敏感内容，请联系技术支持';
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/https?:\/\/\S+/g, '[链接已隐藏]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已隐藏]')
    .replace(/\d{11,}/g, '[号码已隐藏]').slice(0, 180);
}

function safeParameters(body) {
  if (!body || typeof body !== 'object') return {};
  const next = {};
  for (const field of ['request_id', 'brand_code', 'store_sn', 'workstation_sn', 'check_sn', 'order_sn', 'order_type', 'order_status', 'amount', 'currency', 'scene', 'result_code', 'error_code']) {
    if (['number', 'string'].includes(typeof body[field])) next[field] = String(body[field]).slice(0, 80);
  }
  if (Array.isArray(body.tenders)) next.tenders = body.tenders.slice(0, 100).map((item) => {
    const tender = {};
    for (const field of ['transaction_sn', 'original_tender_sn', 'tender_sn', 'internal_transaction_sn', 'amount', 'collected_amount', 'paid_amount', 'pay_status', 'sub_tender_type', 'pay_time']) {
      if (['number', 'string'].includes(typeof item[field])) tender[field] = String(item[field]).slice(0, 80);
    }
    if (item.reason) tender.reason = safeMessage(item.reason);
    return tender;
  });
  return next;
}

module.exports = { safeMessage, safeParameters };
