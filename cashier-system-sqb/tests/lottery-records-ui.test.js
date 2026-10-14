import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildSync } from 'esbuild';
import { normalizeDrawRecords, drawRedemptionLabel, drawWarningLabel } from '../src/lotteryRecords.js';
const require = createRequire(import.meta.url);
const campaignId = 'isolated-campaign';
const time = 1791888000000;
const row = (id = 'a'.repeat(32)) => ({ recordId: id, participantRef: id, createdAt: time, outcome: 'won',
  prize: { id: 'scarf', name: '魔术头巾', kind: 'physical' },
  issuance: { status: 'issued', couponId: 'isolated-coupon', awardId: 'isolated-award', campaignId: 'isolated-coupon-campaign' },
  redemption: { status: 'AVAILABLE', source: 'coupon_center', redeemedAt: null, checkedAt: time }, legacyStatus: null });
const response = (items = [row()]) => ({ service: 'lottery-records', version: 1, campaignId, items, limit: 20, nextCursor: null, hasMore: false,
  total: items.length, queriedAt: time, order: 'record_id_asc', warnings: [] });

test('record view distinguishes winners, losers, pending issuance, legacy and authoritative redemption', () => {
  const issued = row(), lost = { ...row('b'.repeat(32)), outcome: 'lost', prize: null,
    issuance: { status: 'not_applicable' }, redemption: { status: 'not_applicable', source: 'none' } };
  const pending = { ...row('c'.repeat(32)), issuance: { status: 'pending' }, redemption: { status: 'unknown', source: 'unverified' } };
  const redeemed = { ...row('d'.repeat(32)), redemption: { status: 'REDEEMED', source: 'coupon_center', checkedAt: time, redeemedAt: time - 1000 } };
  const legacy = { ...row('e'.repeat(32)), issuance: { status: 'legacy' }, redemption: { status: 'unknown', source: 'legacy_record' }, legacyStatus: 'redeemed' };
  const value = normalizeDrawRecords(response([issued, lost, pending, redeemed, legacy]), campaignId);
  assert.deepEqual(value.items.map(drawRedemptionLabel), ['可使用', '无需核销', '券中心待核对', '已核销', '历史核销状态待核对']);
  assert.equal(value.items[2].issuance.status, 'pending');
});

test('unverified or untimestamped coupon state is never shown as authoritative redemption', () => {
  for (const source of ['legacy_record', 'unverified', 'none']) {
    const value = normalizeDrawRecords(response([{ ...row(), redemption: { status: 'REDEEMED', source, checkedAt: time, redeemedAt: time } }]), campaignId).items[0];
    assert.notEqual(drawRedemptionLabel(value), '已核销'); assert.equal(value.redemption.checkedAt, null);
  }
  assert.equal(drawRedemptionLabel({ ...row(), redemption: { status: 'AVAILABLE', source: 'coupon_center', checkedAt: null } }), '券中心待核对');
  assert.match(drawWarningLabel('CENTER_STATUS_UNAVAILABLE'), /暂不作确认/);
  assert.ok(!drawWarningLabel('private-server-error').includes('private-server-error'));
});

test('malformed pages, mixed activity, raw OpenIDs, duplicate rows and broken cursor cannot masquerade as valid draws', () => {
  for (const change of [
    data => { data.campaignId = 'other'; }, data => { data.version = 2; }, data => { data.total = 0; },
    data => { data.items.push(data.items[0]); data.total = 2; }, data => { data.items[0].participantRef = 'raw-open-id'; },
    data => { data.items[0].createdAt = '2026-01-01'; }, data => { data.items[0].outcome = 'yes'; },
    data => { data.items[0].redemption.source = 'cached_guess'; }, data => { data.hasMore = true; },
    data => { data.limit = 51; }, data => { data.queriedAt = -1; }, data => { data.nextCursor = 'unexpected'; },
    data => { data.items[0].issuance.couponId = null; }, data => { data.items[0].outcome = 'lost'; },
    data => { data.items[0].redemption.checkedAt = null; }, data => { data.items[0].redemption.status = 'REDEEMED'; },
  ]) { const data = response(); change(data); assert.throws(() => normalizeDrawRecords(data, campaignId), /格式异常/); }
});

test('actual React records table renders saved results and escapes names without exposing extra database or redemption fields', () => {
  const data = response([
    { ...row(), prize: { id: 'scarf', name: '<img src=x onerror=alert(1)>', kind: 'physical' }, openId: 'private-open-id', code: 'private-redemption-code', token: 'private-secret' },
    { ...row('b'.repeat(32)), outcome: 'lost', prize: null, issuance: { status: 'not_applicable' }, redemption: { status: 'not_applicable', source: 'none' } },
    { ...row('c'.repeat(32)), issuance: { status: 'pending' }, redemption: { status: 'unknown', source: 'unverified' } },
  ]);
  const page = normalizeDrawRecords(data, campaignId);
  const bundle = buildSync({ entryPoints: [fileURLToPath(new URL('../src/LotteryRecords.jsx', import.meta.url))], bundle: true,
    platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom', 'react-dom/server'] }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(bundle, { module, exports: module.exports, require, console, process }, { filename: 'LotteryRecords.test-bundle.cjs' });
  const html = renderToStaticMarkup(React.createElement(module.exports.LotteryRecordsTable, { page }));
  assert.match(html, /已中奖/); assert.match(html, /未中奖/); assert.match(html, /待发券/); assert.match(html, /结果已保存，凭证尚未发出/);
  assert.match(html, /&lt;img/); assert.ok(!html.includes('<img src=x'));
  for (const secret of ['private-open-id', 'private-redemption-code', 'private-secret']) assert.ok(!html.includes(secret));
  assert.ok(!JSON.stringify(page).includes('private-'));
});
