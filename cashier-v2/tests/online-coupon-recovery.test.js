import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCouponWorkspace } from '../src/couponWorkspace.js';

test('staff coupon recovery reads pending reservations without requesting administrator APIs', async () => {
  const requests = [];
  const row = { id: 'isolated-reservation', canRelease: true, coupon: { name: '测试奖品', state: 'RESERVED' } };
  const allowed = { config: { connected: true }, sync: [row], 'physical-bindings': { prizes: {} } };
  const result = await loadCouponWorkspace(async (action) => {
    requests.push(action);
    assert.ok(Object.hasOwn(allowed, action), `staff must not call ${action}`);
    return allowed[action];
  }, { staff: true });
  assert.deepEqual(requests, ['config', 'sync', 'physical-bindings']);
  assert.deepEqual(result.pending, [row]);
  assert.deepEqual(result.campaigns, []);
  assert.deepEqual(result.keys, []);
});

test('administrator coupon workspace retains campaign, issue and key management reads', async () => {
  const requests = [];
  const filter = { campaignId: 'isolated-campaign', page: 2 };
  await loadCouponWorkspace(async (action, input) => {
    requests.push(action);
    if (action === 'coupons') assert.deepEqual(input, filter);
    return action === 'physical-bindings' ? { prizes: {} } : [];
  }, { filter });
  assert.deepEqual(requests, ['config', 'campaigns', 'coupons', 'keys', 'sync', 'physical-bindings']);
});

test('recovery displays a lease denial instead of pretending the pending list is empty', async () => {
  await assert.rejects(loadCouponWorkspace(async (action) => {
    if (action === 'sync') throw Object.assign(new Error('请先取得收银使用权'), { code: 'LEASE_REQUIRED' });
    return {};
  }, { staff: true }), { code: 'LEASE_REQUIRED' });
});

test('read-only administrators still load campaigns and vouchers without executing recovery', async () => {
  const requests = [];
  const pending = [{ id: 'isolated-reservation', canRelease: true }];
  const coupons = { items: [{ id: 'isolated-award' }], total: 1 };
  const result = await loadCouponWorkspace(async action => {
    requests.push(action);
    assert.notEqual(action, 'sync', 'sync can commit coupon settlement and must keep its lease requirement');
    return action === 'pending' ? pending : action === 'coupons' ? coupons : [];
  }, { canRecover: false });
  assert.deepEqual(requests, ['config', 'campaigns', 'coupons', 'keys', 'pending', 'physical-bindings']);
  assert.deepEqual(result.pending, pending); assert.deepEqual(result.coupons, coupons);
});

test('staff without a lease reads only the pending snapshot and never requests administrator APIs', async () => {
  const requests = [];
  await loadCouponWorkspace(async action => { requests.push(action); return []; }, { staff: true, canRecover: false });
  assert.deepEqual(requests, ['config', 'pending', 'physical-bindings']);
});
