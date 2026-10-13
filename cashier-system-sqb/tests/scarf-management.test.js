import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { matchingScarfProduct, scarfConnectionProblem, scarfDraft, scarfPayload } from '../src/scarfSettings.js';
const require = createRequire(import.meta.url);
const { createScarfBridge, CAMPAIGN_ID } = require('../payments/scarf.cjs');
const { createLotteryBridge } = require('../payments/lottery.cjs');
const { createService } = require('../payments/service.cjs');
const { sealCredentials } = require('../payments/credentials.cjs');
const key = 'a'.repeat(64), url = 'https://isolated.invalid/api/scarf-management';
const identity = { service: 'bubble-scarf-management', version: 1, campaignId: CAMPAIGN_ID };
const product = { id: 'scarf-product', name: '黄橘魔术头巾', sku: 'SCARF-TEST-01', barcode: '0123456789012' };
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scarf-management-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const fetchFn = async (target, init) => {
    calls.push({ target, init });
    assert.equal(init.redirect, 'error');
    const headers = init.headers;
    assert.equal(headers['X-Lottery-Signature'], crypto.createHmac('sha256', key).update(headers['X-Lottery-Time'] + '\n' + headers['X-Lottery-Nonce'] + '\n' + init.body).digest('hex'));
    assert.ok(!init.body.includes(key));
    return Response.json({ ok: true, data: identity });
  };
  const args = { directory, fetchFn, protect: value => 'sealed:' + value, unprotect: value => value.slice(7), ...options };
  return { directory, calls, args, bridge: createScarfBridge(args) };
}
function snapshot() {
  return { ...identity, revision: 3, campaign: { title: '山野有约', venue: '赛事现场', enabled: false, winProbabilityBps: 5000,
    startsAt: null, endsAt: null, redeemEndsAt: null }, prize: { id: 'scarf-v1', name: product.name, imageUrl: '', product: { ...product } },
    inventory: { total: 200, awarded: 2, remaining: 198, redeemed: 1 }, fulfillment: { ready: true, centerId: 'same-center', environment: 'development' }, audit: [] };
}
test('scarf connection verifies its HMAC identity, protects the local secret, and never touches the original lottery connection', async t => {
  const f = fixture(t);
  const original = JSON.stringify({ url: 'https://old.invalid/lottery', key: 'old-protected', campaignId: 'original' });
  fs.writeFileSync(path.join(f.directory, 'lottery-management.json'), original);
  assert.equal((await f.bridge.dispatch('config')).configured, false);
  await f.bridge.dispatch('connect', { url, key, campaignId: CAMPAIGN_ID });
  const publicInfo = await f.bridge.dispatch('config');
  assert.equal(publicInfo.campaignId, CAMPAIGN_ID); assert.ok(!JSON.stringify(publicInfo).includes(key));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'scarf-management.json'))).key, 'sealed:' + key);
  assert.equal(fs.readFileSync(path.join(f.directory, 'lottery-management.json'), 'utf8'), original);
  await f.bridge.dispatch('update', { revision: 3, requestId: 'test-update', operation: 'pause', reason: '隔离测试' });
  assert.equal(JSON.parse(f.calls[1].init.body).payload.revision, 3);
  assert.notEqual(f.calls[0].init.headers['X-Lottery-Nonce'], f.calls[1].init.headers['X-Lottery-Nonce']);
});
test('scarf connection rejects non-HTTPS, credential URLs, wrong path, wrong activity, and wrong service without replacing a connection', async t => {
  const f = fixture(t); await f.bridge.dispatch('connect', { url, key, campaignId: CAMPAIGN_ID });
  const file = path.join(f.directory, 'scarf-management.json'), before = fs.readFileSync(file, 'utf8');
  for (const patch of [{ url: url.replace('https:', 'http:') }, { url: 'https://user:password@isolated.invalid/api/scarf-management' }, { url: url + '?key=bad' }, { url: 'https://isolated.invalid/api/lottery' }, { campaignId: 'original' }, { key: 'bad' }]) {
    await assert.rejects(f.bridge.dispatch('connect', { url, key, campaignId: CAMPAIGN_ID, ...patch }));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  const wrong = createScarfBridge({ ...f.args, fetchFn: async () => Response.json({ ok: true, data: { ...identity, service: 'bubble-lottery-management' } }) });
  await assert.rejects(wrong.dispatch('connect', { url, key, campaignId: CAMPAIGN_ID }), /身份不匹配/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
test('headscarf connection migrates with a password and the two activity packages cannot be mixed', async t => {
  const f = fixture(t), password = 'isolated-password-123';
  await f.bridge.dispatch('connect', { url, key, campaignId: CAMPAIGN_ID });
  const bundle = await f.bridge.dispatch('export-connection', { password });
  assert.ok(!JSON.stringify(bundle).includes(key));
  const target = path.join(f.directory, 'second-device');
  const second = createScarfBridge({ ...f.args, directory: target });
  await assert.rejects(second.dispatch('import-connection', { bundle, password: 'wrong-password-123' }));
  assert.equal((await second.dispatch('config')).configured, false);
  await second.dispatch('import-connection', { bundle, password });
  assert.equal((await second.dispatch('config')).configured, true);
  const lotteryPackage = sealCredentials({ kind: 'lottery-management', url, key, campaignId: CAMPAIGN_ID }, password);
  await assert.rejects(second.dispatch('import-connection', { bundle: lotteryPackage, password }), /不是头巾/);
  const lottery = createLotteryBridge({ directory: target, fetchFn: f.args.fetchFn });
  await assert.rejects(lottery.dispatch('import-connection', { bundle, password }), /不是抽奖/);
});
test('failed cloud requests expose actionable failure but never save unverified connections', async t => {
  const f = fixture(t, { fetchFn: async () => Response.json({ ok: false, code: 'UNAUTHORIZED', error: '管理签名无效' }, { status: 401 }) });
  await assert.rejects(f.bridge.dispatch('connect', { url, key, campaignId: CAMPAIGN_ID }), e => e.code === 'UNAUTHORIZED');
  assert.equal((await f.bridge.dispatch('config')).configured, false);
  assert.ok(!fs.existsSync(path.join(f.directory, 'scarf-management.json')));
});
test('the payment service exposes isolated scarf operations and blocks changes during pending payments or coupon reservations', async t => {
  for (const record of ['payment', 'coupon']) {
    const f = fixture(t);
    await f.bridge.dispatch('connect', { url, key, campaignId: CAMPAIGN_ID });
    fs.writeFileSync(path.join(f.directory, record === 'payment' ? 'payments.json' : 'coupon-transactions.json'), JSON.stringify({ pending: record === 'payment' ? { id: 'pending', state: 'pending', acknowledged: false } : { finished: false } }));
    const service = createService(f.args); t.after(() => service.close());
    assert.equal((await service.dispatch('scarf-config')).configured, true);
    assert.equal((await service.dispatch('scarf-snapshot')).campaignId, CAMPAIGN_ID);
    for (const action of ['connect', 'update', 'export-connection', 'import-connection']) await assert.rejects(service.dispatch('scarf-' + action), /收退款和券占用/);
  }
});
test('scarf draft keeps 50 percent separate from no-win probability and can save undated paused activity', () => {
  const data = snapshot(), draft = scarfDraft(data), payload = scarfPayload(data, draft, '接入收银', [product]);
  assert.equal(payload.campaign.winProbabilityBps, 5000); assert.equal(payload.total, 200); assert.equal(payload.revision, 3);
  assert.equal(payload.campaign.startsAt, null); assert.equal(payload.campaign.redeemEndsAt, null);
  assert.deepEqual(payload.prize.product, product);
  for (const [percentage, expected] of [['0', 0], ['0.01', 1], ['33.33', 3333], ['100', 10000]]) assert.equal(scarfPayload(data, { ...draft, percentage }, '调整', [product]).campaign.winProbabilityBps, expected);
  for (const percentage of ['100.01', '50.001', '-1', '1e2', '']) assert.throws(() => scarfPayload(data, { ...draft, percentage }, '调整', [product]));
});
test('stock commits, pause, dates, secure images and portable product identity are validated before save', () => {
  const data = snapshot(), draft = scarfDraft(data);
  for (const patch of [{ total: '1' }, { total: '2.5' }, { total: '1000001' }, { startsAt: '2026-10-10T12:00' }, { prize: { ...draft.prize, imageUrl: 'http://untrusted.invalid/a.png' } }, { prize: { ...draft.prize, product: null } }]) assert.throws(() => scarfPayload(data, { ...draft, ...patch }, '调整', [product]));
  assert.throws(() => scarfPayload({ ...data, campaign: { ...data.campaign, enabled: true } }, draft, '调整', [product]), /暂停/);
  const dated = { ...draft, startsAt: '2026-10-10T12:00', endsAt: '2026-10-11T12:00', redeemEndsAt: '2026-10-12T12:00' };
  assert.ok(scarfPayload(data, dated, '时间确认', [product]).campaign.endsAt.endsWith('Z'));
  assert.throws(() => scarfPayload(data, { ...dated, endsAt: dated.startsAt }, '调整', [product]), /结束/);
  assert.throws(() => scarfPayload(data, { ...dated, redeemEndsAt: dated.startsAt }, '调整', [product]), /核销/);
  assert.equal(matchingScarfProduct(product, [{ ...product, id: 'second-computer' }]).id, 'second-computer');
  assert.equal(matchingScarfProduct(product, [product, { ...product, id: 'duplicate' }]), null);
  assert.equal(matchingScarfProduct(product, [{ ...product, productType: 'coupon' }]), null);
  assert.throws(() => scarfPayload(data, draft, '调整', [{ ...product, barcode: 'different', sku: 'different' }]), /唯一/);
});
test('unchanged local datetime fields preserve exact existing validity timestamps', () => {
  const data = snapshot();
  Object.assign(data.campaign, { startsAt: '2026-10-10T02:03:45.678Z', endsAt: '2026-10-11T02:03:45.678Z', redeemEndsAt: '2026-10-12T02:03:45.678Z' });
  const payload = scarfPayload(data, scarfDraft(data), '更改展示', [product]);
  for (const field of ['startsAt', 'endsAt', 'redeemEndsAt']) assert.equal(payload.campaign[field], data.campaign[field]);
});
test('form lengths and required venue align with the cloud management contract', () => {
  const data = snapshot(), draft = scarfDraft(data);
  for (const patch of [{ title: '长'.repeat(61) }, { title: '含\n换行' }, { venue: '' }, { venue: '长'.repeat(101) }, { prize: { ...draft.prize, name: '长'.repeat(61) } },
    { prize: { ...draft.prize, imageUrl: 'https://assets.invalid/' + 'a'.repeat(2000) } }, { prize: { ...draft.prize, product: { ...product, id: 'x'.repeat(121) } } }]) {
    assert.throws(() => scarfPayload(data, { ...draft, ...patch }, '调整', [product]));
  }
  assert.equal(scarfPayload(data, { ...draft, title: '长'.repeat(60), venue: '长'.repeat(100) }, '调整', [product]).campaign.title.length, 60);
});
test('opening a managed scarf activity requires matching coupon center and environment with physical catalog support', () => {
  const data = snapshot(), coupon = { connected: true, mode: 'remote', centerId: 'same-center', environment: 'development', physicalSupported: true, lotteryCatalogSupported: true };
  assert.equal(scarfConnectionProblem(data, coupon), '');
  for (const patch of [{ mode: 'local' }, { connected: false }, { centerId: 'other-center' }, { environment: 'production' }, { physicalSupported: false }, { lotteryCatalogSupported: false }]) assert.ok(scarfConnectionProblem(data, { ...coupon, ...patch }));
  assert.ok(scarfConnectionProblem({ ...data, fulfillment: { ...data.fulfillment, ready: false } }, coupon));
});
