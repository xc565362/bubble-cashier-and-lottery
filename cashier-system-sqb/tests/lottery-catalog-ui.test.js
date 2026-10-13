import test from 'node:test';
import assert from 'node:assert/strict';
import { lotteryDraft, lotteryPayload, retirePrize, availablePrizeProducts, safePrizeImage } from '../src/lotterySettings.js';

const snapshot = () => ({ revision: 3, mode: 'fixed', capabilities: ['catalog-v1'], prizes: [
  { id: 'old', name: '原奖品', kind: 'physical', quota: 10, allocated: 2, weightBps: 5000 },
  { id: 'cash', name: '十元券', kind: 'cash', amount: 10, quota: 10, allocated: 0, weightBps: 5000 }
] });
test('retiring a prize retains awarded quota and prevents future draws without changing award records', () => {
  const source = snapshot(), before = structuredClone(source);
  let draft = retirePrize(source, lotteryDraft(source), 'old');
  draft.percentages.cash = '100';
  const payload = lotteryPayload(source, draft, '更换奖品');
  assert.deepEqual(source, before);
  assert.equal(payload.quantities.old, 2); assert.equal(payload.weightsBps.old, 0);
  assert.equal(payload.catalog.find(p => p.id === 'old').retired, true);
  draft.quantities.old = '3'; assert.throws(() => lotteryPayload(source, draft, '不合法'), /已移除/);
});
test('new prizes participate in probability validation; deleting an unsaved prize leaves no phantom weights', () => {
  const source = snapshot(), draft = lotteryDraft(source);
  draft.catalog.push({ id: 'new', name: '新奖品', kind: 'physical', retired: false });
  draft.quantities.new = '10'; draft.percentages.new = '50';
  assert.throws(() => lotteryPayload(source, draft, '新增'), /合计/);
  draft.percentages.old = '0';
  assert.equal(lotteryPayload(source, draft, '新增').weightsBps.new, 5000);
  const removed = retirePrize(source, draft, 'new');
  assert.equal(removed.catalog.some(p => p.id === 'new'), false);
  assert.equal('new' in removed.percentages, false);
});
test('old cloud capability cannot emit a catalog update and invalid images fail validation', () => {
  const source = snapshot(); delete source.capabilities;
  const draft = lotteryDraft(source);
  assert.equal('catalog' in draft, false);
  assert.equal('catalog' in lotteryPayload(source, draft, '改概率'), false);
  assert.equal(safePrizeImage('javascript:alert(1)'), '');
  assert.equal(safePrizeImage('https://user:password@example.test/x'), '');
  assert.equal(safePrizeImage('https://example.test/a.png'), 'https://example.test/a.png');
  const next = lotteryDraft(snapshot()); next.catalog[0].imageUrl = 'http://example.test/a.png';
  assert.throws(() => lotteryPayload(snapshot(), next, '图片'), /HTTPS/);
});
test('product picker excludes coupons, missing codes and codes shared across SKU/barcode fields', () => {
  const products = [
    { id: 'a', sku: 'A', name: '可用' },
    { id: 'b', sku: 'B' }, { id: 'c', barcode: 'B' },
    { id: 'd', sku: 'D', productType: 'coupon' }, { id: 'e' },
    { id: 'f', sku: 'F', barcode: 'shared' }, { id: 'g', sku: 'G', barcode: 'shared' }
  ];
  assert.deepEqual(availablePrizeProducts(products).map(p => p.id), ['a']);
});
test('inventory mode removal calculates valid fallback weights without exposing a hidden input requirement', () => {
  const source = snapshot(); source.mode = 'inventory';
  const draft = retirePrize(source, lotteryDraft(source), 'old');
  const payload = lotteryPayload(source, draft, '减少奖项');
  assert.equal(payload.weightsBps.old, 0); assert.equal(payload.weightsBps.cash, 10000);
  assert.equal(payload.quantities.old, 2);
});
