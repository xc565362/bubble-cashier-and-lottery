(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LotteryDomain = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function fault(code, message) { const error = new Error(message); error.code = code; return error; }
  function selectPrize(prizes, ticket) {
    if (!Array.isArray(prizes) || !prizes.length ||
        prizes.some(p => !Number.isInteger(p.probability) || p.probability <= 0) ||
        prizes.reduce((sum, p) => sum + p.probability, 0) !== 100 ||
        new Set(prizes.map(p => p.id)).size !== prizes.length) {
      throw fault('INVALID_CONFIG', '奖项概率配置错误，请联系工作人员');
    }
    if (!Number.isInteger(ticket) || ticket < 0 || ticket >= 100) throw fault('INVALID_RANDOM', '抽奖随机数异常');
    let end = 0;
    for (const prize of prizes) { end += prize.probability; if (ticket < end) return { ...prize }; }
  }
  function normalizeCode(raw) {
    const code = String(raw || '').trim().replace(/^bubble:/i, '').replace(/[\s-]/g, '').toUpperCase();
    if (!/^(?:[0-9A-F]{16}|LJC1_[0-9A-F]{32})$/.test(code)) throw fault('INVALID_CODE', '请输入完整的奖品核销码或 LJC1_ 开头的购物券码');
    return code;
  }
  // Keep issued entitlement expiry immutable; the campaign can close redemption earlier.
  function redemptionDeadline(campaign) {
    if (campaign.redemptionEndsAt != null && (!Number.isSafeInteger(campaign.redemptionEndsAt) || campaign.redemptionEndsAt <= 0)) throw fault('INVALID_CONFIG', '兑奖截止配置不正确');
    return campaign.redemptionEndsAt == null ? campaign.redeemEndsAt || null : Math.min(campaign.redemptionEndsAt, campaign.redeemEndsAt || Infinity);
  }
  function publicEntry(entry, now, campaign, coupon) {
    if (!entry) return null;
    const {centerCampaignId,product,...prize}=entry.prize;
    if (entry.cashCenter) return {prize,code:'',createdAt:entry.createdAt,status:entry.status==='redeemed'?'redeemed':'issuing',checkoutCoupon:true,
      expiresAt:Math.min(entry.cashCenter.expiresAt,redemptionDeadline(campaign)||Infinity),minimumGoodsAmountCents:entry.cashCenter.minimumCents,redeemedAt:entry.redeemedAt||null};
    let status = entry.status === 'redeemed' ? 'redeemed' :
      (redemptionDeadline(campaign) && now >= redemptionDeadline(campaign) ? 'expired' : 'pending');
    if (entry.couponId) {
      if (!coupon) throw fault('COUPON_UNAVAILABLE', '购物券状态暂不可用，请稍后刷新');
      status = coupon.status === 'REDEEMED' ? 'redeemed' : coupon.status === 'VOIDED' ? 'voided' :
        coupon.status === 'PAYMENT_PENDING' ? 'using' :
        now >= Math.min(coupon.expiresAt, redemptionDeadline(campaign) || Infinity) || coupon.status === 'EXPIRED' ? 'expired' :
        coupon.status === 'RESERVED' && now < coupon.reservedUntil ? 'using' : 'pending';
    }
    return {
      prize, code: entry.code, createdAt: entry.createdAt,
      status, checkoutCoupon: !!entry.couponId,
      expiresAt: coupon ? Math.min(coupon.expiresAt, redemptionDeadline(campaign) || Infinity) : redemptionDeadline(campaign),
      minimumGoodsAmountCents: coupon ? coupon.rules && coupon.rules.minimumGoodsAmountCents || 0 : null,
      redeemedAt: (coupon && coupon.redeemedAt) || entry.redeemedAt || null
    };
  }
  function assertDrawing(campaign, now) {
    if (!campaign.enabled) throw fault('PAUSED', '活动暂未开放，请留意现场通知');
    if (campaign.startsAt && now < campaign.startsAt) throw fault('NOT_STARTED', '活动尚未开始');
    if (campaign.endsAt && now >= campaign.endsAt) throw fault('ENDED', '抽奖已结束，已中奖礼品仍可在有效期内领取');
  }
  return { fault, selectPrize, normalizeCode, publicEntry, assertDrawing, redemptionDeadline };
});
