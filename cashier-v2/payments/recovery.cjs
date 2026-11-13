const MIN_PAYMENT_AGE_MS = 120000;
const MIN_NOT_FOUND_WINDOW_MS = 60000;
const MAX_QUERY_AGE_MS = 60000;

function canResolveMissingPayment(record, credentialId, now = Date.now()) {
  const evidence = record?.missingOrder;
  if (!record || record.state !== 'pending' || record.acknowledged || record.parentId || record.kind
    || record.orderSn || record.remoteOrderSeenAt || record.tenders?.length
    || !evidence || evidence.credentialId !== credentialId || evidence.count < 2) return false;
  const age = now - Date.parse(record.createdAt);
  const first = Date.parse(evidence.firstCheckedAt);
  const last = Date.parse(evidence.lastCheckedAt);
  return age >= MIN_PAYMENT_AGE_MS && last - first >= MIN_NOT_FOUND_WINDOW_MS
    && now >= last && now - last <= MAX_QUERY_AGE_MS;
}

module.exports = { canResolveMissingPayment };
