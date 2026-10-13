function paymentNotice(record) {
  if (record?.state !== 'paid' || !record.orderSn || !Number.isSafeInteger(record.amount) || record.amount <= 0) {
    throw new Error('付款未确认，不能发送收款成功通知');
  }
  const serials = [...new Set((record.tenders || []).filter((item) => Number(item.payStatus) === 3)
    .map((item) => String(item.internalTransactionSn || '').trim()).filter(Boolean))];
  return {
    id: record.id,
    title: '收款成功',
    body: `收款成功，收款 ${(record.amount / 100).toFixed(2)} 元${serials.length ? `\n收钱吧流水号 ${serials.join(' / ')}` : ''}`,
  };
}

module.exports = { paymentNotice };
