'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {createService, createCloudStore, CAMPAIGN_ID, COLLECTIONS} = require('../server/cloudfunctions/bubble-scarf-gateway/service.cjs');
const {createScarfAdapter, ENTRY_PAGE} = require('../server/cloudfunctions/bubble-scarf-gateway/adapter.cjs');
const ADMIN = 'oStaff_TrustedAdmin0001';
const USER = 'oVisitor_Identity00001';
const OTHER = 'oVisitor_Identity00002';
const START = 1800000000000;

// Serializable transactional fixture: copies are committed together or entirely discarded.
// CloudBase itself is still an external deployment/integration test requirement.
function memoryStore() {
  let rows = new Map(), tail = Promise.resolve(), failCollection = '';
  const key = (collection, id) => collection + '/' + id;
  return {
    seed(collection, id, data) { rows.set(key(collection, id), structuredClone(data)); },
    rows(collection) { return [...rows].filter(([id]) => id.startsWith(collection + '/')).map(([, data]) => structuredClone(data)); },
    get(collection, id) { return structuredClone(rows.get(key(collection, id)) || null); },
    failOn(collection) { failCollection = collection; },
    transaction(job) {
      const pending = tail.then(async () => {
        const snapshot = new Map([...rows].map(([id, data]) => [id, structuredClone(data)]));
        const result = await job({
          get: async (collection, id) => structuredClone(snapshot.get(key(collection, id)) || null),
          set: async (collection, id, data) => { if (collection === failCollection) throw new Error('Simulated database write failure'); snapshot.set(key(collection, id), structuredClone(data)); }
        });
        rows = snapshot;
        return result;
      });
      tail = pending.catch(() => {});
      return pending;
    }
  };
}
function fixture({coin = 0, stock = 200, initialized = true} = {}) {
  const store = memoryStore();
  let timestamp = START, sequence = 0, calls = 0;
  const campaign = {enabled: true, startsAt: START - 1000, endsAt: START + 3600000, redeemEndsAt: START + 7200000};
  const inventory = {total: 200, remaining: stock, awarded: 200 - stock, redeemed: 0};
  if (initialized) { store.seed(COLLECTIONS.campaigns, CAMPAIGN_ID, campaign); store.seed(COLLECTIONS.inventory, CAMPAIGN_ID, inventory); }
  const service = createService({store, adminOpenIds: [ADMIN], now: () => timestamp, random: () => { calls++; return typeof coin === 'function' ? coin(calls) : coin; }, randomCode: () => (++sequence).toString(16).toUpperCase().padStart(16, '0')});
  return {store, service, campaign, inventory, setTime: value => { timestamp = value; }, now: () => timestamp, calls: () => calls,
    grant: () => service('grant', {}, ADMIN), draw: (inviteCode, who = USER) => service('draw', {inviteCode}, who), state: (who = USER) => service('state', {}, who)};
}

test('0 wins and 1 loses; no front-end result or probability input is accepted', async () => {
  for (const coin of [0, 1]) {
    const f = fixture({coin}), invite = await f.grant(), result = await f.draw(invite.inviteCode);
    assert.equal(result.entry.outcome, coin === 0 ? 'won' : 'lost');
    assert.equal(result.inventory.remaining, coin === 0 ? 199 : 200);
    assert.equal(result.entry.code !== undefined, coin === 0);
    await assert.rejects(f.service('draw', {inviteCode: invite.inviteCode, won: true}, OTHER), {code: 'INVALID_REQUEST'});
  }
});

test('lost results persist and repeated calls never roll again or consume another invite', async () => {
  const f = fixture({coin: 1}), first = await f.grant(), other = await f.grant();
  const drawn = await f.draw(first.inviteCode);
  assert.deepEqual((await f.state()).entry, drawn.entry);
  assert.deepEqual((await f.draw(other.inviteCode)).entry, drawn.entry);
  assert.equal(f.calls(), 1);
  assert.equal(f.store.rows(COLLECTIONS.invites).filter(row => row.consumedBy).length, 1);
  assert.equal(f.store.rows(COLLECTIONS.entries).length, 1);
});

