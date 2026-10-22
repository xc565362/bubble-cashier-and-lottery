import crypto from 'node:crypto';
import fs from 'node:fs';

// Coupon-center bridge: when configured, every cash-prize win is minted as a
// real coupon whose code IS the lottery entry's 16-hex code, so the winner's
// QR resolves at the cashier till (coupon-reserve). Without configuration the
// lottery behaves exactly as a standalone booth-redemption campaign.

const VERIFY_TTL = 60 * 1000;

export function validateCouponCenterUrl(raw) {
  let url;
  try { url = new URL(String(raw || '')); } catch { throw new Error('券中心地址不是有效 URL'); }
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('券中心地址必须是 HTTPS（仅本机回环地址允许 http）');
  }
  if (url.username || url.password) throw new Error('券中心地址不能包含账号或密码');
  return url.origin;
}

// Env trio (COUPON_CENTER_URL / COUPON_LOTTERY_KEY / COUPON_CAMPAIGN_ID) wins and
// grants a single coupon campaign to every cash prize whose face value matches
// (verified against the center before anything is issued). Otherwise falls back
// to the bridge file written by scripts/provision-coupons.mjs, which carries
// one grant per prize. Anything invalid disables the bridge with a loud log;
// secrets are never included in log output.
export function loadCouponBridgeConfig({ env, file, campaignId, log = console.error }) {
  if (env.COUPON_BRIDGE === 'off') return null; // explicit kill switch for dev/e2e runs
  const { COUPON_CENTER_URL: url, COUPON_LOTTERY_KEY: token, COUPON_CAMPAIGN_ID: couponCampaignId } = env;
  if (url || token || couponCampaignId) {
    if (!url || !token || !couponCampaignId) {
      log('[coupon-bridge] COUPON_CENTER_URL / COUPON_LOTTERY_KEY / COUPON_CAMPAIGN_ID 必须同时设置，券中心联动已停用');
      return null;
    }
    try {
      return { url: validateCouponCenterUrl(url), grants: [{ prizeId: null, campaignId: couponCampaignId, token }] };
    } catch (error) {
      log(`[coupon-bridge] 环境变量配置无效（${error.message}），券中心联动已停用`);
      return null;
    }
  }
  if (!file || !fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw.lotteryCampaignId && raw.lotteryCampaignId !== campaignId) {
      log(`[coupon-bridge] .coupon-bridge.json 属于活动 ${raw.lotteryCampaignId}，与当前活动 ${campaignId} 不符，券中心联动已停用`);
      return null;
    }
    const grants = Object.entries(raw.grants || {}).map(([prizeId, grant]) => ({
      prizeId,
      campaignId: String(grant?.campaignId || ''),
      token: String(grant?.token || ''),
    })).filter(grant => grant.campaignId && grant.token);
    if (!grants.length) throw new Error('缺少有效奖项授权');
    return { url: validateCouponCenterUrl(raw.url), grants };
  } catch (error) {
    log(`[coupon-bridge] .coupon-bridge.json 无效（${error.message}），券中心联动已停用`);
    return null;
  }
}

export function createCouponIssuer({ url, grants, fetchImpl = fetch, timeoutMs = 8000, log = console.error }) {
  // Entry codes whose issuance is known to have failed in this process. Lost on
  // restart by design: retryCouponIssues re-sweeps every cash entry idempotently.
  const failed = new Set();
  const verified = new Map(); // prizeId -> { fingerprint, ok, at }

  const grantFor = prizeId => grants.find(grant => grant.prizeId === prizeId) || grants.find(grant => grant.prizeId === null) || null;

  async function call(token, method, route, input) {
    let response;
    try {
      response = await fetchImpl(url + route, {
        method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
      });
    } catch (error) {
      throw Object.assign(new Error(`券中心不可达（${error.message}）`), { code: 'UNREACHABLE' });
    }
    let body;
    try { body = await response.json(); } catch { throw Object.assign(new Error('券中心响应不是 JSON'), { code: 'BAD_RESPONSE' }); }
    if (!response.ok || !body?.ok) throw Object.assign(new Error(body?.error || `券中心请求失败（HTTP ${response.status}）`), { code: body?.code });
    return body.data;
  }

  // Money guard: a grant only issues after the center confirms the coupon
  // campaign's face value and threshold match the prize config exactly.
  async function verify(grant, prize) {
    const fingerprint = `${Math.round(prize.amount * 100)}:${prize.minimumCents ?? 0}`;
    const key = `${grant.campaignId}:${prize.id}`;
    const cached = verified.get(key);
    if (cached && cached.fingerprint === fingerprint && Date.now() - cached.at < VERIFY_TTL) return cached.ok;
    let ok = false;
    try {
      const campaigns = await call(grant.token, 'GET', '/v1/campaigns');
      const campaign = (Array.isArray(campaigns) ? campaigns : []).find(item => item.id === grant.campaignId);
      ok = !!campaign && (campaign.kind ?? 'cash') === 'cash' &&
        campaign.amountCents === Math.round(prize.amount * 100) &&
        (campaign.minimumCents ?? 0) === (prize.minimumCents ?? 0);
      if (!ok) log(`[coupon-bridge] 券活动 ${grant.campaignId} 与奖项 ${prize.id} 的类型/面额/门槛不一致，已跳过该奖项发券`);
    } catch (error) {
      log(`[coupon-bridge] 无法验证券活动 ${grant.campaignId}（${error.message}），暂不为奖项 ${prize.id} 发券`);
    }
    verified.set(key, { fingerprint, ok, at: Date.now() });
    return ok;
  }

  return {
    configured: prizeId => !!grantFor(prizeId),
    isFailed: code => failed.has(code),
    pendingCount: () => failed.size,
    // Never throws: failure keeps the draw entry and is retried via the staff action.
    async issueEntry({ prize, owner, code }) {
      const grant = grantFor(prize.id);
      if (!grant) return { ok: false, error: 'no-grant' };
      try {
        if (!(await verify(grant, prize))) throw new Error('券活动未通过面额核验');
        // awardId is the entry code: UNIQUE(ns, issuer, award) plus the
        // deterministic requestId make every retry return the same coupon.
        const requestId = 'award:' + crypto.createHash('sha256').update(JSON.stringify([grant.campaignId, owner, code])).digest('hex');
        const data = await call(grant.token, 'POST', '/v1/coupons/issue', {
          campaignId: grant.campaignId, owner, awardId: code, requestId, trustedCode: code,
        });
        if (data?.code !== code) throw new Error('券中心返回的中奖码与中奖记录不一致');
        failed.delete(code);
        return { ok: true, coupon: data };
      } catch (error) {
        failed.add(code);
        log(`[coupon-issue] 发券失败 prize=${prize.id} code=${code} owner=${owner ? '***' : ''}: ${error.message}`);
        return { ok: false, error: error.message };
      }
    },
  };
}
