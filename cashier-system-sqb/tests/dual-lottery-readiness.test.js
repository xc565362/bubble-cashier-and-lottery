import test from 'node:test';
import assert from 'node:assert/strict';
import { lotteryConnectionProblem } from '../src/lotterySettings.js';
import { scarfConnectionProblem } from '../src/scarfSettings.js';

const fulfillment = { ready: true, centerId: 'shared-center', environment: 'production' };
const original = { fulfillment, prizes: [{ kind: 'physical' }, { kind: 'cash' }] };
const scarf = { fulfillment };
const coupon = { connected: true, mode: 'remote', centerId: 'shared-center', environment: 'production', physicalSupported: true, lotteryCatalogSupported: true };

test('both activities accept one verified cashier center without requiring a second merchant', () => {
  assert.equal(lotteryConnectionProblem(original, coupon), '');
  assert.equal(scarfConnectionProblem(scarf, coupon), '');
});

test('an unrelated center or environment cannot be presented as ready for either activity', () => {
  for (const patch of [{ centerId: 'other-center' }, { environment: 'development' }]) {
    assert.match(lotteryConnectionProblem(original, { ...coupon, ...patch }), /不一致/);
    assert.match(scarfConnectionProblem(scarf, { ...coupon, ...patch }), /不一致/);
  }
});

test('missing legacy metadata and failed identity verification stay visibly unconfirmed', () => {
  assert.match(lotteryConnectionProblem({ prizes: [] }, coupon), /升级/);
  assert.match(lotteryConnectionProblem({ ...original, fulfillment: { ready: false } }, coupon), /暂不可用/);
  for (const field of ['centerId', 'environment']) {
    const broken = { ...fulfillment }; delete broken[field];
    assert.match(lotteryConnectionProblem({ ...original, fulfillment: broken }, coupon), /不一致/);
  }
});

test('local-only coupon connections and unavailable physical capabilities cannot enable original prize fulfillment', () => {
  for (const invalid of [null, { ...coupon, connected: false }, { ...coupon, mode: 'local' }]) {
    assert.match(lotteryConnectionProblem(original, invalid), /券管理/);
  }
  assert.match(lotteryConnectionProblem(original, { ...coupon, physicalSupported: false }), /实物/);
  assert.equal(lotteryConnectionProblem({ ...original, prizes: [{ kind: 'cash' }] }, { ...coupon, physicalSupported: false }), '');
});
