import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { normalizeRulesText, RULES_TEXT_CAPABILITY } from '../src/rulesText.js';
import { lotteryDraft, lotteryPayload } from '../src/lotterySettings.js';
import { scarfDraft, scarfPayload } from '../src/scarfSettings.js';

const require = createRequire(import.meta.url);
const { createLotteryBridge } = require('../payments/lottery.cjs');
const { createScarfBridge, CAMPAIGN_ID } = require('../payments/scarf.cjs');
const product = { id: 'rules-test-product', name: '测试头巾', sku: 'RULES-TEST-01', barcode: 'RULES-TEST-02' };
const fixtures = [
  {
    activity: '此刻在地', createBridge: createLotteryBridge, campaignId: 'rules-test-original',
    service: 'bubble-lottery-management', url: 'https://isolated.invalid/lottery',
    snapshot: () => ({ revision: 3, enabled: false, mode: 'fixed', capabilities: [RULES_TEXT_CAPABILITY], prizes: [
      { id: 'test-prize', name: '测试奖品', kind: 'physical', quota: 20, allocated: 2, weightBps: 5000 },
      { id: 'test-cash', name: '测试优惠券', kind: 'cash', amount: 10, quota: 20, allocated: 0, weightBps: 5000 }
    ] }),
    draft: lotteryDraft,
    payload: (snapshot, draft) => lotteryPayload(snapshot, draft, '更新活动说明'),
    rules: source => source.rulesText,
    withRules: (source, rulesText) => ({ ...source, rulesText }),
    withoutRules: ({ rulesText, ...source }) => source,
    bridgePayload: rulesText => ({ operation: 'configure', expectedRevision: 3, requestId: 'rules-test-update', rulesText })
  },
  {
    activity: '山野有约', createBridge: createScarfBridge, campaignId: CAMPAIGN_ID,
    service: 'bubble-scarf-management', url: 'https://isolated.invalid/api/scarf-management',
    snapshot: () => ({ revision: 3, capabilities: [RULES_TEXT_CAPABILITY], campaign: {
      title: '山野有约', venue: '测试现场', enabled: false, winProbabilityBps: 5000,
      startsAt: '2026-10-13T02:03:45.678Z', endsAt: '2026-10-14T02:03:45.678Z', redeemEndsAt: '2026-10-15T02:03:45.678Z'
    }, prize: { id: 'scarf-test', name: product.name, imageUrl: '', product: { ...product } }, inventory: { total: 200, awarded: 2 } }),
    draft: scarfDraft,
    payload: (snapshot, draft) => scarfPayload(snapshot, draft, '更新活动说明', [product]),
    rules: source => source.campaign.rulesText,
    withRules: (source, rulesText) => ({ ...source, campaign: { ...source.campaign, rulesText } }),
    withoutRules: source => { const { rulesText, ...campaign } = source.campaign; return { ...source, campaign }; },
    bridgePayload: rulesText => ({ operation: 'configure', revision: 3, requestId: 'rules-test-update', campaign: { rulesText } })
  }
];

test('activity rules normalize line endings, preserve inner LF and TAB, and trim only outer whitespace', () => {
  assert.equal(normalizeRulesText(' \r\n第一行\r第二行\r\n\t第三行\n '), '第一行\n第二行\n\t第三行');
  assert.equal(normalizeRulesText(' \r\n\t '), '');
  assert.equal(normalizeRulesText('<b>纯文本</b> & https://example.invalid'), '<b>纯文本</b> & https://example.invalid');
});

test('activity rules enforce normalized UTF-16 length without counting surrounding whitespace', () => {
  assert.equal(normalizeRulesText(' \n' + '字'.repeat(5000) + '\t ').length, 5000);
  assert.equal(normalizeRulesText('🙂'.repeat(2500)).length, 5000);
  assert.throws(() => normalizeRulesText('字'.repeat(5001)), /5000/);
  assert.throws(() => normalizeRulesText('🙂'.repeat(2501)), /5000/);
});

test('activity rules reject non-text and every disallowed control, including trim-removable edge characters', () => {
  for (const value of [null, undefined, 5, false, [], {}]) assert.throws(() => normalizeRulesText(value), /纯文本/);
  for (const code of [...Array(32).keys(), ...Array.from({ length: 33 }, (_, n) => 127 + n)]) {
    if ([9, 10, 13].includes(code)) continue;
    const character = String.fromCharCode(code);
    for (const value of [character + '正文', '正' + character + '文', '正文' + character]) {
      assert.throws(() => normalizeRulesText(value), /控制字符/, `U+${code.toString(16)}`);
    }
  }
});

