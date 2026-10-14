export const DRAW_RECORDS_CAPABILITY = 'draw-records-v1';
const outcomes = ['won', 'lost', 'unknown'];
const issuanceStates = ['not_applicable', 'pending', 'issued', 'legacy', 'unknown'];
const redemptionStates = ['not_applicable', 'unknown', 'AVAILABLE', 'RESERVED', 'PAYMENT_PENDING', 'REDEEMED', 'VOID', 'EXPIRED'];
const sources = ['none', 'coupon_center', 'legacy_record', 'unverified'];
const malformed = () => { throw new Error('云端抽奖记录格式异常，请刷新重试；没有将异常数据作为有效记录显示'); };
function text(value, max = 160, optional = false) {
  if (optional && value == null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) malformed();
  return value;
}
function timestamp(value, optional = true) {
  if (optional && value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) malformed();
  return value;
}

// Keep the view on a bounded, explicit schema. Never forward raw OpenIDs,
// redemption codes, server errors or arbitrary database properties to JSX.
export function normalizeDrawRecords(data, campaignId) {
  if (!data || data.service !== 'lottery-records' || data.version !== 1 || data.campaignId !== campaignId ||
      data.order !== 'record_id_asc' || !Number.isInteger(data.limit) || data.limit < 1 || data.limit > 50 ||
      !Array.isArray(data.items) || data.items.length > data.limit ||
      !Number.isSafeInteger(data.total) || data.total < data.items.length || typeof data.hasMore !== 'boolean' ||
      !Array.isArray(data.warnings) || data.warnings.length > 20 ||
      (data.hasMore ? typeof data.nextCursor !== 'string' || !data.nextCursor || data.nextCursor.length > 4096 || !data.items.length : data.nextCursor !== null)) malformed();
  const seen = new Set();
  const items = data.items.map(row => {
    if (!row || !outcomes.includes(row.outcome) || !issuanceStates.includes(row.issuance?.status) ||
        !redemptionStates.includes(row.redemption?.status) || !sources.includes(row.redemption?.source)) malformed();
    const recordId = text(row.recordId, 200);
    if (!/^[a-f0-9]{32,64}$/.test(recordId) || !/^[a-f0-9]{32,64}$/.test(row.participantRef || '') || seen.has(recordId)) malformed();
    seen.add(recordId);
    const prize = row.prize == null ? null : { id: text(row.prize.id, 160), name: text(row.prize.name, 200), kind: text(row.prize.kind, 40) };
    const issuance = { status: row.issuance.status, couponId: text(row.issuance.couponId, 200, true),
      awardId: text(row.issuance.awardId, 200, true), campaignId: text(row.issuance.campaignId, 160, true) };
    const redemption = { status: row.redemption.status, source: row.redemption.source,
      redeemedAt: timestamp(row.redemption.redeemedAt), checkedAt: timestamp(row.redemption.checkedAt) };
    if (row.outcome === 'lost' && (issuance.status !== 'not_applicable' || redemption.status !== 'not_applicable' || redemption.source !== 'none') ||
        row.outcome === 'won' && (issuance.status === 'not_applicable' || redemption.status === 'not_applicable') ||
        issuance.status === 'issued' && !issuance.couponId ||
        redemption.source === 'coupon_center' && (row.outcome !== 'won' || issuance.status !== 'issued' || redemption.checkedAt == null ||
          ['unknown', 'not_applicable'].includes(redemption.status) || redemption.status === 'REDEEMED' && redemption.redeemedAt == null)) malformed();
    // A backend may truthfully report an unverified historical state. It must
    // never be presented as current coupon-center confirmation.
    if (redemption.source !== 'coupon_center') redemption.checkedAt = null;
    return { recordId, participantRef: text(row.participantRef, 160), createdAt: timestamp(row.createdAt), outcome: row.outcome,
      prize, issuance, redemption, legacyStatus: text(row.legacyStatus, 80, true) };
  });
  return { campaignId, items, limit: data.limit, nextCursor: data.nextCursor, hasMore: data.hasMore,
    total: data.total, queriedAt: timestamp(data.queriedAt, false), order: data.order, warnings: data.warnings.map(value => text(value, 500)) };
}

export const drawOutcomeLabel = value => ({ won: '已中奖', lost: '未中奖', unknown: '结果待核对' }[value] || '结果待核对');
export const drawIssuanceLabel = value => ({ not_applicable: '无需发券', pending: '待发券', issued: '已发券', legacy: '历史凭证', unknown: '发券待核对' }[value] || '发券待核对');
export function drawRedemptionLabel(row) {
  if (row.outcome === 'lost' && row.redemption.status === 'not_applicable') return '无需核销';
  if (row.redemption.source === 'legacy_record') return '历史核销状态待核对';
  if (row.redemption.source !== 'coupon_center' || row.redemption.checkedAt == null) return '券中心待核对';
  return { AVAILABLE: '可使用', RESERVED: '核销占用中', PAYMENT_PENDING: '付款待核实', REDEEMED: '已核销', VOID: '已作废', EXPIRED: '已过期' }[row.redemption.status] || '券中心待核对';
}
export const drawTime = value => value == null ? '时间待核对' : new Date(value).toLocaleString('zh-CN', { hour12: false });
export const drawWarningLabel = value => ({
  LEGACY_RECORDS: '本页包含历史凭证记录，其核销状态尚未由券中心确认。',
  CENTER_BINDING_UNVERIFIED: '部分记录的券中心绑定未通过核对，相关核销状态显示为待核对。',
  ISSUANCE_NOT_CONFIRMED: '部分中奖结果尚未确认发券成功；中奖记录已保留。',
  CENTER_STATUS_UNAVAILABLE: '券中心暂时无法查询；抽奖记录正常显示，核销状态暂不作确认。',
}[value] || '部分记录需要进一步核对，请检查活动服务与券中心连接。');
