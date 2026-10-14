'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {SOURCE_APP_ID, readConfig, createGateway, createSessionCodec, createCodeExchange, createCloudRateLimiter} = require('../server/cloudfunctions/bubble-h5-gateway/gateway.cjs');
const {createLotteryAdapter} = require('../server/cloudfunctions/bubble-h5-gateway/lottery-adapter.cjs');
const {createService} = require('../server/cloudfunctions/bubble-h5-gateway/vendor/lottery/service.js');
const {createPhysicalCenter} = require('../server/cloudfunctions/bubble-h5-gateway/vendor/lottery/physical-center.cjs');
const origin = 'https://h5.example.test';
const openId = 'oTest_TrustedIdentityOnly';
const config = {enabled: true, appId: 'wx0000000000000001', tokenSecret: crypto.randomBytes(32).toString('hex'), appSecret: 'testsecret'.repeat(4), origins: [origin], basePath: '/api/bubble-h5', sessionTtlMs: 60000};
const decoded = response => ({...response, json: response.body ? JSON.parse(response.body) : null});
function event(path, body, extra = {}) { return {httpMethod: 'POST', path: config.basePath + path, headers: {Origin: origin, 'Content-Type': 'application/json'}, body: JSON.stringify(body), ...extra}; }
function fixture(overrides = {}) {
  const called = [], exchanged = [], rates = [];
  let time = 1800000000000;
  const options = {config: {...config}, now: () => time,
    exchangeCode: async code => {exchanged.push(code); return openId;},
    callLottery: async (action, payload, identity) => {called.push({action, payload, identity}); return {safe: true};},
    consumeCode: async () => {}, consumeRate: async (...args) => {rates.push(args);}, ...overrides};
  const handler = createGateway(options);
  async function login() { return decoded(await handler(event('/session', {code: 'testcode12345'}))); }
  async function request(action, payload = {}, token) {
    token = token === undefined ? (await login()).json.data.token : token;
    return decoded(await handler(event('/call', {action, payload}, {headers: {Origin: origin, 'Content-Type': 'application/json', Authorization: 'Bearer ' + token}})));
  }
  return {handler, login, request, called, exchanged, rates, setTime: value => {time = value;}};
}

test('only server-exchanged identity reaches business; no session_key is returned', async () => {
  const f = fixture(), login = await f.login();
  assert.equal(login.statusCode, 200);
  assert.deepEqual(Object.keys(login.json.data).sort(), ['expiresAt', 'token']);
  const result = await f.request('draw', {}, login.json.data.token);
  assert.equal(result.json.ok, true);
  assert.deepEqual(f.called, [{action: 'draw', payload: {}, identity: openId}]);
  assert.equal(result.headers['Access-Control-Allow-Origin'], origin);
  assert.equal(result.headers['Cache-Control'], 'no-store');
});

test('client-supplied identity, administrator and result fields are rejected', async () => {
  for (const payload of [{openId: 'another'}, {openid: 'another'}, {isAdmin: true}, {prize: {id: 'cash50'}}, {entryId: 'other'}]) {
    const f = fixture(), result = await f.request('draw', payload);
    assert.equal(result.json.code, 'INVALID_REQUEST');
    assert.equal(f.called.length, 0);
  }
  const f = fixture();
  const result = decoded(await f.handler(event('/session', {code: 'testcode12345', openId: 'forged'})));
  assert.equal(result.json.code, 'INVALID_REQUEST');
  assert.equal(f.exchanged.length, 0);
});

test('token tampering, wrong key, wrong app and wrong origin fail authentication', () => {
  const clock = () => 1800000000000;
  const codec = createSessionCodec(config, clock), token = codec.issue(openId, origin).token;
  const parts = token.split('.');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  parts[1] = Buffer.from(JSON.stringify({...claims, sub: 'oFake_AdministratorUser'})).toString('base64url');
  assert.throws(() => codec.verify(parts.join('.'), origin), {code: 'UNAUTHENTICATED'});
  assert.throws(() => createSessionCodec({...config, tokenSecret: crypto.randomBytes(32).toString('hex')}, clock).verify(token, origin), {code: 'UNAUTHENTICATED'});
  assert.throws(() => createSessionCodec({...config, appId: 'wx0000000000000002'}, clock).verify(token, origin), {code: 'UNAUTHENTICATED'});
  assert.throws(() => codec.verify(token, 'https://attacker.example'), {code: 'UNAUTHENTICATED'});
});

