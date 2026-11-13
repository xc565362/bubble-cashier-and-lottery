'use strict';
// Activity config validation, ported from lottery-v2/src/config.js. The folded-in
// version drops `id` (the pos_activities row id) and `active` (the row's state
// column owns it) and adds the wx mini-program credentials and booth staff key.
const { problem } = require('../coupons/store.cjs');

const PRIZE_KINDS = ['cash', 'physical', 'none'];
const STATES = ['draft', 'active', 'paused', 'ended'];
const INVALID = message => problem('INVALID_CONFIG', message);

function parseTime(value, field) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  throw INVALID(`配置项 ${field} 不是有效时间`);
}

// Prize imageUrl: optional, long data-URLs allowed, scheme-restricted.
function validatePrizeImage(value, where) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 200000) throw INVALID(`${where}.imageUrl 须为不超过 200000 字符的字符串`);
  if (!/^(https?:\/\/|data:image\/)/.test(value)) throw INVALID(`${where}.imageUrl 须以 http://、https:// 或 data:image/ 开头`);
  return value;
}

// Pool-based prize definition. Cash prizes REFERENCE an existing coupon-center
// campaign (couponCampaignId) and physical prizes REFERENCE a gift product from
// the ledger product pool (product.id); the server snapshots name/amount/etc.
// from the pool at save time, so clients cannot define terms freely. Cash
// amount is rejected outright — the campaign decides it.
function validatePrizes(raw) {
  if (!Array.isArray(raw) || !raw.length) throw INVALID('活动配置缺少 prizes');
  const seen = new Set();
  return raw.map((p, i) => {
    const where = `prizes[${i}]`;
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw INVALID(`${where} 格式错误`);
    if (typeof p.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(p.id)) throw INVALID(`${where}.id 格式错误`);
    if (seen.has(p.id)) throw INVALID(`奖品 id 重复：${p.id}`);
    seen.add(p.id);
    const kind = PRIZE_KINDS.includes(p.kind) ? p.kind : null;
    if (!kind) throw INVALID(`${where}.kind 必须为 cash 或 physical`);
    if (!Number.isSafeInteger(p.qty) || p.qty < 1) throw INVALID(`${where}.qty 必须为正整数`);
    if (typeof p.probability !== 'number' || !Number.isFinite(p.probability) || p.probability <= 0) throw INVALID(`${where}.probability 必须为正数`);
    const imageUrl = validatePrizeImage(p.imageUrl, where);
    const prize = {
      id: p.id, kind, qty: p.qty, probability: p.probability,
      label: typeof p.label === 'string' ? p.label : '', icon: typeof p.icon === 'string' ? p.icon : '',
      ...(imageUrl ? { imageUrl } : {}),
    };
    if (kind === 'cash') {
      if (p.amount !== undefined && p.amount !== null) throw INVALID('现金券须从券池选择，面额由所选券活动决定');
      if (typeof p.couponCampaignId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(p.couponCampaignId)) throw INVALID('现金券须从券池选择：请提供 couponCampaignId');
      prize.couponCampaignId = p.couponCampaignId;
    } else if (kind === 'physical') {
      if (!p.product || typeof p.product !== 'object' || Array.isArray(p.product)) throw INVALID('实物奖品须从赠品池选择：请提供 product.id');
      if (typeof p.product.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(p.product.id)) throw INVALID(`${where}.product.id 格式错误`);
      prize.product = { id: p.product.id };
    } // kind 'none' is the "thanks" cell: no pool reference, nothing else to validate.
    return prize;
  });
}

// Editable lottery config. Dates may be ISO strings or millisecond timestamps
// and are normalized to milliseconds, exactly like lottery-v2.
function validateActivityConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw INVALID('活动配置格式错误');
  if (typeof raw.name !== 'string' || !raw.name.trim()) throw INVALID('活动配置缺少 name');
  const startsAt = parseTime(raw.startsAt, 'startsAt');
  const endsAt = parseTime(raw.endsAt, 'endsAt');
  if (endsAt <= startsAt) throw INVALID('活动结束时间必须晚于开始时间');
  const redeemEndsAt = raw.redeemEndsAt == null ? endsAt : parseTime(raw.redeemEndsAt, 'redeemEndsAt');
  return {
    name: raw.name,
    title: typeof raw.title === 'string' ? raw.title : raw.name,
    venue: typeof raw.venue === 'string' ? raw.venue : '',
    cashTerms: typeof raw.cashTerms === 'string' ? raw.cashTerms : '',
    rulesText: typeof raw.rulesText === 'string' ? raw.rulesText : '',
    startsAt, endsAt, redeemEndsAt, prizes: validatePrizes(raw.prizes),
    // Gated draws (booth staff confirms participation, then issues a one-time
    // invite code): the H5 collects the code and draw() consumes it atomically.
    requireInvite: raw.requireInvite === true,
  };
}

// wx credentials are optional: an activity without a secret runs code2session
// in mock mode (same convention as lottery-v2's WX_MOCK). The secret is write-
// only; reads return appid + secretSet.
function validateWx(raw) {
  if (raw == null) return { appid: '', secret: '' };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw INVALID('wx 配置格式错误');
  const appid = typeof raw.appid === 'string' ? raw.appid.trim() : '';
  if (appid && !/^[A-Za-z0-9_-]{1,64}$/.test(appid)) throw INVALID('wx.appid 格式错误');
  let secret = '';
  if (raw.secret !== undefined && raw.secret !== null && raw.secret !== '') {
    if (typeof raw.secret !== 'string' || raw.secret.length > 128 || /[\u0000-\u001f]/.test(raw.secret)) throw INVALID('wx.secret 格式错误');
    secret = raw.secret;
  }
  if (secret && !appid) throw INVALID('配置 wx.secret 前请先填写 wx.appid');
  return { appid, secret };
}

function validateStaffKey(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f]/.test(value)) throw INVALID('工作人员密钥格式不正确');
  return value;
}

function validateState(value) {
  if (!STATES.includes(value)) throw problem('INVALID_STATE', '活动状态不正确');
  return value;
}

module.exports = { validateActivityConfig, validateWx, validateStaffKey, validateState, STATES };
