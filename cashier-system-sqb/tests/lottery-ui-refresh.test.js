import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { lotteryConnectionProblem, lotteryDraft } from '../src/lotterySettings.js';
import { scarfConnectionProblem, scarfDraft } from '../src/scarfSettings.js';

const verifiedCenter = () => ({ connected: true, mode: 'remote', centerId: 'shared-center', environment: 'production', physicalSupported: true, lotteryCatalogSupported: true });
const fulfillment = () => ({ ready: true, centerId: 'shared-center', environment: 'production' });
const activities = [
  {
    name: '此刻在地', file: 'LotteryManager.jsx', draft: lotteryDraft, problem: lotteryConnectionProblem,
    snapshot: revision => ({ campaignId: 'bubble-race-2026-500', revision, enabled: false, mode: 'fixed', fulfillment: fulfillment(),
      prizes: [{ id: 'cap', name: '赛事帽', kind: 'physical', quota: 200, allocated: 2, weightBps: 10000 }], audit: [] }),
    edit: draft => { draft.quantities.cap = '233'; },
  },
  {
    name: '山野有约', file: 'ScarfManager.jsx', draft: scarfDraft, problem: scarfConnectionProblem,
    snapshot: revision => ({ campaignId: 'scarf-xhs-50-v1', revision, fulfillment: fulfillment(),
      campaign: { title: '山野有约', venue: '赛事展位', enabled: false, winProbabilityBps: 5000, startsAt: null, endsAt: null, redeemEndsAt: null },
      inventory: { total: 200, awarded: 2, remaining: 198 }, prize: { id: 'scarf', name: '魔术头巾', imageUrl: '', product: { id: 'product-scarf', name: '头巾', sku: 'SCARF', barcode: 'SCARF' } }, audit: [] }),
    edit: draft => { draft.title = '待保存的活动名称'; },
  },
];

function harness(activity, handlers = {}) {
  const source = readFileSync(new URL('../src/' + activity.file, import.meta.url), 'utf8');
  const start = source.indexOf('  async function load(');
  const end = source.indexOf('  useEffect(', start);
  assert.ok(start >= 0 && end > start, 'Execute the current component load function, not a test copy');
  const snapshot = activity.snapshot(1), draft = activity.draft(snapshot);
  activity.edit(draft);
  const state = { connection: { configured: true }, snapshot, draft, coupon: verifiedCenter(), couponError: '', error: '', loading: false, confirmed: true };
  const calls = [];
  const context = {
    snapshot, alive: { current: true }, generation: { current: 0 }, lotteryDraft, scarfDraft,
    call: async action => { calls.push(action); return handlers.call ? handlers.call(action) : action === 'config' ? { configured: true } : activity.snapshot(2); },
    sqbCall: async action => { calls.push(action); assert.equal(action, 'coupon-config'); return handlers.coupon ? handlers.coupon() : verifiedCenter(); },
  };
  for (const field of Object.keys(state)) context['set' + field[0].toUpperCase() + field.slice(1)] = value => { state[field] = value; };
  const load = vm.runInNewContext(source.slice(start, end) + '\nload;', context, { filename: activity.file });
  return { state, calls, load, readyProblem: () => activity.problem(state.snapshot, state.coupon) };
}

for (const activity of activities) {
  for (const failure of ['config', 'snapshot']) {
    test(`${activity.name}: failed ${failure} refresh clears previous redemption verification and preserves unsaved edits`, async () => {
      const message = failure + ' temporarily unavailable';
      const h = harness(activity, { call: action => { if (action === failure) throw new Error(message); return { configured: true }; } });
      const oldSnapshot = h.state.snapshot, unsavedDraft = h.state.draft;
      assert.equal(h.readyProblem(), '');
      const pending = h.load();
      assert.equal(h.state.coupon, null, 'Old success must stop advertising readiness before the request completes');
      assert.equal(h.state.loading, true);
      assert.ok(h.readyProblem(), 'The resume readiness guard must reject an unverified connection');
      await pending;
      assert.equal(h.state.error, message);
      assert.equal(h.state.loading, false);
      assert.equal(h.state.snapshot, oldSnapshot, 'Keep the last activity information available');
      assert.equal(h.state.draft, unsavedDraft, 'Do not discard unsaved prize or campaign edits');
      assert.equal(h.state.coupon, null);
      assert.ok(h.readyProblem());
      assert.deepEqual(h.calls, failure === 'config' ? ['config'] : ['config', 'snapshot']);
    });
  }

  test(`${activity.name}: a coupon connection failure does not discard the successfully refreshed cloud configuration`, async () => {
    const latest = activity.snapshot(2), message = 'coupon connection temporarily unavailable';
    const h = harness(activity, {
      call: action => action === 'config' ? { configured: true } : latest,
      coupon: () => { throw new Error(message); },
    });
    await h.load();
    assert.equal(h.state.snapshot, latest);
    assert.deepEqual(h.state.draft, activity.draft(latest));
    assert.equal(h.state.connection.configured, true);
    assert.equal(h.state.loading, false);
    assert.equal(h.state.error, '', 'A separate coupon failure must not turn a configurable cloud activity into a load error');
    assert.equal(h.state.couponError, message);
    assert.equal(h.state.coupon, null);
    assert.equal(h.state.confirmed, false);
    assert.ok(h.readyProblem());
    assert.deepEqual(h.calls, ['config', 'snapshot', 'coupon-config']);
  });

  test(`${activity.name}: a later successful refresh restores readiness only after verifying the coupon center again`, async () => {
    let fail = true;
    const h = harness(activity, { coupon: () => { if (fail) throw new Error('offline'); return verifiedCenter(); } });
    await h.load();
    assert.ok(h.readyProblem());
    fail = false;
    const pending = h.load();
    assert.equal(h.state.coupon, null);
    await pending;
    assert.equal(h.readyProblem(), '');
    assert.equal(h.state.couponError, '');
    assert.equal(h.state.error, '');
    assert.equal(h.state.loading, false);
  });
}

test('此刻在地: a revision conflict while preserving drafts cannot retain the previously verified redemption identity', async () => {
  const h = harness(activities[0]), oldSnapshot = h.state.snapshot, unsavedDraft = h.state.draft;
  await h.load(true);
  assert.match(h.state.error, /云端配置已被其他操作修改/);
  assert.equal(h.state.snapshot, oldSnapshot);
  assert.equal(h.state.draft, unsavedDraft);
  assert.equal(h.state.coupon, null);
  assert.ok(h.readyProblem());
  assert.equal(h.state.loading, false);
});