test('concurrent requests for the same user award exactly once', async () => {
  const f = fixture(), a = await f.grant(), b = await f.grant();
  const results = await Promise.all(Array.from({length: 15}, (_, i) => f.draw(i % 2 ? a.inviteCode : b.inviteCode)));
  assert.equal(new Set(results.map(result => result.entry.code)).size, 1);
  assert.equal(f.calls(), 1);
  assert.equal(f.store.get(COLLECTIONS.inventory, CAMPAIGN_ID).remaining, 199);
  assert.equal(f.store.rows(COLLECTIONS.invites).filter(row => row.consumedBy).length, 1);
});

test('a one-time invite shared by two users can produce only one entry', async () => {
  const f = fixture(), invite = await f.grant();
  const results = await Promise.allSettled([f.draw(invite.inviteCode, USER), f.draw(invite.inviteCode, OTHER)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.find(row => row.status === 'rejected').reason.code, 'INVITE_USED');
  assert.equal(f.store.rows(COLLECTIONS.entries).length, 1);
  assert.equal(f.calls(), 1);
});

test('concurrent winners competing for the last scarf do not oversell or consume losing transaction eligibility', async () => {
  const f = fixture({stock: 1}), a = await f.grant(), b = await f.grant();
  const results = await Promise.allSettled([f.draw(a.inviteCode, USER), f.draw(b.inviteCode, OTHER)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.find(row => row.status === 'rejected').reason.code, 'SOLD_OUT');
  assert.equal(f.store.get(COLLECTIONS.inventory, CAMPAIGN_ID).remaining, 0);
  assert.equal(f.store.rows(COLLECTIONS.entries).length, 1);
  assert.equal(f.store.rows(COLLECTIONS.invites).filter(row => row.consumedBy).length, 1);
  assert.equal(f.calls(), 1);
});

test('zero stock refuses before sampling and does not create losing results', async () => {
  const f = fixture(), invite = await f.grant();
  f.store.seed(COLLECTIONS.inventory, CAMPAIGN_ID, {total: 200, remaining: 0, awarded: 200, redeemed: 0});
  await assert.rejects(f.draw(invite.inviteCode), {code: 'SOLD_OUT'});
  assert.equal(f.calls(), 0);
  assert.equal(f.store.rows(COLLECTIONS.entries).length, 0);
  assert.equal(f.store.rows(COLLECTIONS.invites)[0].consumedBy, null);
});

test('missing configuration returns informative state and rejects grant/draw without writes', async () => {
  const f = fixture({initialized: false}), state = await f.state();
  assert.equal(state.campaign.title, '山野有约');
  assert.equal(state.campaign.venue, '赛事现场 · Bubble 展位');
  assert.equal(state.campaign.startsAt, null);
  assert.deepEqual(state.inventory, {total: 200, remaining: null});
  assert.deepEqual(state.availability, {canDraw: false, reason: 'NOT_CONFIGURED'});
  await assert.rejects(f.grant(), {code: 'NOT_CONFIGURED'});
  await assert.rejects(f.draw('A'.repeat(16)), {code: 'NOT_CONFIGURED'});
  assert.equal(f.store.rows(COLLECTIONS.entries).length, 0);
});

test('invalid dates and corrupt stock cannot open the campaign', async () => {
  for (const patch of [{startsAt: null}, {endsAt: START - 2000}, {redeemEndsAt: START + 1000}, {enabled: 'true'}]) {
    const f = fixture(); f.store.seed(COLLECTIONS.campaigns, CAMPAIGN_ID, {...f.campaign, ...patch});
    await assert.rejects(f.grant(), {code: 'NOT_CONFIGURED'});
  }
  for (const patch of [{total: 201}, {remaining: -1}, {awarded: 1}, {redeemed: 1}, {remaining: 199.5}]) {
    const f = fixture(); f.store.seed(COLLECTIONS.inventory, CAMPAIGN_ID, {...f.inventory, ...patch});
    await assert.rejects(f.grant(), {code: 'NOT_CONFIGURED'});
  }
});

test('pause, start and end boundaries reject without consuming the invitation', async () => {
  for (const [change, expected] of [[f => f.store.seed(COLLECTIONS.campaigns, CAMPAIGN_ID, {...f.campaign, enabled: false}), 'PAUSED'], [f => f.setTime(f.campaign.startsAt - 1), 'NOT_STARTED'], [f => f.setTime(f.campaign.endsAt), 'ENDED']]) {
    const f = fixture(), invite = await f.grant(); change(f);
    await assert.rejects(f.draw(invite.inviteCode), {code: expected});
    assert.equal(f.store.rows(COLLECTIONS.invites)[0].consumedBy, null);
    assert.equal(f.calls(), 0);
  }
});

test('expired and guessed invitations fail, and invalid randomness rolls back all state', async () => {
  const f = fixture(), invite = await f.grant(); f.setTime(invite.expiresAt);
  await assert.rejects(f.draw(invite.inviteCode), {code: 'INVITE_EXPIRED'});
  await assert.rejects(f.draw('F'.repeat(16)), {code: 'INVALID_INVITE'});
  const broken = fixture({coin: 0.5}), ticket = await broken.grant();
  await assert.rejects(broken.draw(ticket.inviteCode), {code: 'INVALID_RANDOM'});
  assert.equal(broken.store.rows(COLLECTIONS.entries).length, 0);
  assert.equal(broken.store.rows(COLLECTIONS.invites)[0].consumedBy, null);
});

test('failure partway through a winning transaction rolls back inventory, entry, code and invitation', async () => {
  const f = fixture(), invite = await f.grant(); f.store.failOn(COLLECTIONS.entries);
  await assert.rejects(f.draw(invite.inviteCode), /Simulated database write failure/);
  assert.equal(f.store.get(COLLECTIONS.inventory, CAMPAIGN_ID).remaining, 200);
  assert.equal(f.store.rows(COLLECTIONS.codes).length, 0);
  assert.equal(f.store.rows(COLLECTIONS.entries).length, 0);
  assert.equal(f.store.rows(COLLECTIONS.invites)[0].consumedBy, null);
});

test('grant, lookup and redeem all require server-authorized staff', async () => {
  const f = fixture();
  assert.deepEqual(await f.service('identity', {}, ADMIN), {isAdmin: true});
  assert.deepEqual(await f.service('identity', {}, USER), {isAdmin: false});
  for (const action of ['grant', 'lookup', 'redeem']) await assert.rejects(f.service(action, action === 'grant' ? {} : {code: 'A'.repeat(16)}, USER), {code: 'FORBIDDEN'});
  await assert.rejects(f.service('state', {}, ''), {code: 'UNAUTHENTICATED'});
  await assert.rejects(f.service('identity', {isAdmin: true}, USER), {code: 'INVALID_REQUEST'});
});

test('redemption is atomic, idempotent and strips the credential after use', async () => {
  const f = fixture(), invite = await f.grant(), draw = await f.draw(invite.inviteCode), code = draw.entry.code;
  assert.equal((await f.service('lookup', {code}, ADMIN)).entry.status, 'pending');
  const results = await Promise.all(Array.from({length: 10}, () => f.service('redeem', {code}, ADMIN)));
  for (const result of results) { assert.equal(result.entry.status, 'redeemed'); assert.equal(result.entry.code, undefined); }
  assert.equal(results.filter(result => result.alreadyRedeemed === false).length, 1);
  assert.equal(results.filter(result => result.alreadyRedeemed === true).length, 9);
  assert.equal(f.store.get(COLLECTIONS.inventory, CAMPAIGN_ID).redeemed, 1);
  assert.equal((await f.state()).entry.code, undefined);
  assert.equal(JSON.stringify(results).includes(USER), false);
});

test('redeem remains available after draw end but not at expiry; expired code is hidden', async () => {
  const f = fixture(), invite = await f.grant(), draw = await f.draw(invite.inviteCode), code = draw.entry.code;
  f.setTime(f.campaign.endsAt + 1);
  assert.equal((await f.service('redeem', {code}, ADMIN)).entry.status, 'redeemed');
  const g = fixture(), next = await g.grant(), won = await g.draw(next.inviteCode);
  g.setTime(g.campaign.redeemEndsAt);
  assert.equal((await g.state()).entry.status, 'expired');
  assert.equal((await g.state()).entry.code, undefined);
  await assert.rejects(g.service('redeem', {code: won.entry.code}, ADMIN), {code: 'EXPIRED'});
  assert.equal(g.store.get(COLLECTIONS.inventory, CAMPAIGN_ID).redeemed, 0);
});

test('no original lottery, POS or coupon collection is touched', async () => {
  assert.deepEqual(Object.values(COLLECTIONS).sort(), ['bubble_scarf_campaigns', 'bubble_scarf_codes', 'bubble_scarf_entries', 'bubble_scarf_inventory', 'bubble_scarf_invites']);
  const seen = [], store = {transaction: job => job({get: async (collection) => { seen.push(collection); return null; }, set: async (collection) => { seen.push(collection); }})};
  await createService({store})('state', {}, USER);
  assert.equal(seen.every(collection => collection.startsWith('bubble_scarf_')), true);
});

test('cloud transaction adapter handles missing documents while propagating real database failures', async () => {
  let called = 0;
  const db = {runTransaction: job => { called++; return job({collection: collection => ({doc: id => ({get: async () => { if (id === 'missing') throw new Error('document does not exist'); if (id === 'failure') throw new Error('permission denied'); return {data: {_id: id, answer: 42}}; }, set: async ({data}) => { assert.equal(data.ok, true); }})})}); }};
  const store = createCloudStore(db);
  await store.transaction(async tx => { assert.equal(await tx.get('collection', 'missing'), null); assert.deepEqual(await tx.get('collection', 'existing'), {answer: 42}); await tx.set('collection', 'test', {ok: true}); });
  await assert.rejects(store.transaction(tx => tx.get('collection', 'failure')), /permission denied/);
  assert.equal(called, 2);
});

function fakeCloud() {
  const calls = [];
  return {calls, openapi: {wxacode: {getUnlimited: async options => { calls.push(['qr', options]); return {errCode: 0, buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0])}; }}},
    uploadFile: async value => { calls.push(['upload', value.cloudPath]); return {fileID: 'cloud://test/invite.png'}; },
    getTempFileURL: async value => { calls.push(['url', value]); return {fileList: [{status: 0, fileID: 'cloud://test/invite.png', tempFileURL: 'https://storage.example.test/invite.png?signature=test'}]}; }};
}

