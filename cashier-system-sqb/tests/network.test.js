import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createPublicIpResolver } = require('../payments/network.cjs');
const primary = 'https://api.ipify.org?format=json';
const backup = 'https://checkip.amazonaws.com/';

test('public IP discovery allows a bounded ten-second deadline for slow networks', async (t) => {
  const durations = [];
  t.mock.method(AbortSignal, 'timeout', duration => { durations.push(duration); return new AbortController().signal; });
  const resolve = createPublicIpResolver(async url => {
    if (url === primary) throw new TypeError('offline');
    return new Response('8.8.4.4\n');
  });
  assert.equal(await resolve({ fresh: true }), '8.8.4.4');
  assert.deepEqual(durations, [10000, 10000]);
});

test('a failed primary lookup falls back over HTTPS using the same transport', async () => {
  const calls = [];
  const resolve = createPublicIpResolver(async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    if (url === primary) throw new TypeError('unreachable');
    assert.equal(url, backup);
    return new Response('8.8.4.4\n');
  });
  assert.equal(await resolve({ fresh: true }), '8.8.4.4');
  assert.deepEqual(calls, [primary, backup]);
  assert.equal(await resolve(), '8.8.4.4');
  assert.equal(calls.length, 2);
});

test('timeouts, HTTP errors and invalid primary results all trigger fallback', async () => {
  for (const failure of [
    () => { throw new DOMException('timed out', 'TimeoutError'); },
    () => { throw new DOMException('aborted', 'AbortError'); },
    () => new Response('blocked', { status: 503 }),
    () => new Response('redirect', { status: 302 }),
    () => new Response('<html>login</html>'),
    () => new Response('x'.repeat(513)),
    () => new Response('{"ip":"192.168.1.2"}'),
    () => new Response('{"ip":"::1"}'),
  ]) {
    let calls = 0;
    const resolve = createPublicIpResolver(async (url) => {
      calls++;
      return url === primary ? failure() : new Response('8.8.4.4\n');
    });
    assert.equal(await resolve({ fresh: true }), '8.8.4.4');
    assert.equal(calls, 2);
  }
});

test('neither provider can supply private, reserved, IPv6 or injected addresses', async () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.1.2', '100.64.0.1', '192.168.1.1', '203.0.113.1', '::1', '8.8.4.4\r\nInjected: 1', '8.8.4.4,1.1.1.1']) {
    const resolve = createPublicIpResolver(async (url) => new Response(url === primary ? JSON.stringify({ ip }) : ip));
    await assert.rejects(resolve(), (error) => {
      assert.equal(error.code, 'PUBLIC_IP_UNAVAILABLE');
      assert.deepEqual(error.ipChecks, [{ provider: 'ipify', code: 'INVALID_RESPONSE' }, { provider: 'AWS', code: 'INVALID_RESPONSE' }]);
      return true;
    });
  }
});

test('a failed fresh lookup clears the old cached IP instead of reusing it', async () => {
  let online = true;
  let ip = '8.8.4.4';
  const calls = [];
  const resolve = createPublicIpResolver(async (url) => {
    calls.push(url);
    if (!online) throw new TypeError('offline');
    return new Response(JSON.stringify({ ip }));
  });
  assert.equal(await resolve(), '8.8.4.4');
  online = false;
  await assert.rejects(resolve({ fresh: true }), { code: 'PUBLIC_IP_UNAVAILABLE' });
  await assert.rejects(resolve(), { code: 'PUBLIC_IP_UNAVAILABLE' });
  assert.equal(calls.length, 5);
  online = true; ip = '1.1.1.1';
  assert.equal(await resolve({ fresh: true }), '1.1.1.1');
});

test('query cache expires after 30 seconds, purchases always refresh', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  let calls = 0;
  const resolve = createPublicIpResolver(async () => { calls++; return new Response('{"ip":"8.8.4.4"}'); });
  await resolve();
  t.mock.timers.tick(29999);
  await resolve(); assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await resolve(); assert.equal(calls, 2);
  await resolve({ fresh: true }); assert.equal(calls, 3);
});

test('all-provider failures expose only safe diagnostic categories', async () => {
  const resolve = createPublicIpResolver(async (url) => {
    if (url === primary) throw new DOMException('secret detail', 'TimeoutError');
    throw new Error('secret detail');
  });
  await assert.rejects(resolve(), (error) => {
    assert.equal(error.code, 'PUBLIC_IP_UNAVAILABLE');
    assert.deepEqual(error.ipChecks, [{ provider: 'ipify', code: 'TIMEOUT' }, { provider: 'AWS', code: 'NETWORK_ERROR' }]);
    assert.ok(!JSON.stringify(error).includes('secret detail'));
    assert.ok(!error.message.includes('secret detail'));
    return true;
  });
});
