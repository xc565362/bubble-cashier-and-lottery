import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createPublicIpResolver } = require('../payments/network.cjs');
const ipify = 'https://api.ipify.org?format=json';
const aws = 'https://checkip.amazonaws.com/';
const ipip = 'https://myip.ipip.net';
const allProviders = [aws, ipify, ipip].sort();
const byProvider = (checks) => [...checks].sort((a, b) => a.provider.localeCompare(b.provider));

test('public IP discovery races providers with a bounded four-second deadline', async (t) => {
  const durations = [];
  t.mock.method(AbortSignal, 'timeout', duration => { durations.push(duration); return new AbortController().signal; });
  const resolve = createPublicIpResolver(async url => {
    if (url === ipify) throw new TypeError('offline');
    return new Response('8.8.4.4\n');
  });
  assert.equal(await resolve({ fresh: true }), '8.8.4.4');
  assert.deepEqual(durations, [4000, 4000, 4000]);
});

test('all providers are probed in parallel and the first valid answer wins', async (t) => {
  const calls = [];
  const resolve = createPublicIpResolver(async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    if (url === ipify) throw new TypeError('unreachable');
    return new Response('8.8.4.4\n');
  });
  assert.equal(await resolve({ fresh: true }), '8.8.4.4');
  assert.deepEqual([...calls].sort(), allProviders);
  assert.equal(await resolve(), '8.8.4.4');
  assert.equal(calls.length, 3); // cache hit, no new probes
});

test('timeouts, HTTP errors and invalid primary results fall back to a healthy peer', async () => {
  for (const failure of [
    () => { throw new DOMException('timed out', 'TimeoutError'); },
    () => { throw new DOMException('aborted', 'AbortError'); },
    () => new Response('blocked', { status: 503 }),
    () => new Response('redirect', { status: 302 }),
    () => new Response('<html>login</html>'),
    () => new Response('x'.repeat(513)),
    () => new Response('{"ip":"192.168.1.2"}'),
    () => new Response('{"ip":"::1"}'),
    () => new Response('8.8.4.4\r\nInjected: 1'),
  ]) {
    let calls = 0;
    const resolve = createPublicIpResolver(async (url) => {
      calls++;
      return url === ipify ? failure() : new Response('8.8.4.4\n');
    });
    assert.equal(await resolve({ fresh: true }), '8.8.4.4');
    assert.equal(calls, 3);
  }
});

test('no provider may supply private, reserved or IPv6 addresses', async () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.1.2', '100.64.0.1', '192.168.1.1', '203.0.113.1', '::1', '8.8.4.4,1.1.1.1']) {
    const resolve = createPublicIpResolver(async (url) => new Response(url === ipify ? JSON.stringify({ ip }) : ip));
    await assert.rejects(resolve(), (error) => {
      assert.equal(error.code, 'PUBLIC_IP_UNAVAILABLE');
      assert.deepEqual(byProvider(error.ipChecks), byProvider([
        { provider: 'ipify', code: 'INVALID_RESPONSE' },
        { provider: 'AWS', code: 'INVALID_RESPONSE' },
        { provider: 'ipip', code: 'INVALID_RESPONSE' },
      ]));
      return true;
    });
  }
});

test('a failed fresh lookup clears the old cached IP instead of reusing it', async () => {
  let online = true;
  let ip = '8.8.4.4';
  let calls = 0;
  const resolve = createPublicIpResolver(async (url) => {
    calls++;
    if (!online) throw new TypeError('offline');
    return new Response(JSON.stringify({ ip }));
  });
  assert.equal(await resolve(), '8.8.4.4');
  online = false;
  await assert.rejects(resolve({ fresh: true }), { code: 'PUBLIC_IP_UNAVAILABLE' });
  await assert.rejects(resolve(), { code: 'PUBLIC_IP_UNAVAILABLE' });
  assert.equal(calls, 9); // three parallel probes per lookup
  online = true; ip = '1.1.1.1';
  assert.equal(await resolve({ fresh: true }), '1.1.1.1');
});

test('query cache expires after 30 seconds, purchases always refresh', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  let calls = 0;
  const resolve = createPublicIpResolver(async () => { calls++; return new Response('{"ip":"8.8.4.4"}'); });
  await resolve();
  assert.equal(calls, 3);
  t.mock.timers.tick(29999);
  await resolve(); assert.equal(calls, 3);
  t.mock.timers.tick(1);
  await resolve(); assert.equal(calls, 6);
  await resolve({ fresh: true }); assert.equal(calls, 9);
});

test('all-provider failures expose only safe diagnostic categories', async () => {
  const resolve = createPublicIpResolver(async (url) => {
    if (url === ipify) throw new DOMException('secret detail', 'TimeoutError');
    throw new Error('secret detail');
  });
  await assert.rejects(resolve(), (error) => {
    assert.equal(error.code, 'PUBLIC_IP_UNAVAILABLE');
    assert.deepEqual(byProvider(error.ipChecks), byProvider([
      { provider: 'ipify', code: 'TIMEOUT' },
      { provider: 'AWS', code: 'NETWORK_ERROR' },
      { provider: 'ipip', code: 'NETWORK_ERROR' },
    ]));
    assert.ok(!JSON.stringify(error).includes('secret detail'));
    assert.ok(!error.message.includes('secret detail'));
    return true;
  });
});