test('expired and absent tokens never call the business service', async () => {
  const f = fixture(), token = (await f.login()).json.data.token;
  f.setTime(1800000060000);
  assert.equal((await f.request('draw', {}, token)).json.code, 'SESSION_EXPIRED');
  assert.equal((await f.request('draw', {}, '')).json.code, 'UNAUTHENTICATED');
  assert.equal(f.called.length, 0);
});

test('disabled gateway and disallowed/missing Origin never exchange a code', async () => {
  const f = fixture({config: {...config, enabled: false}});
  assert.equal((await f.login()).json.code, 'SERVICE_NOT_CONFIGURED');
  assert.equal(f.exchanged.length, 0);
  for (const badOrigin of ['https://h5.example.test.evil.test', 'null', undefined]) {
    const f = fixture();
    const result = decoded(await f.handler(event('/session', {code: 'testcode12345'}, {headers: {'Content-Type': 'application/json', ...(badOrigin ? {Origin: badOrigin} : {})}})));
    assert.equal(result.statusCode, 403);
    assert.equal(result.headers['Access-Control-Allow-Origin'], undefined);
    assert.equal(f.exchanged.length, 0);
  }
});

test('initialize, migrate and management operations are unreachable', async () => {
  const f = fixture();
  for (const action of ['initializePool', 'migratePhysical', 'configure', '__proto__']) assert.equal((await f.request(action)).json.code, 'INVALID_ACTION');
  assert.equal(f.called.length, 0);
});

test('invalid JSON, oversized body, content type, method and path fail closed', async () => {
  const f = fixture();
  for (const patch of [{body: '{broken'}, {body: 'x'.repeat(13000)}, {body: '[]'}, {body: 'null'}, {headers: {Origin: origin, 'Content-Type': 'text/plain'}}, {httpMethod: 'GET'}, {path: config.basePath + '/other'}]) {
    const result = decoded(await f.handler(event('/session', {code: 'testcode12345'}, patch)));
    assert.ok(result.statusCode >= 400);
  }
  assert.equal(f.exchanged.length, 0);
});

test('preflight allows only exact Origin and does not call dependencies', async () => {
  const f = fixture();
  const response = await f.handler(event('/call', {}, {httpMethod: 'OPTIONS'}));
  assert.equal(response.statusCode, 204);
  assert.equal(response.body, '');
  assert.equal(f.called.length + f.exchanged.length + f.rates.length, 0);
});

test('trusted service enforces admin authorization and provider errors are sanitized', async () => {
  const f = fixture({callLottery: async () => {throw Object.assign(new Error('当前微信账号没有核销权限'), {code: 'FORBIDDEN'});}});
  assert.equal((await f.request('redeem', {code: '0123456789ABCDEF'})).statusCode, 403);
  const g = fixture({callLottery: async () => {throw new Error('secret-token-must-never-leak');}});
  const result = await g.request('draw');
  assert.equal(result.statusCode, 503);
  assert.ok(!result.body.includes('secret-token'));
});

test('code exchange uses fixed provider and returns only verified OpenID', async () => {
  let observed;
  const exchange = createCodeExchange(config, async (url, options) => {observed = {url, options}; return {ok: true, json: async () => ({openid: openId, session_key: 'NEVER_RETURN_THIS'})};});
  assert.equal(await exchange('testcode12345'), openId);
  assert.equal(observed.url.origin, 'https://api.weixin.qq.com');
  assert.equal(observed.url.pathname, '/sns/jscode2session');
  assert.equal(observed.url.searchParams.get('appid'), config.appId);
  assert.equal(observed.options.redirect, 'error');
  for (const body of [{errcode: 40029, errmsg: 'secret upstream details'}, {openid: ''}, null]) {
    const invalid = createCodeExchange(config, async () => ({ok: true, json: async () => body}));
    await assert.rejects(invalid('testcode12345'), error => error.code === 'LOGIN_FAILED' && !error.message.includes('secret'));
  }
});

