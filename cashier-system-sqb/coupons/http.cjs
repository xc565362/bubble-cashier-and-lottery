const crypto = require('node:crypto');
const { problem } = require('./store.cjs');

const routes = {
  'GET /v1/info': 'info', 'GET /v1/campaigns': 'campaigns', 'POST /v1/campaigns': 'create-campaign',
  'POST /v1/campaigns/status': 'set-campaign', 'GET /v1/coupons': 'coupons', 'POST /v1/coupons/issue': 'issue',
  'POST /v1/campaigns/quota': 'increase-quota',
  'POST /v1/campaigns/deadline': 'set-deadline',
  'POST /v1/campaigns/lottery-provision': 'lottery-provision',
  'POST /v1/lottery/issue': 'lottery-issue',
  'POST /v1/lottery/coupons/detail': 'lottery-coupon',
  'POST /v1/lottery/records/status': 'lottery-record-status',
  'POST /v1/coupons/detail': 'coupon', 'POST /v1/coupons/void': 'void', 'GET /v1/keys': 'keys',
  'POST /v1/keys': 'create-key', 'POST /v1/keys/revoke': 'revoke-key', 'GET /v1/events': 'events',
  'POST /v1/reservations': 'reserve', 'POST /v1/reservations/detail': 'reservation',
  'POST /v1/reservations/prepare': 'prepare', 'POST /v1/reservations/commit': 'commit', 'POST /v1/reservations/release': 'release',
};
const endpoints = Object.fromEntries(Object.entries(routes).map(([route, action]) => [action, route.split(' ')]));
function couponHttp(store, { adminToken, rateLimit = 180, catalogAggregateRateLimit = 6000, now = Date.now } = {}) {
  if (typeof adminToken !== 'string' || adminToken.length < 32) throw new Error('券服务管理密钥至少需要 32 个字符');
  if (![rateLimit, catalogAggregateRateLimit].every(value => Number.isSafeInteger(value) && value > 0 && value <= 1000000)) throw new Error('券服务每分钟请求上限须为 1 至 1000000 的整数');
  const adminHash = crypto.createHash('sha256').update(adminToken).digest();
  const requests = new Map();
  function consume(bucket, minute, limit) {
    const entry = requests.get(bucket) || { minute, count: 0 };
    entry.count = Math.min(entry.count + 1, limit + 1); requests.set(bucket, entry);
    if (entry.count > limit) throw problem('RATE_LIMIT', '请求过于频繁，请稍后重试', 429);
  }
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/healthz') { res.end(JSON.stringify({ ok: true, service: 'stall-coupon-center', apiVersion: 1 })); return; }
      const action = routes[`${req.method} ${url.pathname}`];
      if (!action) throw problem('NOT_FOUND', '接口不存在', 404);
      if (req.headers.origin) throw problem('SERVER_ONLY', '此接口仅供后台调用，不能从小程序页面或浏览器直接携带密钥访问', 403);
      const token = /^Bearer ([A-Za-z0-9_.-]{32,300})$/.exec(req.headers.authorization || '')?.[1];
      if (!token) throw problem('UNAUTHORIZED', '缺少有效的接口凭证', 401);
      const hash = crypto.createHash('sha256').update(token).digest();
      const actor = crypto.timingSafeEqual(hash, adminHash) ? { id: 'administrator', role: 'admin' } : await store.authenticate(token);
      let input = Object.fromEntries(url.searchParams);
      if (input.page) input.page = Number(input.page);
      if (req.method === 'POST') {
        if (!String(req.headers['content-type']).startsWith('application/json')) throw problem('INVALID_CONTENT_TYPE', '需要 JSON 请求', 415);
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 32768) throw problem('TOO_LARGE', '请求过大', 413); chunks.push(chunk); }
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw problem('INVALID_JSON', 'JSON 格式不正确'); }
        if (!input || Array.isArray(input) || typeof input !== 'object') throw problem('INVALID_JSON', '请求必须是 JSON 对象');
      }
      const minute = Math.floor(now() / 60000);
      for (const [key, entry] of requests) if (entry.minute !== minute) requests.delete(key);
      if (actor.role === 'admin' && ['lottery-issue', 'lottery-coupon'].includes(action)) {
        // Aggregate first: malformed or constantly changing owners cannot evade the service bound.
        // Keep winner polling separate from the original administrator management allowance.
        consume(`catalog:${minute}`, minute, catalogAggregateRateLimit);
        if (typeof input.owner !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(input.owner)) throw problem('INVALID_INPUT', '领取人标识须为 1 至 120 位字母、数字或安全分隔符');
        const owner = crypto.createHash('sha256').update(input.owner).digest('hex');
        consume(`catalog-owner:${minute}:${owner}`, minute, 60);
      } else consume(`actor:${actor.id}:${minute}`, minute, rateLimit);
      const data = await store.dispatch(actor, action, input);
      res.end(JSON.stringify({ ok: true, data }));
    } catch (error) {
      res.statusCode = error.status || 500;
      res.end(JSON.stringify({ ok: false, code: error.status ? error.code : 'REQUEST_FAILED', error: error.status ? error.message : '券服务请求失败，请核对输入或联系管理员' }));
    }
  };
}
module.exports = { couponHttp, endpoints };
