'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {SOURCE_APP_ID, readConfig, createGateway, createSessionCodec, createCodeExchange, createCloudRateLimiter} = require('../server/cloudfunctions/bubble-scarf-gateway/gateway.cjs');
const origin = 'https://h5.example.test';
const openId = 'oTrusted_Visitor00001';
const config = {enabled: true, appId: SOURCE_APP_ID, tokenSecret: crypto.randomBytes(32).toString('hex'), appSecret: 'testsecret'.repeat(4), origins: [origin], basePath: '/api/scarf-h5', sessionTtlMs: 60000};
const parsed = result => ({...result, json: result.body ? JSON.parse(result.body) : null});
function event(path, body, patch = {}) { return {httpMethod: 'POST', path: config.basePath + path, headers: {Origin: origin, 'Content-Type': 'application/json'}, body: JSON.stringify(body), ...patch}; }
function fixture(overrides = {}) {
  const calls = [], exchanges = [], rates = []; let time = 1800000000000;
  const handler = createGateway({config, now: () => time, exchangeCode: async code => { exchanges.push(code); return openId; }, callLottery: async (action, payload, identity) => { calls.push({action, payload, identity}); return {safe: true}; }, consumeCode: async () => {}, consumeRate: async (...args) => { rates.push(args); }, ...overrides});
  const login = async () => parsed(await handler(event('/session', {code: 'testcode123456'})));
  return {handler, calls, exchanges, rates, login, time: value => { time = value; }, request: async (action, payload = {}, token) => {
    if (token === undefined) token = (await login()).json.data.token;
    return parsed(await handler(event('/call', {action, payload}, {headers: {Origin: origin, 'Content-Type': 'application/json', Authorization: 'Bearer ' + token}})));
  }};
}

test('only server-exchanged identity reaches draw; tokens are scarf-specific and uncached', async () => {
  const f = fixture(), login = await f.login();
  assert.equal(login.statusCode, 200);
  assert.match(login.json.data.token, /^S1\./);
  assert.deepEqual(Object.keys(login.json.data).sort(), ['expiresAt', 'token']);
  const result = await f.request('draw', {inviteCode: 'A'.repeat(16)}, login.json.data.token);
  assert.equal(result.json.ok, true);
  assert.deepEqual(f.calls, [{action: 'draw', payload: {inviteCode: 'A'.repeat(16)}, identity: openId}]);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers['Access-Control-Allow-Origin'], origin);
});

test('client identity, admin flag, chance, stock and arbitrary actions cannot enter business logic', async () => {
  const f = fixture();
  for (const forged of [{openId}, {isAdmin: true}, {outcome: 'won'}, {remaining: 200}, {chance: 1}]) assert.equal((await f.request('draw', {inviteCode: 'A'.repeat(16), ...forged})).json.code, 'INVALID_REQUEST');
  for (const action of ['initialize', 'configure', 'migrate', 'activityCode', '__proto__']) assert.equal((await f.request(action)).json.code, 'INVALID_ACTION');
  assert.equal(f.calls.length, 0);
});

test('strict action schemas reject malformed codes and accidental cross-activity payloads', async () => {
  const f = fixture();
  for (const code of ['', 'a'.repeat(16), 'A'.repeat(15), 'LJC1_' + 'A'.repeat(32), {}, null, ['A'.repeat(16)]]) {
    assert.equal((await f.request('draw', {inviteCode: code})).json.code, 'INVALID_REQUEST');
    assert.equal((await f.request('redeem', {code})).json.code, 'INVALID_REQUEST');
  }
  assert.equal((await f.request('grant', {inviteCode: 'A'.repeat(16)})).json.code, 'INVALID_REQUEST');
  assert.equal(f.calls.length, 0);
});

test('disabled gateway and missing or mismatched origins never exchange credentials', async () => {
  const off = fixture({config: {...config, enabled: false}});
  assert.equal((await off.login()).json.code, 'SERVICE_NOT_CONFIGURED');
  assert.equal(off.exchanges.length, 0);
  for (const badOrigin of [undefined, 'null', 'http://h5.example.test', origin + '.attacker.test']) {
    const f = fixture(), response = parsed(await f.handler(event('/session', {code: 'testcode123456'}, {headers: {'Content-Type': 'application/json', ...(badOrigin ? {Origin: badOrigin} : {})}})));
    assert.equal(response.statusCode, 403);
    assert.equal(response.headers['Access-Control-Allow-Origin'], undefined);
    assert.equal(f.exchanges.length, 0);
  }
});

test('expired, tampered, old-campaign and wrong-origin tokens are rejected', async () => {
  const f = fixture(), token = (await f.login()).json.data.token;
  assert.equal((await f.request('state', {}, token.replace(/^S1/, 'B1'))).json.code, 'UNAUTHENTICATED');
  const segments = token.split('.'); segments[1] = Buffer.from(JSON.stringify({sub: 'oFakeAdmin00000001'})).toString('base64url');
  assert.equal((await f.request('state', {}, segments.join('.'))).json.code, 'UNAUTHENTICATED');
  assert.throws(() => createSessionCodec(config, () => 1800000000000).verify(token, 'https://other.example.test'), {code: 'UNAUTHENTICATED'});
  f.time(1800000060000);
  assert.equal((await f.request('state', {}, token)).json.code, 'SESSION_EXPIRED');
  assert.equal((await f.request('state', {}, '')).json.code, 'UNAUTHENTICATED');
  assert.equal(f.calls.length, 0);
});

