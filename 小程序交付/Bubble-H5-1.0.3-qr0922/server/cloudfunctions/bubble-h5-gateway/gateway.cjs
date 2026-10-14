'use strict';
const crypto = require('node:crypto');
const SOURCE_APP_ID = 'wx3cfec968f30fb6c1';
const ALLOWED_ACTIONS = new Set(['state', 'draw', 'identity', 'lookup', 'redeem', 'activityCode']);
const BUSINESS_ERRORS = new Set(['UNAUTHENTICATED', 'FORBIDDEN', 'INVALID_CODE', 'NOT_FOUND', 'PAUSED', 'NOT_STARTED', 'ENDED', 'EXPIRED', 'RETRY', 'INVALID_ACTION', 'INVALID_CONFIG', 'INVALID_RANDOM', 'CODE_NOT_READY', 'CHECKOUT_REQUIRED', 'POS_REQUIRED', 'POS_NOT_READY', 'COUPON_UNAVAILABLE', 'SOLD_OUT', 'POOL_ACTIVE', 'POOL_NOT_READY', 'POOL_CORRUPT', 'POOL_CONFIG_MISMATCH', 'FIXED_STOCK_EMPTY']);
const fault = (code, message, status = 400) => Object.assign(new Error(message), {code, status, gatewayFault: true});
const isRecord = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const onlyKeys = (value, keys) => isRecord(value) && Object.keys(value).every(key => keys.includes(key));
const validOpenId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{10,128}$/.test(value);

function readConfig(env = process.env) {
  const loginMode = env.H5_LOGIN_MODE || 'code2session';
  if (!['code2session', 'cloud-ticket'].includes(loginMode)) throw fault('INVALID_CONFIG', 'H5 登录模式尚未配置', 503);
  const origins = (env.H5_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!origins.length || origins.some(origin => {
    try { const u = new URL(origin); return u.protocol !== 'https:' || u.origin !== origin || u.username || u.password; } catch { return true; }
  })) throw fault('INVALID_CONFIG', 'H5 正式域名尚未配置', 503);
  if (env.H5_APP_ID !== SOURCE_APP_ID || (loginMode === 'code2session' && !/^[A-Za-z0-9]{16,128}$/.test(env.H5_APP_SECRET || '')) || !/^[a-fA-F0-9]{64}$/.test(env.H5_TOKEN_SECRET || '') || (loginMode === 'cloud-ticket' && !origins.includes(env.H5_TICKET_ORIGIN))) {
    throw fault('INVALID_CONFIG', 'H5 登录服务尚未配置', 503);
  }
  const basePath = (env.H5_API_BASE_PATH || '/api/bubble-h5').replace(/\/$/, '');
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(basePath)) throw fault('INVALID_CONFIG', 'H5 接口路径尚未配置', 503);
  return {enabled: env.H5_GATEWAY_ENABLED === '1' && env.H5_BACKEND_REVIEWED === '1', appId: env.H5_APP_ID,
    loginMode, ticketOrigin: env.H5_TICKET_ORIGIN, appSecret: env.H5_APP_SECRET, tokenSecret: env.H5_TOKEN_SECRET, origins, basePath, sessionTtlMs: 15 * 60 * 1000};
}

