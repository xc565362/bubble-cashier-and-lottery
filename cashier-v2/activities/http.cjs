'use strict';
// Public participant HTTP surface for folded-in activities, rooted at
// /activity/:uuid/ on the online cashier server. Bearer participant tokens (no
// cookies) so no CSRF exposure; permissive CORS lets the H5 be hosted anywhere.
// Per-IP minute-bucket rate limiting follows coupons/http.cjs.
const { problem } = require('../coupons/store.cjs');

const BODY_LIMIT = 16 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(problem('BODY_TOO_LARGE', '请求体过大', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw problem('INVALID_JSON', '请求格式错误', 400);
  }
}

function createActivityHttp({ store, now = Date.now, rateLimit = 300, sessionRateLimit = 60, log = console.error } = {}) {
  if (![rateLimit, sessionRateLimit].every(value => Number.isSafeInteger(value) && value > 0 && value <= 1000000)) {
    throw new Error('活动接口每分钟请求上限须为 1 至 1000000 的整数');
  }
  const requests = new Map();
  function consume(bucket, minute, limit) {
    const entry = requests.get(bucket) || { minute, count: 0 };
    entry.count = Math.min(entry.count + 1, limit + 1);
    requests.set(bucket, entry);
    if (entry.count > limit) throw problem('RATE_LIMIT', '请求过于频繁，请稍后重试', 429);
  }
  function send(res, status, data) {
    res.statusCode = status;
    res.end(JSON.stringify(data));
  }
  return async function handlePublic(req, res, activityId, sub, ip) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Staff-Key');
        res.setHeader('Access-Control-Max-Age', '600');
        res.statusCode = 204;
        res.end();
        return;
      }
      const minute = Math.floor(now() / 60000);
      for (const [key, entry] of requests) if (entry.minute !== minute) requests.delete(key);
      consume(`activity:${ip}:${minute}`, minute, rateLimit);
      if (req.method !== 'POST') throw problem('METHOD', '不支持此请求方式', 405);
      if (sub === '/session') {
        consume(`activity-session:${ip}:${minute}`, minute, sessionRateLimit);
        const body = await readJson(req);
        if (body && typeof body.ticket === 'string') throw problem('UNSUPPORTED_CREDENTIAL', '请使用微信扫码进入活动', 400);
        if (!body || typeof body.code !== 'string' || body.code.length < 1 || body.code.length > 256) {
          throw problem('INVALID_CREDENTIAL', '登录凭证无效，请返回小程序重新进入', 400);
        }
        return send(res, 200, { ok: true, data: await store.session(activityId, body.code) });
      }
      if (sub === '/call') {
        const body = await readJson(req);
        const action = typeof body.action === 'string' ? body.action : '';
        const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : {};
        const token = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1] || '';
        const staffKey = req.headers['x-staff-key'];
        const data = await store.publicCall(activityId, action, payload, { token, staffKey: typeof staffKey === 'string' ? staffKey : '' });
        return send(res, 200, { ok: true, data });
      }
      throw problem('NOT_FOUND', '接口不存在', 404);
    } catch (error) {
      const known = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600
        && typeof error.code === 'string' && /^[A-Z_]{2,60}$/.test(error.code);
      if (!known) log('activity request failed:', error);
      // Error envelope: {ok:false, code, message, error} (lottery-v2 contract).
      send(res, known ? error.status : 500, { ok: false, code: known ? error.code : 'INTERNAL',
        message: known ? error.message : '服务暂不可用，请稍后重试', error: known ? error.message : '服务暂不可用，请稍后重试' });
    }
  };
}

module.exports = { createActivityHttp };
