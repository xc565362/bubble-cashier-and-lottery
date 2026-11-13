const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
// Exported historical maintenance source. Review deployment/README.md before use.
function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) throw new Error('Set ' + name + ' explicitly before running this historical maintenance script.');
  return value.trim();
}
function requiredHttpsOrigin(name) {
  const value = requiredEnv(name);
  let url;
  try { url = new URL(value); } catch { throw new Error(name + ' must be a valid HTTPS origin.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(name + ' must be an HTTPS origin without credentials, path or query.');
  return url.origin;
}
const expectedCenterUrl = requiredHttpsOrigin('BUBBLE_EXPECTED_CENTER_URL');
const expectedCenterId = requiredEnv('BUBBLE_EXPECTED_CENTER_ID');
const base = path.resolve(process.argv[2]);
const saved = JSON.parse(fs.readFileSync(path.join(base, 'cloudbaserc.before.json')));
const config = JSON.parse(saved.functions.find(fn => fn.name === 'lottery').envVariables.LOTTERY_MANAGEMENT_CENTER_JSON);
const { campaign, prizes } = require('../lottery-backend/config.js');
const cutoff = new Date(campaign.redemptionEndsAt).toISOString();
assert.equal(cutoff, '2026-09-27T10:00:00.000Z');
assert.equal(config.baseUrl.replace(/\/$/, ''), expectedCenterUrl);
assert.equal(config.centerId, expectedCenterId);
async function request(route, body) {
  const response = await fetch(new URL(route, config.baseUrl), { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + config.adminToken, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  assert.ok(response.ok && result.ok === true, 'Coupon request failed: ' + (result.code || response.status));
  return result.data;
}
async function main() {
  const info = await request('/v1/info');
  assert.equal(info.centerId, expectedCenterId);
  assert.equal(info.centerId, config.centerId); assert.equal(info.role, 'admin'); assert.equal(info.environment, 'production');
  assert.ok(info.capabilities.includes('redemption-deadline-v1'));
  for (const state of ['RESERVED', 'PAYMENT_PENDING']) assert.equal((await request('/v1/coupons?state=' + state)).total, 0, 'Redemption in progress');
  const beforeFile = path.join(base, 'coupon-campaigns.before.json');
  const current = await request('/v1/campaigns');
  if (!fs.existsSync(beforeFile)) fs.writeFileSync(beforeFile, JSON.stringify(current, null, 2), { mode: 0o600, flag: 'wx' });
  const before = JSON.parse(fs.readFileSync(beforeFile));
  const ids = prizes.map(p => config.prizes[p.id]);
  assert.equal(new Set(ids).size, 8);
  for (const p of prizes) {
    const c = current.find(c => c.id === config.prizes[p.id]);
    assert.ok(c); assert.equal(c.kind || 'cash', p.kind);
    assert.equal(Date.parse(c.startsAt), campaign.startsAt); assert.equal(Date.parse(c.expiresAt), campaign.redeemEndsAt);
    if (p.kind === 'physical') { assert.equal(c.physical.prizeId, p.id); assert.equal(c.redemptionEnabled, false); }
    else assert.equal(c.amountCents, p.amount * 100);
  }
  const result = await request('/v1/campaigns/deadline', { requestId: 'bubble-deadline-20260927-1800-v1', campaignIds: ids,
    redemptionEndsAt: cutoff, reason: 'User confirmed September 27 18:00 Beijing closes all physical redemption, cash coupons and new draws.' });
  assert.equal(result.campaigns.length, 8);
  const after = await request('/v1/campaigns');
  assert.equal(after.length, before.length);
  for (const old of before) {
    const row = after.find(c => c.id === old.id);
    if (ids.includes(old.id)) {
      assert.equal(row.redemptionEndsAt, cutoff);
      const clean = value => { const { redemptionEndsAt, lastDeadlineAdjustment, ...rest } = value; return rest; };
      assert.deepEqual(clean(row), clean(old), 'Unexpected campaign change');
    } else assert.deepEqual(row, old, 'Unrelated campaign changed');
  }
  fs.writeFileSync(path.join(base, 'coupon-campaigns.after.json'), JSON.stringify(after, null, 2), { mode: 0o600 });
  const report = { at: new Date().toISOString(), centerId: info.centerId, cutoff, campaignsUpdated: ids.length, existingExpiryAndIssuancePreserved: true, physicalCutoverActivated: false };
  fs.writeFileSync(path.join(base, 'deadline-coupon-verified.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