function createSessionCodec({appId, tokenSecret, sessionTtlMs = 15 * 60 * 1000}, now = Date.now) {
  if (!/^wx[0-9a-f]{16}$/.test(appId || '') || !/^[0-9a-fA-F]{64}$/.test(tokenSecret || '') || !Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 60000 || sessionTtlMs > 30 * 60 * 1000) {
    throw fault('INVALID_CONFIG', 'H5 登录服务尚未配置', 503);
  }
  const key = Buffer.from(tokenSecret, 'hex');
  const sign = value => crypto.createHmac('sha256', key).update(value).digest('base64url');
  return {
    issue(openId, origin) {
      if (!validOpenId(openId)) throw fault('LOGIN_FAILED', '微信登录未完成，请返回小程序重新进入', 401);
      const issuedAt = now(), expiresAt = issuedAt + sessionTtlMs;
      const payload = Buffer.from(JSON.stringify({sub: openId, appId, origin, issuedAt, expiresAt, nonce: crypto.randomBytes(16).toString('hex')})).toString('base64url');
      return {token: 'B1.' + payload + '.' + sign('B1.' + payload), expiresAt};
    },
    verify(token, origin) {
      if (typeof token !== 'string' || token.length > 2048) throw fault('UNAUTHENTICATED', '请从小程序活动入口重新进入', 401);
      const parts = token.split('.');
      if (parts.length !== 3 || parts[0] !== 'B1' || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) throw fault('UNAUTHENTICATED', '登录信息无效，请重新进入', 401);
      const expected = Buffer.from(sign(parts[0] + '.' + parts[1]));
      const supplied = Buffer.from(parts[2]);
      if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) throw fault('UNAUTHENTICATED', '登录信息无效，请重新进入', 401);
      let claims;
      try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { throw fault('UNAUTHENTICATED', '登录信息无效，请重新进入', 401); }
      if (!isRecord(claims) || claims.appId !== appId || claims.origin !== origin || !validOpenId(claims.sub) || !Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= claims.issuedAt || claims.expiresAt - claims.issuedAt > sessionTtlMs || claims.issuedAt > now() + 5000) throw fault('UNAUTHENTICATED', '登录信息无效，请重新进入', 401);
      if (claims.expiresAt <= now()) throw fault('SESSION_EXPIRED', '登录已过期，请返回小程序重新进入活动', 401);
      return claims.sub;
    }
  };
}

function createCodeExchange({appId, appSecret}, fetchFn = globalThis.fetch) {
  return async function exchange(code) {
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.search = new URLSearchParams({appid: appId, secret: appSecret, js_code: code, grant_type: 'authorization_code'}).toString();
    // Never log this URL, the provider response, session_key, or the incoming code.
    try {
      const response = await fetchFn(url, {method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000)});
      const body = await response.json();
      if (!response.ok || !body || body.errcode || !validOpenId(body.openid)) throw new Error('Login rejected');
      return body.openid;
    } catch { throw fault('LOGIN_FAILED', '微信登录未完成，请返回小程序重新进入', 401); }
  };
}

