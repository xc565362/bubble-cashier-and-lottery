import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createLotteryBridge } = require('../payments/lottery.cjs');
const { createScarfBridge } = require('../payments/scarf.cjs');
const { createCouponBridge } = require('../coupons/bridge.cjs');
const { createService } = require('../payments/service.cjs');

function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lottery-records-bridge-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
for (const [name, factory, campaignId] of [['lottery', createLotteryBridge, 'isolated-original'], ['scarf', createScarfBridge, 'scarf-xhs-50-v1']]) {
  test(`${name}: records use protected signed management transport with scoped identity and no connection mutations`, async t => {
    const directory = temp(t), secret = 'a'.repeat(64), config = { url: `https://isolated.invalid/api/${name}-management`, key: 'protected:' + secret, campaignId };
    const file = path.join(directory, `${name}-management.json`); fs.writeFileSync(file, JSON.stringify(config));
    const before = fs.readFileSync(file, 'utf8'); const calls = [];
    let mismatch = false;
    const bridge = factory({ directory, unprotect: value => value.slice(10), fetchFn: async (url, init) => {
      assert.equal(url, config.url); assert.equal(init.redirect, 'error'); const headers = init.headers;
      assert.equal(headers['X-Lottery-Signature'], crypto.createHmac('sha256', secret).update(headers['X-Lottery-Time'] + '\n' + headers['X-Lottery-Nonce'] + '\n' + init.body).digest('hex'));
      assert.ok(!init.body.includes(secret)); calls.push(JSON.parse(init.body));
      return Response.json({ ok: true, data: { service: 'lottery-records', version: 1, campaignId: mismatch ? 'other' : campaignId, items: [] } });
    } });
    await bridge.dispatch('records', { limit: 20, cursor: 'opaque-cursor', outcome: 'lost' });
    assert.deepEqual(calls[0], { campaignId, action: 'records', payload: { limit: 20, cursor: 'opaque-cursor', outcome: 'lost', participantRef: '' } });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    for (const input of [{ limit: 51 }, { limit: '20' }, { outcome: 'whatever' }, { cursor: 'x'.repeat(4097) }, { adminKey: secret }, []]) await assert.rejects(bridge.dispatch('records', input), /查询参数/);
    assert.equal(calls.length, 1); mismatch = true;
    await assert.rejects(bridge.dispatch('records'), /身份或格式不匹配/);
  });

  test(`${name}: saved draw reads remain available during unresolved checkout; configuration mutations remain blocked`, async t => {
    const directory = temp(t), config = { url: `https://isolated.invalid/api/${name}-management`, key: 'a'.repeat(64), campaignId };
    fs.writeFileSync(path.join(directory, `${name}-management.json`), JSON.stringify(config));
    fs.writeFileSync(path.join(directory, 'payments.json'), JSON.stringify({ pending: { id: 'pending', state: 'pending', acknowledged: false } }));
    const service = createService({ directory, fetchFn: async () => Response.json({ ok: true, data: { service: 'lottery-records', version: 1, campaignId, items: [] } }) });
    try {
      assert.equal((await service.dispatch(`${name}-records`)).campaignId, campaignId);
      await assert.rejects(service.dispatch(`${name}-update`), /收退款和券占用/);
    } finally { service.close(); }
  });
}

test('coupon pending snapshot never contacts coupon/payment service or rewrites historical journal and returns a detached copy', async t => {
  const directory = temp(t), file = path.join(directory, 'coupon-transactions.json');
  const data = { one: { id: 'one', finished: false, coupon: { state: 'RESERVED', name: '隔离奖品', code: 'private-coupon-code', owner: 'private-owner' }, binding: { private: 'private-binding' } }, done: { id: 'done', finished: true } };
  fs.writeFileSync(file, JSON.stringify(data)); const before = fs.readFileSync(file, 'utf8');
  const bridge = createCouponBridge({ directory, fetchFn: () => { throw new Error('No network allowed for pending'); } });
  try {
    const pending = await bridge.dispatch('pending'); assert.equal(pending.length, 1); assert.equal(pending[0].canRelease, true);
    assert.ok(!JSON.stringify(pending).includes('private-'), 'read-only recovery cannot expose redeemable codes or complete order bindings');
    pending[0].coupon.state = 'REDEEMED';
    assert.equal((await bridge.dispatch('pending'))[0].coupon.state, 'RESERVED');
    assert.equal(fs.readFileSync(file, 'utf8'), before); assert.deepEqual(fs.readdirSync(directory), ['coupon-transactions.json']);
  } finally { bridge.close(); }
});