test('configuration pins AppID, HTTPS origin, secret length and explicit enable gates', () => {
  const env = {H5_APP_ID: SOURCE_APP_ID, H5_APP_SECRET: 'x'.repeat(32), H5_TOKEN_SECRET: 'a'.repeat(64), H5_ALLOWED_ORIGINS: origin};
  assert.equal(readConfig(env).enabled, false);
  assert.equal(readConfig({...env, H5_GATEWAY_ENABLED: '1'}).enabled, false);
  assert.equal(readConfig({...env, H5_GATEWAY_ENABLED: '1', H5_BACKEND_REVIEWED: '1'}).enabled, true);
  assert.equal(readConfig(env).basePath, '/api/scarf-h5');
  for (const patch of [{H5_APP_ID: 'wx0000000000000001'}, {H5_APP_SECRET: ''}, {H5_TOKEN_SECRET: 'short'}, {H5_ALLOWED_ORIGINS: 'http://localhost:5190'}, {H5_ALLOWED_ORIGINS: origin + '/path'}]) assert.throws(() => readConfig({...env, ...patch}), {code: 'INVALID_CONFIG'});
});

test('unsafe HTTP inputs fail closed and provider details are never forwarded', async () => {
  const f = fixture();
  for (const patch of [{body: '{broken'}, {body: 'x'.repeat(13000)}, {body: '[]'}, {headers: {Origin: origin, 'Content-Type': 'text/plain'}}, {httpMethod: 'GET'}, {path: config.basePath + '/admin'}]) assert.ok(parsed(await f.handler(event('/session', {code: 'testcode123456'}, patch))).statusCode >= 400);
  const broken = fixture({callLottery: async () => { throw new Error('PRIVATE_DATABASE_CREDENTIALS'); }});
  const result = await broken.request('state');
  assert.equal(result.json.code, 'SERVICE_UNAVAILABLE');
  assert.equal(result.body.includes('PRIVATE_DATABASE_CREDENTIALS'), false);
});

test('login provider exchange passes only verified OpenID, and hides session keys and provider diagnostics', async () => {
  let seen;
  const exchange = createCodeExchange(config, async (url, options) => { seen = {url, options}; return {ok: true, json: async () => ({openid: openId, session_key: 'PRIVATE_SESSION_KEY'})}; });
  assert.equal(await exchange('one-time-code'), openId);
  assert.equal(seen.url.origin, 'https://api.weixin.qq.com');
  assert.equal(seen.url.pathname, '/sns/jscode2session');
  assert.equal(seen.options.redirect, 'error');
  for (const body of [{errcode: 40029, errmsg: 'PRIVATE_PROVIDER_DETAILS'}, {openid: ''}]) await assert.rejects(createCodeExchange(config, async () => ({ok: true, json: async () => body}))('one-time-code'), error => error.code === 'LOGIN_FAILED' && !error.message.includes('PRIVATE'));
});

test('grant has a per-staff rate limit; draw and redemption also pass through limits', async () => {
  const f = fixture();
  await f.request('grant'); await f.request('draw', {inviteCode: 'A'.repeat(16)}); await f.request('redeem', {code: 'A'.repeat(16)});
  assert.deepEqual(f.rates.filter(row => ['grant', 'draw', 'redeem'].includes(row[0])), [['grant', openId, 20, 60000], ['draw', openId, 15, 60000], ['redeem', openId, 15, 60000]]);
  const limited = fixture({consumeRate: async () => { throw Object.assign(new Error('请稍后重试'), {code: 'RATE_LIMITED', status: 429, gatewayFault: true}); }});
  assert.equal((await limited.login()).statusCode, 429);
  assert.equal(limited.exchanges.length, 0);
});

test('database rate limiter uses independent hashed records and enforces the window', async () => {
  const rows = new Map(); let time = 1800000000000;
  const db = {runTransaction: async job => job({collection: collection => { assert.equal(collection, 'bubble_scarf_rates'); return {doc: id => { assert.match(id, /^[a-f0-9]{64}$/); return {get: async () => ({data: rows.get(id)}), set: async ({data}) => rows.set(id, data)}; }}; }})};
  const consume = createCloudRateLimiter(db, () => time);
  await consume('grant', openId, 2, 60000); await consume('grant', openId, 2, 60000);
  await assert.rejects(consume('grant', openId, 2, 60000), {code: 'RATE_LIMITED'});
  time += 60000;
  await consume('grant', openId, 2, 60000);
  assert.equal([...rows.values()].every(row => row.expiresAt instanceof Date), true);
});