test('missing production settings and weak default secret are rejected', () => {
  assert.throws(() => readConfig({}), {code: 'INVALID_CONFIG'});
  const env = {H5_APP_ID: SOURCE_APP_ID, H5_APP_SECRET: config.appSecret, H5_TOKEN_SECRET: config.tokenSecret, H5_ALLOWED_ORIGINS: origin};
  assert.equal(readConfig(env).enabled, false);
  assert.equal(readConfig({...env, H5_GATEWAY_ENABLED: '1'}).enabled, false);
  assert.equal(readConfig({...env, H5_GATEWAY_ENABLED: '1', H5_BACKEND_REVIEWED: '1'}).enabled, true);
  for (const value of ['*', 'http://example.test', origin + '/', origin + '/page']) assert.throws(() => readConfig({...env, H5_ALLOWED_ORIGINS: value}), {code: 'INVALID_CONFIG'});
  assert.throws(() => readConfig({...env, H5_TOKEN_SECRET: 'default'}), {code: 'INVALID_CONFIG'});
  assert.throws(() => readConfig({...env, H5_APP_ID: 'wx0000000000000002'}), {code: 'INVALID_CONFIG'});
});

test('rate limit failures stop login and business calls', async () => {
  const error = Object.assign(new Error('操作较频繁，请稍后重试'), {gatewayFault: true, status: 429, code: 'RATE_LIMITED'});
  const f = fixture({consumeRate: async () => {throw error;}});
  assert.equal((await f.login()).statusCode, 429);
  assert.equal(f.exchanged.length, 0);
  const token = createSessionCodec(config, () => 1800000000000).issue(openId, origin).token;
  assert.equal((await f.request('draw', {}, token)).statusCode, 429);
  assert.equal(f.called.length, 0);
});

test('distributed limiter uses shared atomic counters without storing raw identity', async () => {
  const rows = new Map(); let queue = Promise.resolve();
  const db = {runTransaction(fn) {
    const run = queue.then(() => fn({collection(name) {assert.equal(name, 'lottery_h5_rates'); return {doc(id) {return {
      async get() {return {data: rows.get(id)};}, async set({data}) {rows.set(id, data);}
    };}};}})); queue = run.catch(() => {}); return run;
  }};
  const first = createCloudRateLimiter(db, () => 1800000000000), second = createCloudRateLimiter(db, () => 1800000000000);
  const results = await Promise.allSettled(Array.from({length: 8}, (_, i) => (i % 2 ? first : second)('user', openId, 3, 60000)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 3);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'RATE_LIMITED').length, 5);
  assert.ok(!JSON.stringify([...rows]).includes(openId));
});

test('missing physical center cannot silently re-enable old direct redemption', () => {
  const env = {CASHIER_CENTER_JSON: '{}'};
  assert.throws(() => createLotteryAdapter({env, cloud: {database() {throw new Error('Must not reach DB');}}}), {code: 'INVALID_CONFIG'});
});

function memoryStore() {
  const rows = new Map(); let queue = Promise.resolve();
  return {rows, transaction(fn) {const run = queue.then(() => fn({get: async (table, id) => structuredClone(rows.get(table + ':' + id) || null), set: async (table, id, data) => rows.set(table + ':' + id, structuredClone(data))})); queue = run.catch(() => {}); return run;}};
}
test('copied business service keeps draw idempotent across original/H5 callers', async () => {
  const store = memoryStore(), prize = {id: 'cap', kind: 'physical', name: 'Test cap', probability: 100};
  const campaign = {id: 'isolated-test', enabled: true, startsAt: 1, endsAt: 10000, redeemEndsAt: 10000};
  const entryId = id => crypto.createHash('sha256').update(`${campaign.id}:${id}`).digest('hex').slice(0, 32);
  let allocated = 0;
  const service = createService({store, prizes: [prize], campaign, now: () => 100, randomTicket: () => {allocated++; return 0;}, makeCode: () => '0123456789ABCDEF', entryId, adminIds: []});
  const [nativeResult, h5Result] = await Promise.all([service('draw', {}, openId), service('draw', {}, openId)]);
  assert.deepEqual(nativeResult, h5Result);
  assert.equal(allocated, 1);
  assert.equal([...store.rows.keys()].filter(key => key.startsWith('entries:')).length, 1);
});

