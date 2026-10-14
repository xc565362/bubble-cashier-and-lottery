'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPoolManagement } = require('../server/cloudfunctions/bubble-h5-gateway/vendor/lottery/pool-management.cjs');
const { createService } = require('../server/cloudfunctions/bubble-h5-gateway/vendor/lottery/service.js');

async function fixture() {
  let rows = new Map(), queue = Promise.resolve();
  const store = { transaction(fn) {
    const run = queue.then(async () => {
      const copy = structuredClone(rows);
      const result = await fn({
        get: async (table, id) => structuredClone(copy.get(table + ':' + id)),
        set: async (table, id, value) => copy.set(table + ':' + id, structuredClone(value)),
      });
      rows = copy;
      return result;
    });
    queue = run.catch(() => {});
    return run;
  } };
  const now = () => 1800000000000;
  const campaign = { id: 'isolated-rules-test', title: '隔离说明测试', enabled: false,
    startsAt: now() - 1000, endsAt: now() + 100000, redeemEndsAt: now() + 200000,
    inventory: { version: 1, total: 4, quantities: { cap: 4 } } };
  const prizes = [{ id: 'cap', name: '测试帽子', kind: 'physical', probability: 100 }];
  const service = createService({ store, campaign, prizes, now, entryId: id => id, adminIds: ['test-admin'] });
  await service('initializePool', {}, 'test-admin');
  // Text editing must not require a healthy external coupon center.
  const pool = createPoolManagement({ store, campaign, prizes, now, getCenter: async () => { throw new Error('Offline fixture'); } });
  const input = async (rest = {}) => ({ operation: 'configure', requestId: crypto.randomUUID(),
    expectedRevision: (await pool.snapshot()).revision, reason: '隔离说明测试', mode: 'inventory',
    quantities: { cap: 4 }, weightsBps: { cap: 10000 }, ...rest });
  const configure = async rest => pool.update(await input(rest));
  const state = () => service('state', {}, 'test-visitor');
  return { store, pool, campaign, input, configure, state, rows: () => structuredClone(rows) };
}

test('old settings default to empty instructions without writes; saved multiline text reaches both snapshot and H5 state with compact audit', async () => {
  const f = await fixture(), before = f.rows();
  const initial = await f.pool.snapshot();
  assert.equal(initial.rulesText, '');
  assert.ok(initial.capabilities.includes('rules-text-v1'));
  assert.equal((await f.state()).campaign.rulesText, '');
  assert.deepEqual(f.rows(), before);
  const normalized = '第一行\n第二行\n第三行\t说明';
  await f.configure({ rulesText: ' \r\n第一行\r\n第二行\r第三行\t说明\r\n ' });
  const snapshot = await f.pool.snapshot();
  assert.equal(snapshot.rulesText, normalized);
  assert.equal((await f.state()).campaign.rulesText, normalized);
  const audit = snapshot.audit[0];
  assert.equal(audit.rulesTextChanged, true);
  assert.deepEqual(audit.after.rulesTextSummary, { length: normalized.length, sha256: crypto.createHash('sha256').update(normalized).digest('hex') });
  assert.equal(audit.before.rulesTextSummary.length, 0);
  assert.equal(Object.hasOwn(audit.before, 'rulesText'), false);
  assert.equal(Object.hasOwn(audit.after, 'rulesText'), false);
  assert.deepEqual(f.rows().get('pools:' + f.campaign.id + ':stock'), before.get('pools:' + f.campaign.id + ':stock'));
  assert.deepEqual((await f.state()).prizes.map(p => [p.id, p.quantity]), [['cap', 4]]);
});

test('omitting instructions preserves them, clearing restores default and historical saved settings remain readable', async () => {
  const f = await fixture();
  await f.configure({ rulesText: '请先核对现场说明。' });
  await f.configure({});
  assert.equal((await f.pool.snapshot()).rulesText, '请先核对现场说明。');
  assert.equal((await f.pool.snapshot()).audit[0].rulesTextChanged, false);
  await f.configure({ rulesText: '' });
  assert.equal((await f.state()).campaign.rulesText, '');
  await f.configure({ rulesText: '稍后清空' });
  await f.configure({ rulesText: ' \r\n\t ' });
  assert.equal((await f.pool.snapshot()).rulesText, '');
  await f.store.transaction(async tx => {
    const settings = await tx.get('pools', f.campaign.id + ':management');
    delete settings.rulesText;
    await tx.set('pools', f.campaign.id + ':management', settings);
  });
  const before = f.rows();
  assert.equal((await f.pool.snapshot()).rulesText, '');
  assert.equal((await f.state()).campaign.rulesText, '');
  assert.deepEqual(f.rows(), before);
});

test('invalid instructions never change settings and length is counted after newline normalization and outer trimming', async () => {
  const f = await fixture();
  const maximum = '好'.repeat(2500) + '\r\n' + '好'.repeat(2499);
  await f.configure({ rulesText: '\t ' + maximum + ' \r\n' });
  assert.equal((await f.pool.snapshot()).rulesText.length, 5000);
  const invalid = [undefined, null, 123, true, {}, [], '好'.repeat(5001), '😀'.repeat(2501),
    '\u000b说明', '说明\u000c', ...[0, 1, 8, 14, 31, 127, 128, 159].map(code => '说明' + String.fromCharCode(code))];
  for (const rulesText of invalid) {
    const before = f.rows();
    await assert.rejects(f.configure({ rulesText }), { code: 'INVALID_CONFIG' });
    assert.deepEqual(f.rows(), before);
  }
  await f.configure({ rulesText: '😀'.repeat(2500) });
  assert.equal((await f.pool.snapshot()).rulesText.length, 5000);
});

test('instruction changes keep pause, revision and retry protections and cannot hide inside pause operations', async () => {
  const f = await fixture();
  f.campaign.enabled = true;
  let before = f.rows();
  await assert.rejects(f.configure({ rulesText: '活动进行时不能修改' }), { code: 'POOL_ACTIVE' });
  assert.deepEqual(f.rows(), before);
  await f.pool.update(await f.input({ operation: 'pause' }));
  const change = await f.input({ rulesText: '暂停后保存' });
  await f.pool.update(change);
  assert.equal((await f.pool.update(change)).duplicate, true);
  before = f.rows();
  await assert.rejects(f.pool.update({ ...change, requestId: crypto.randomUUID(), rulesText: '旧版本覆盖' }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(f.pool.update({ ...change, rulesText: '同请求篡改' }), { code: 'INVALID_CONFIG' });
  await assert.rejects(f.pool.update(await f.input({ operation: 'pause', rulesText: '不能绕过配置' })), { code: 'INVALID_CONFIG' });
  assert.deepEqual(f.rows(), before);
  assert.equal((await f.state()).campaign.rulesText, '暂停后保存');
});