function createGateway({config, exchangeCode, callLottery, consumeRate, consumeCode, consumeTicket, now = Date.now}) {
  const sessions = createSessionCodec(config, now);
  if (typeof consumeRate !== 'function') throw fault('INVALID_CONFIG', 'H5 限频服务尚未配置', 503);
  const ticketMode = config.loginMode === 'cloud-ticket';
  if (typeof (ticketMode ? consumeTicket : consumeCode) !== 'function') throw fault('INVALID_CONFIG', 'H5 登录重放保护尚未配置', 503);
  const originSet = new Set(config.origins);
  function respond(statusCode, data, origin) {
    const headers = {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff'};
    if (originSet.has(origin)) Object.assign(headers, {'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '300'});
    return {statusCode, headers, body: statusCode === 204 ? '' : JSON.stringify(data), isBase64Encoded: false};
  }
  return async function gateway(event = {}) {
    let origin;
    try {
      const headers = {};
      for (const [key, value] of Object.entries(event.headers || {})) {
        if (typeof value !== 'string' || Object.hasOwn(headers, key.toLowerCase())) throw fault('INVALID_REQUEST', '请求头无效');
        headers[key.toLowerCase()] = value;
      }
      origin = headers.origin;
      if (!originSet.has(origin)) throw fault('ORIGIN_FORBIDDEN', '请从小程序活动入口打开', 403);
      if (!config.enabled) throw fault('SERVICE_NOT_CONFIGURED', '活动网页尚未接通正式服务，请联系工作人员', 503);
      const path = event.path;
      const method = event.httpMethod;
      if (![config.basePath + '/session', config.basePath + '/call'].includes(path)) throw fault('NOT_FOUND', '接口不存在', 404);
      if (method === 'OPTIONS') return respond(204, null, origin);
      if (method !== 'POST') throw fault('METHOD_NOT_ALLOWED', '请使用 POST 请求', 405);
      if (!/^application\/json(?:\s*;|$)/i.test(headers['content-type'] || '')) throw fault('INVALID_REQUEST', '请求必须使用 JSON');
      if (typeof event.body !== 'string' || event.body.length > 12000) throw fault('INVALID_REQUEST', '请求内容过大或格式无效');
      const text = event.isBase64Encoded === true ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
      if (Buffer.byteLength(text, 'utf8') > 8192) throw fault('INVALID_REQUEST', '请求内容过大');
      let body;
      try { body = JSON.parse(text); } catch { throw fault('INVALID_REQUEST', '请求内容不是有效 JSON'); }
      if (path.endsWith('/session')) {
        const field = ticketMode ? 'ticket' : 'code';
        if (!onlyKeys(body, [field]) || typeof body[field] !== 'string' || !(ticketMode ? /^HT1\.[A-Za-z0-9_-]{43}$/ : /^[A-Za-z0-9_-]{8,256}$/).test(body[field])) throw fault('INVALID_REQUEST', '请使用有效的微信登录凭证');
        await consumeRate('login-global', 'all', 120, 60000);
        await consumeRate('login-code', body[field], 6, 60000);
        let openId;
        if (ticketMode) openId = await consumeTicket(body.ticket, origin);
        else { await consumeCode(body.code); openId = await exchangeCode(body.code); }
        return respond(200, {ok: true, data: sessions.issue(openId, origin)}, origin);
      }
      const authorization = headers.authorization || '';
      if (!authorization.startsWith('Bearer ')) throw fault('UNAUTHENTICATED', '请从小程序活动入口重新进入', 401);
      const openId = sessions.verify(authorization.slice(7), origin);
      if (!onlyKeys(body, ['action', 'payload']) || !ALLOWED_ACTIONS.has(body.action)) throw fault('INVALID_ACTION', '此网页不支持该操作');
      const payload = body.payload === undefined ? {} : body.payload;
      const allowedKeys = ['lookup', 'redeem'].includes(body.action) ? ['code'] : [];
      if (!onlyKeys(payload, allowedKeys) || (allowedKeys.length && (typeof payload.code !== 'string' || payload.code.length > 200))) throw fault('INVALID_REQUEST', '请求参数无效');
      await consumeRate('user', openId, 120, 60000);
      if (['draw', 'redeem', 'activityCode'].includes(body.action)) await consumeRate(body.action, openId, body.action === 'activityCode' ? 5 : 15, 60000);
      const data = await callLottery(body.action, payload, openId);
      return respond(200, {ok: true, data}, origin);
    } catch (error) {
      if (error.gatewayFault) return respond(error.status || 400, {ok: false, code: error.code, message: error.message}, origin);
      if (BUSINESS_ERRORS.has(error.code)) return respond(error.code === 'FORBIDDEN' ? 403 : error.code === 'UNAUTHENTICATED' ? 401 : 400, {ok: false, code: error.code, message: error.message}, origin);
      return respond(503, {ok: false, code: 'SERVICE_UNAVAILABLE', message: '活动服务暂不可用，请稍后重试；已中奖结果会为你保留'}, origin);
    }
  };
}

function createCloudRateLimiter(db, now = Date.now) {
  return async (scope, subject, limit, windowMs) => {
    const windowStart = Math.floor(now() / windowMs) * windowMs;
    const id = crypto.createHash('sha256').update(JSON.stringify([scope, subject, windowStart])).digest('hex');
    const allowed = await db.runTransaction(async tx => {
      let previous;
      try {
        const value = await tx.collection('lottery_h5_rates').doc(id).get();
        const row = Array.isArray(value.data) ? value.data[0] : value.data;
        previous = row && Object.keys(row).length ? row : null;
      }
      catch (error) { if (!/document(?:\s|\S)*?(?:does not exist|not exist|not found)/i.test(String(error.errMsg || error.message || ''))) throw error; }
      const count = previous ? previous.count : 0;
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid rate state');
      if (count >= limit) return false;
      await tx.collection('lottery_h5_rates').doc(id).set({data: {count: count + 1, expiresAt: new Date(windowStart + windowMs * 2)}});
      return true;
    });
    if (!allowed) throw fault('RATE_LIMITED', '操作较频繁，请稍后重试', 429);
  };
}

module.exports = {SOURCE_APP_ID, readConfig, createSessionCodec, createCodeExchange, createGateway, createCloudRateLimiter};