for (const f of fixtures) {
  test(`${f.activity}: rules updates preserve prize, probability, quota and precise validity fields`, () => {
    const source = f.snapshot(), before = structuredClone(source), draft = f.draft(source);
    assert.equal(draft.rulesText, '');
    const initial = f.payload(source, draft);
    draft.rulesText = '  第一行\r\n第二行\r\t第三行  ';
    const payload = f.payload(source, draft);
    assert.equal(f.rules(payload), '第一行\n第二行\n\t第三行');
    assert.deepEqual(f.withoutRules(payload), f.withoutRules(initial));
    assert.deepEqual(source, before);
    assert.equal(draft.rulesText, '  第一行\r\n第二行\r\t第三行  ');
  });

  test(`${f.activity}: saved text loads and explicit blank sends the reset signal`, () => {
    const source = f.withRules(f.snapshot(), ' 已保存\r\n第二行 '), draft = f.draft(source);
    assert.equal(draft.rulesText, '已保存\n第二行');
    draft.rulesText = ' \r\n\t ';
    assert.equal(f.rules(f.payload(source, draft)), '');
    for (const value of ['x'.repeat(5001), '正文\u0000', '\f正文']) {
      assert.throws(() => f.payload(source, { ...draft, rulesText: value }), /5000|控制字符/);
    }
  });

  test(`${f.activity}: old servers preserve existing description while other configuration remains editable`, () => {
    const source = f.withRules(f.snapshot(), '原说明'); delete source.capabilities;
    const draft = f.draft(source);
    assert.equal(f.rules(f.payload(source, draft)), undefined);
    assert.equal(f.rules(f.payload(source, { ...draft, rulesText: ' \r\n原说明 ' })), undefined);
    for (const rulesText of ['', '新说明']) {
      assert.throws(() => f.payload(source, { ...draft, rulesText }), /升级.*云端活动服务和 H5.*没有保存/);
    }
    const legacy = f.snapshot(); delete legacy.capabilities;
    assert.equal(f.rules(f.payload(legacy, f.draft(legacy))), undefined);
  });

  test(`${f.activity}: signing bridge refuses unsupported description writes including resets, then forwards supported payload intact`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-rules-bridge-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let capabilities = []; const calls = [], key = 'a'.repeat(64);
    const bridge = f.createBridge({ directory, fetchFn: async (_url, init) => {
      const body = JSON.parse(init.body); calls.push(body);
      assert.equal(init.headers['X-Lottery-Signature'], crypto.createHmac('sha256', key)
        .update(init.headers['X-Lottery-Time'] + '\n' + init.headers['X-Lottery-Nonce'] + '\n' + init.body).digest('hex'));
      return Response.json({ ok: true, data: body.action === 'snapshot'
        ? { service: f.service, version: 1, campaignId: f.campaignId, capabilities }
        : { revision: 4 } });
    } });
    await bridge.dispatch('connect', { url: f.url, key, campaignId: f.campaignId });
    for (const text of ['新正文\n第二行', '']) await assert.rejects(bridge.dispatch('update', f.bridgePayload(text)), /尚未支持活动说明.*没有修改/);
    assert.equal(calls.filter(row => row.action === 'update').length, 0);
    await bridge.dispatch('update', { operation: 'pause', requestId: 'legacy-pause' });
    assert.equal(calls.at(-1).action, 'update');
    capabilities = [RULES_TEXT_CAPABILITY];
    const input = f.bridgePayload('第一行\n\t第二行');
    await bridge.dispatch('update', input);
    assert.deepEqual(calls.at(-1).payload, input);
    await bridge.dispatch('update', f.bridgePayload(''));
    assert.equal(f.rules(calls.at(-1).payload), '');
    capabilities = [];
    await assert.rejects(bridge.dispatch('update', input), /尚未支持活动说明/);
  });
}

test('original signing bridge checks both rules and catalog capabilities in one snapshot', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-rules-catalog-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = []; let capabilities = [RULES_TEXT_CAPABILITY];
  const bridge = createLotteryBridge({ directory, fetchFn: async (_url, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    return Response.json({ ok: true, data: body.action === 'snapshot'
      ? { service: 'bubble-lottery-management', version: 1, campaignId: 'combined-test', capabilities }
      : { revision: 2 } });
  } });
  await bridge.dispatch('connect', { url: 'https://isolated.invalid/lottery', key: 'b'.repeat(64), campaignId: 'combined-test' });
  const input = { operation: 'configure', requestId: 'combined-update', rulesText: '现场说明', catalog: [{ id: 'sample' }] };
  await assert.rejects(bridge.dispatch('update', input), /完整奖项管理/);
  assert.equal(calls.filter(row => row.action === 'update').length, 0);
  capabilities.push('lottery-catalog-v1'); calls.length = 0;
  await bridge.dispatch('update', input);
  assert.deepEqual(calls.map(row => row.action), ['snapshot', 'update']);
  assert.deepEqual(calls[1].payload, input);
});
