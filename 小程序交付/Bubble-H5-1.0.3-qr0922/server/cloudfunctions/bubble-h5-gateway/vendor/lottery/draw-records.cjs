'use strict';
const crypto = require('node:crypto');
const fail = (code, message, status = 400) => { throw Object.assign(new Error(message), {code, status, gatewayFault: true}); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const safeId = value => typeof value === 'string' && /^[a-f0-9]{32,64}$/.test(value);
const time = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const safeText = (value, max = 120) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f]/.test(value) ? value : '';

// Query only durable draws. Authentication is provided by the existing signed management handler.
// Cursors are bound to both the campaign and filters; they contain no user OpenID or redemption code.
function createDrawRecords({readPage, campaignId, mode = 'original', key, center, now = Date.now}) {
  function signature(value) { return crypto.createHmac('sha256', key).update(value).digest('hex'); }
  return async (payload = {}) => {
    if (!object(payload) || Object.keys(payload).some(k => !['limit', 'cursor', 'outcome', 'participantRef'].includes(k))) fail('INVALID_RECORD_QUERY', '抽奖记录查询参数无效');
    const limit = payload.limit ?? 20, outcome = payload.outcome ?? 'all', participantRef = payload.participantRef ?? '';
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !['all', 'won', 'lost'].includes(outcome) || typeof participantRef !== 'string' || participantRef && !safeId(participantRef)) fail('INVALID_RECORD_QUERY', '每页须为1至50条，参与者标识须使用记录中显示的完整标识');
    if (!/^[a-f0-9]{64}$/.test(key || '')) fail('RECORDS_UNAVAILABLE', '抽奖记录查询尚未配置', 503);
    const scope = hash(JSON.stringify([campaignId, mode, outcome, participantRef]));
    let after = '';
    if (payload.cursor != null && payload.cursor !== '') {
      if (typeof payload.cursor !== 'string' || payload.cursor.length > 700 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(payload.cursor)) fail('INVALID_RECORD_QUERY', '分页标识无效，请重新查询');
      const [encoded, mac] = payload.cursor.split('.');
      if (!crypto.timingSafeEqual(Buffer.from(signature(encoded), 'hex'), Buffer.from(mac, 'hex'))) fail('INVALID_RECORD_QUERY', '分页标识无效，请重新查询');
      let cursor; try { cursor = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { fail('INVALID_RECORD_QUERY', '分页标识无效，请重新查询'); }
      if (cursor.v !== 1 || cursor.scope !== scope || !safeId(cursor.after)) fail('INVALID_RECORD_QUERY', '分页标识与当前查询不匹配');
      after = cursor.after;
    }
    if (typeof readPage !== 'function') fail('RECORDS_UNAVAILABLE', '抽奖记录查询尚未部署', 503);
    const page = await readPage({campaignId, mode, limit, after, outcome, participantRef});
    if (!page || !Array.isArray(page.rows) || page.rows.length > limit + 1 || !Number.isSafeInteger(page.total) || page.total < 0) fail('RECORDS_UNAVAILABLE', '抽奖记录查询返回异常', 503);
    const selected = page.rows.slice(0, limit), warnings = new Set();
    let previous = after;
    const refs = [];
    const items = selected.map(row => {
      if (!object(row) || !safeId(row._id) || row._id <= previous || row.campaignId !== campaignId || participantRef && row._id !== participantRef) fail('RECORDS_UNAVAILABLE', '抽奖记录查询范围不一致', 503);
      previous = row._id;
      const outcome = mode === 'scarf' ? ['won', 'lost'].includes(row.outcome) ? row.outcome : 'unknown' : row.prize && ['cash', 'physical'].includes(row.prize.kind) ? 'won' : row.outcome === 'lost' ? 'lost' : 'unknown';
      if ((payload.outcome ?? 'all') !== 'all' && outcome !== payload.outcome) fail('RECORDS_UNAVAILABLE', '抽奖记录结果筛选不一致', 503);
      const prize = outcome === 'won' && safeText(row.prize?.id) && safeText(row.prize?.name) ? {id: safeText(row.prize.id), name: safeText(row.prize.name), kind: mode === 'scarf' ? 'physical' : row.prize.kind} : null;
      const binding = mode === 'scarf' ? row.fulfillment === 'cashier' && row.center : row.cashCenter || row.physicalCenter;
      const couponId = safeText(mode === 'scarf' ? row.couponId : row.centerCouponId || row.physicalCouponId) || null;
      const awardId = binding ? mode === 'scarf' ? 'scarf-' + row._id : safeText(binding.awardId) || null : null;
      const owner = binding ? mode === 'scarf' ? 'scarf-' + hash(campaignId + ':' + row.openId) : safeText(binding.owner) : '';
      const item = {recordId: row._id, participantRef: row._id, createdAt: time(row.createdAt), outcome, prize,
        issuance: {status: outcome === 'lost' ? 'not_applicable' : outcome === 'unknown' ? 'unknown' : binding ? couponId ? 'issued' : 'pending' : 'legacy', couponId, awardId, campaignId: binding ? safeText(binding.campaignId) || null : null},
        redemption: {status: outcome === 'lost' ? 'not_applicable' : 'unknown', source: outcome === 'lost' ? 'none' : 'unverified', redeemedAt: null, checkedAt: null},
        legacyStatus: !binding && outcome === 'won' ? safeText(row.status, 40) || null : null};
      if (!binding && outcome === 'won') {
        item.redemption.source = 'legacy_record';
        // A legacy flag is evidence of old local redemption only, never a current coupon-center state.
        warnings.add('LEGACY_RECORDS');
      }
      if (binding && outcome === 'won') {
        if (!center || binding.centerId !== center.centerId || binding.environment !== center.environment || !item.issuance.campaignId || !awardId || !owner || mode === 'scarf' && typeof row.openId !== 'string') warnings.add('CENTER_BINDING_UNVERIFIED');
        else refs.push({recordId: row._id, campaignId: item.issuance.campaignId, owner, awardId, ...(couponId ? {couponId} : {})});
      }
      return item;
    });
    if (refs.length) {
      const priorIssuance = new Map(items.map(item=>[item.recordId,{...item.issuance}]));
      try {
        const result = await center.recordStatuses(refs);
        if (result.centerId !== center.centerId || result.environment !== center.environment || !Array.isArray(result.items) || result.items.length !== refs.length || !time(result.checkedAt)) throw new Error('Invalid center status response');
        for (let index = 0; index < refs.length; index++) {
          const ref = refs[index], status = result.items[index], item = items.find(item => item.recordId === ref.recordId);
          if (status.recordId !== ref.recordId || !['not_found', 'verified', 'mismatch'].includes(status.result)) throw new Error('Invalid center binding result');
          if (status.result !== 'verified') { warnings.add(status.result === 'mismatch' ? 'CENTER_BINDING_UNVERIFIED' : 'ISSUANCE_NOT_CONFIRMED'); continue; }
          if (!['AVAILABLE', 'RESERVED', 'PAYMENT_PENDING', 'REDEEMED', 'VOID', 'EXPIRED'].includes(status.state) || !safeText(status.couponId) || ref.couponId && ref.couponId !== status.couponId || status.state === 'REDEEMED' && !time(status.redeemedAt)) throw new Error('Invalid center coupon state');
          item.issuance = {...item.issuance, status: 'issued', couponId: status.couponId};
          item.redemption = {status: status.state, source: 'coupon_center', redeemedAt: time(status.redeemedAt), checkedAt: result.checkedAt};
        }
      } catch {
        warnings.add('CENTER_STATUS_UNAVAILABLE');
        // Do not retain partially verified statuses when a malformed batch response is received.
        for (const item of items) if (refs.some(ref => ref.recordId === item.recordId)) {item.issuance=priorIssuance.get(item.recordId);item.redemption = {status: 'unknown', source: 'unverified', redeemedAt: null, checkedAt: null};}
      }
    }
    const hasMore = page.rows.length > limit;
    const encoded = hasMore ? Buffer.from(JSON.stringify({v: 1, scope, after: selected.at(-1)._id})).toString('base64url') : null;
    return {service: 'lottery-records', version: 1, campaignId, items, limit, total: page.total, hasMore, nextCursor: encoded ? encoded + '.' + signature(encoded) : null, queriedAt: now(), order: 'record_id_asc', warnings: [...warnings]};
  };
}

function createCloudRecordsReader(db, collection) {
  return async ({campaignId, mode, limit, after, outcome, participantRef}) => {
    const filters = {campaignId};
    if (participantRef) filters._id = participantRef;
    if (outcome !== 'all') {
      if (mode === 'scarf' || outcome === 'lost') filters.outcome = outcome;
      else filters['prize.kind'] = db.command.in(['cash', 'physical']);
    }
    if (participantRef && after >= participantRef) return {rows: [], total: (await db.collection(collection).where(filters).count()).total};
    const where = after && !participantRef ? {...filters, _id: db.command.gt(after)} : filters;
    const result = await db.collection(collection).where(where).orderBy('_id', 'asc').limit(limit + 1).get();
    // Draws are append-only. Count after reading the page so a concurrent new draw
    // cannot make a valid page appear larger than its reported total.
    const totalResult = await db.collection(collection).where(filters).count();
    return {rows: result.data, total: totalResult.total};
  };
}
module.exports = {createDrawRecords, createCloudRecordsReader};
