'use strict';
const crypto = require('node:crypto');

// A code is claimed before contacting WeChat. Lost responses require a fresh
// wx.login code; neither another instance nor a minute boundary permits reuse.
function createCloudCodeGuard(db, {collection, appId, now = Date.now}) {
  if (typeof db?.runTransaction !== 'function' || !collection || !appId) throw new Error('Login replay storage unavailable');
  return async code => {
    const id = crypto.createHash('sha256').update(JSON.stringify(['login-code-once', appId, code])).digest('hex');
    const at = now();
    const accepted = await db.runTransaction(async tx => {
      const doc = tx.collection(collection).doc(id);
      let row;
      try { const result = await doc.get(); row = Array.isArray(result.data) ? result.data[0] : result.data; }
      catch (error) { if (!/document(?:\s|\S)*?(?:does not exist|not exist|not found)/i.test(String(error.errMsg || error.message || ''))) throw error; }
      if (row && Object.keys(row).length) {
        if (!Number.isSafeInteger(row.usedUntil)) throw new Error('Invalid login replay state');
        if (row.usedUntil > at) return false;
      }
      await doc.set({data: {usedUntil: at + 10 * 60 * 1000, expiresAt: new Date(at + 20 * 60 * 1000)}});
      return true;
    });
    if (!accepted) throw Object.assign(new Error('登录凭证已使用，请返回小程序重新进入'), {code: 'LOGIN_REUSED', status: 401, gatewayFault: true});
  };
}

// Health needs no SDK. Readiness additionally probes a fixed storage sentinel;
// neither response exposes secrets, inventory, identities or real-login claims.
async function healthResponse(event, env, {readConfig, defaultBasePath, service, extraChecks = {}, checkStorage}) {
  const configuredPath = String(env.H5_API_BASE_PATH || defaultBasePath).replace(/\/$/, '');
  const basePath = /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(configuredPath) ? configuredPath : defaultBasePath;
  if (![basePath + '/health', basePath + '/readiness'].includes(event?.path)) return null;
  const headers = {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*'};
  if (event.httpMethod !== 'GET') return {statusCode: 405, headers: {...headers, Allow: 'GET'}, body: JSON.stringify({ok: false, code: 'METHOD_NOT_ALLOWED'})};
  let configured = false;
  try { readConfig(env); configured = true; } catch {}
  const checks = {loginConfiguration: configured, gatewayEnabled: env.H5_GATEWAY_ENABLED === '1', backendReviewed: env.H5_BACKEND_REVIEWED === '1', ...extraChecks};
  const probe = event.path.endsWith('/readiness');
  const configurationReady = Object.values(checks).every(value => value === true);
  let storage = false;
  if (probe && configurationReady && typeof checkStorage === 'function') { try { storage = await checkStorage() === true; } catch {} }
  const ready = probe && configurationReady && storage;
  return {statusCode: probe && !ready ? 503 : 200, headers, body: JSON.stringify({ok: !probe || ready, service, version: 1, deployed: true,
    readiness: {ready, scope: probe ? 'login-configuration-and-storage' : 'configuration-only', activity: 'not-checked', checks: {...checks, storage: probe ? storage : 'not-checked'}}})};
}

const authFault = (code, message) => Object.assign(new Error(message), {code, status: 401, gatewayFault: true});
function createCloudTicketStore(db, {collection, appId, origin, audience, now = Date.now}) {
  if (!db?.runTransaction || !collection || !appId || !origin || !audience) throw new Error('Ticket storage unavailable');
  const id = ticket => crypto.createHash('sha256').update(JSON.stringify(['h5-ticket-v1', audience, appId, ticket])).digest('hex');
  const reject = () => authFault('LOGIN_FAILED', '登录凭证无效或已过期，请返回小程序重新进入');
  return {
    async issue(openId) {
      if (!/^[A-Za-z0-9_-]{10,128}$/.test(openId || '')) throw reject();
      const ticket = 'HT1.' + crypto.randomBytes(32).toString('base64url'), issuedAt = now(), expiresAt = issuedAt + 90000;
      await db.runTransaction(async tx => { await tx.collection(collection).doc(id(ticket)).set({data: {kind: 'h5-ticket-v1', audience, appId, origin, openId, issuedAt, used: false, validUntil: expiresAt, expiresAt: new Date(expiresAt + 10 * 60 * 1000)}}); });
      return {ticket, expiresAt};
    },
    async consume(ticket, requestedOrigin) {
      if (!/^HT1\.[A-Za-z0-9_-]{43}$/.test(ticket || '') || requestedOrigin !== origin) throw reject();
      return db.runTransaction(async tx => {
        const doc = tx.collection(collection).doc(id(ticket)); let row;
        try { const result = await doc.get(); row = Array.isArray(result.data) ? result.data[0] : result.data; }
        catch (error) { if (/document(?:\s|\S)*?(?:does not exist|not exist|not found)/i.test(String(error.errMsg || error.message || ''))) throw reject(); throw error; }
        if (!row || row.kind !== 'h5-ticket-v1' || row.audience !== audience || row.appId !== appId || row.origin !== origin || row.used !== false || !Number.isSafeInteger(row.issuedAt) || !Number.isSafeInteger(row.validUntil) || row.validUntil - row.issuedAt !== 90000 || row.issuedAt > now() + 5000 || row.validUntil <= now() || !/^[A-Za-z0-9_-]{10,128}$/.test(row.openId || '')) throw reject();
        // CloudBase returns _id on reads but rejects it in set/update payloads.
        const consumed = {...row, used: true};
        delete consumed._id;
        await doc.set({data: consumed});
        return row.openId;
      });
    },
  };
}
function createNativeTicketHandler({config, getWXContext, tickets, consumeRate}) {
  return async event => {
    try {
      // Older WeChat runtimes may append userInfo. Ignore it completely: only
      // the SDK's platform context can identify the caller. HTTP envelopes and
      // every other client-supplied field remain outside this native contract.
      if (!config.enabled || config.loginMode !== 'cloud-ticket' || !event || Object.getPrototypeOf(event) !== Object.prototype || !Object.hasOwn(event, 'action') || Object.keys(event).some(key => key !== 'action' && key !== 'userInfo') || event.action !== 'issueH5SessionTicket') throw authFault('LOGIN_FAILED', '请从小程序活动入口登录');
      const context = getWXContext();
      if (context?.APPID !== config.appId || !/^[A-Za-z0-9_-]{10,128}$/.test(context?.OPENID || '')) throw authFault('LOGIN_FAILED', '请从小程序活动入口登录');
      await consumeRate('native-login', context.OPENID, 12, 60000);
      return {ok: true, data: await tickets.issue(context.OPENID)};
    } catch { return {ok: false, code: 'LOGIN_FAILED', message: '登录暂未完成，请从小程序活动入口重试'}; }
  };
}
async function checkCloudStorage(db, collection) {
  try { await db.collection(collection).doc('h5-readiness-probe').get(); return true; }
  catch (error) { if (/document(?:\s|\S)*?(?:does not exist|not exist|not found)/i.test(String(error.errMsg || error.message || ''))) return true; throw error; }
}

module.exports = {createCloudCodeGuard, healthResponse, createCloudTicketStore, createNativeTicketHandler, checkCloudStorage};
