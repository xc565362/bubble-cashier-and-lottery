'use strict';

function recordsQuery(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['limit', 'cursor', 'outcome', 'participantRef'].includes(key))) throw new Error('抽奖记录查询参数不正确');
  const limit = input.limit ?? 20, cursor = input.cursor ?? '', outcome = input.outcome ?? 'all', participantRef = input.participantRef ?? '';
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || typeof cursor !== 'string' || cursor.length > 4096 ||
      !['all', 'won', 'lost'].includes(outcome) || typeof participantRef !== 'string' || participantRef.length > 160 ||
      /[\u0000-\u001f\u007f]/.test(cursor + participantRef)) throw new Error('抽奖记录查询参数不正确');
  return { limit, cursor, outcome, participantRef };
}

function assertRecordsIdentity(data, campaignId) {
  if (data?.service !== 'lottery-records' || data.version !== 1 || data.campaignId !== campaignId ||
      !Array.isArray(data.items) || data.items.length > 50) throw new Error('抽奖记录接口身份或格式不匹配，请核对云端活动连接');
  return data;
}

module.exports = { recordsQuery, assertRecordsIdentity };