test('staff grant produces a release mini-program code for the fixed native page and one-time scene', async () => {
  const f = fixture(), cloud = fakeCloud(), call = createScarfAdapter({cloud, service: f.service, now: f.now});
  const result = await call('grant', {}, ADMIN);
  assert.match(result.inviteQrUrl, /^https:/);
  assert.equal(cloud.calls[0][1].page, ENTRY_PAGE);
  assert.equal(cloud.calls[0][1].scene, 's_' + result.inviteCode);
  assert.equal(cloud.calls[0][1].envVersion, 'release');
  assert.equal(cloud.calls[0][1].checkPath, true);
  assert.equal(cloud.calls[1][1].includes(result.inviteCode), false);
  assert.equal(cloud.calls[2][1].fileList[0].maxAge, 600);
});

test('nonstaff cannot invoke mini-program-code generation; provider failure consumes no draw chance', async () => {
  const f = fixture(), cloud = fakeCloud(), call = createScarfAdapter({cloud, service: f.service, now: f.now});
  await assert.rejects(call('grant', {}, USER), {code: 'FORBIDDEN'});
  assert.equal(cloud.calls.length, 0);
  cloud.openapi.wxacode.getUnlimited = async () => { throw new Error('PRIVATE_PROVIDER_DETAILS'); };
  await assert.rejects(call('grant', {}, ADMIN), error => error.code === 'CODE_NOT_READY' && !error.message.includes('PRIVATE_PROVIDER_DETAILS'));
  assert.equal(f.store.rows(COLLECTIONS.entries).length, 0);
  assert.equal(f.store.get(COLLECTIONS.inventory, CAMPAIGN_ID).remaining, 200);
});

test('invalid provider image and non-HTTPS invitation URL fail safely', async () => {
  for (const configure of [cloud => { cloud.openapi.wxacode.getUnlimited = async () => ({buffer: Buffer.from('{"secret":"not an image"}')}); }, cloud => { cloud.getTempFileURL = async () => ({fileList: [{status: 0, fileID: 'cloud://test/invite.png', tempFileURL: 'http://unsafe.example/invite.png'}]}); }]) {
    const f = fixture(), cloud = fakeCloud(); configure(cloud);
    await assert.rejects(createScarfAdapter({cloud, service: f.service, now: f.now})('grant', {}, ADMIN), {code: 'CODE_NOT_READY'});
  }
});
