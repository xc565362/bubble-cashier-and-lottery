const crypto = require('node:crypto');

// Server-only client. Owner and award must come from authenticated server records.
function createLotteryClient({ baseUrl, token, campaignId, fetchFn = fetch }) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Use the coupon service HTTPS origin');
  if (!token || !campaignId) throw new Error('Missing coupon backend credentials');
  async function call(method, route, input) {
    const url = new URL(route, base);
    if (method === 'GET') for (const [key, value] of Object.entries(input)) url.searchParams.set(key, value);
    const res = await fetchFn(url, { method, redirect: 'error', signal: AbortSignal.timeout(12000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify(input) } : {}) });
    const body = await res.json();
    if (!res.ok || !body.ok) throw Object.assign(new Error(body.error || 'Coupon service unavailable'), { code: body.code });
    return body.data;
  }
  return {
    issueForVerifiedAward({ owner, awardId, trustedCode }) {
      const requestId = `award:${crypto.createHash('sha256').update(JSON.stringify([campaignId, owner, awardId])).digest('hex')}`;
      return call('POST', '/v1/coupons/issue', { campaignId, owner, awardId, requestId, ...(trustedCode?{trustedCode}:{}) });
    },
    listForAuthenticatedOwner(owner, page = 1) { return call('GET', '/v1/coupons', { owner, campaignId, page }); },
    detailForAuthenticatedOwner(owner, id) { return call('POST', '/v1/coupons/detail', { owner, id }); },
  };
}
module.exports = { createLotteryClient };