test('copied physical center forbids direct H5 redemption without contacting center', async () => {
  const store = memoryStore(), prize = {id: 'cap', kind: 'physical'}, code = '0123456789ABCDEF';
  store.rows.set('codes:' + code, {campaignId: 'isolated-test', entryId: 'test-entry'});
  store.rows.set('entries:test-entry', {campaignId: 'isolated-test', prize, code, status: 'pending'});
  const service = createPhysicalCenter({base: async () => {throw new Error('Must not reach legacy redeem');}, store, campaign: {id: 'isolated-test'}, prizes: [prize], adminIds: [openId], entryId: () => 'test-entry', now: () => 100,
    physicalConfig: {stage: 'active', handoffReadyAt: 1, baseUrl: 'https://center.example.test/', centerId: 'test-center', environment: 'production', token: 'x'.repeat(40), prizes: {cap: {campaignId: 'test-physical'}}},
    fetchFn: async () => {throw new Error('No network allowed');}});
  await assert.rejects(service('redeem', {code}, openId), {code: 'POS_REQUIRED'});
  await assert.rejects(service('redeem', {code}, 'oTest_NonAdminIdentity'), {code: 'FORBIDDEN'});
});

test('gateway preserves requiresPos on all physical receipt responses and still rejects direct redemption', async () => {
  const {campaign, prizes} = require('../server/cloudfunctions/bubble-h5-gateway/vendor/lottery/config.js');
  const prize = prizes.find(value => value.kind === 'physical');
  const entryId = crypto.createHash('sha256').update(`${campaign.id}:${openId}`).digest('hex').slice(0, 32);
  const code = '0123456789ABCDEF';
  const rows = new Map([
    ['lottery_entries:' + entryId, {campaignId: campaign.id, prize, code, status: 'redeemed', createdAt: campaign.startsAt + 1, redeemedAt: campaign.startsAt + 2}],
    ['lottery_codes:' + code, {campaignId: campaign.id, entryId}]
  ]);
  const db = {runTransaction: async callback => callback({collection(name) {return {doc(id) {return {
    async get() {return {data: structuredClone(rows.get(name + ':' + id) || {})};},
    async set({data}) {rows.set(name + ':' + id, structuredClone(data));}
  };}};}})};
  const center = {baseUrl: 'https://center.example.test/', centerId: 'isolated-center', environment: 'production', token: 'x'.repeat(40),
    prizes: Object.fromEntries(prizes.map(value => [value.id, {campaignId: 'isolated-' + value.id, minimumCents: 0}]))};
  const adapter = createLotteryAdapter({cloud: {database: () => db}, now: () => campaign.startsAt + 10,
    env: {CASHIER_CENTER_JSON: JSON.stringify(center), PHYSICAL_CENTER_JSON: JSON.stringify({...center, stage: 'active', handoffReadyAt: 1}),
      LOTTERY_ADMIN_OPENIDS: openId, H5_MINIPROGRAM_ENTRY_PAGE: 'pages/bubble-h5/index'}});
  const f = fixture({callLottery: adapter});
  const token = (await f.login()).json.data.token;
  for (const action of ['state', 'draw', 'lookup']) {
    const result = await f.request(action, action === 'lookup' ? {code} : {}, token);
    assert.equal(result.json.ok, true);
    const receipt = action === 'state' ? result.json.data.entry : result.json.data;
    assert.equal(receipt.prize.kind, 'physical');
    assert.equal(receipt.requiresPos, true);
    assert.equal(receipt.status, 'redeemed');
  }
  const result = await f.request('redeem', {code}, token);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.code, 'POS_REQUIRED');
  assert.equal(rows.get('lottery_entries:' + entryId).redeemedAt, campaign.startsAt + 2);
});
