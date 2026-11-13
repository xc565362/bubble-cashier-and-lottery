import test from 'node:test';
import assert from 'node:assert/strict';
import { detectOnlineSession, getOnlineSession, onlineHeaders, onlineRequest, onlineTerminalId, setOnlineSession } from '../src/onlineApi.js';

function fixture(t, hostname = 'cashier.example.invalid') {
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
  const events = [];
  globalThis.window = { location: { hostname }, dispatchEvent: event => events.push(event.type) };
  t.after(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow; setOnlineSession(null); });
  return events;
}

test('online detection never falls back to local data for a public host or network failure', async t => {
  fixture(t);
  for (const response of [new Response('Not found', { status: 404 }), new Response('<html>proxy</html>', { headers: { 'content-type': 'text/html' } }), Response.json({ online: false })]) {
    globalThis.fetch = async () => response;
    await assert.rejects(detectOnlineSession());
  }
  globalThis.fetch = async () => { throw new Error('offline fixture'); };
  await assert.rejects(detectOnlineSession(), /offline/);
});

test('local gateway and Vite fallback retain local mode while Electron skips HTTP probing', async t => {
  fixture(t, 'localhost');
  globalThis.fetch = async () => new Response('', { status: 404 }); assert.equal(await detectOnlineSession(), null);
  globalThis.fetch = async () => new Response('<html>Vite</html>', { headers: { 'content-type': 'text/html' } }); assert.equal(await detectOnlineSession(), null);
  globalThis.window.sqb = {};
  globalThis.fetch = async () => { throw new Error('Electron must not request session'); }; assert.equal(await detectOnlineSession(), null);
});

test('unauthenticated online sessions require login and authenticated sessions keep CSRF only in memory', async t => {
  fixture(t);
  globalThis.fetch = async () => Response.json({ online: true }, { status: 401 });
  assert.deepEqual(await detectOnlineSession(), { online: true }); assert.equal(getOnlineSession(), null);
  const session = { online: true, user: { id: 'fixture-user', role: 'cashier' }, csrfToken: 'isolated-csrf-token' };
  globalThis.fetch = async () => Response.json(session);
  assert.deepEqual(await detectOnlineSession(), session); assert.deepEqual(onlineHeaders(), { 'X-Terminal-Id': onlineTerminalId(), 'X-CSRF-Token': session.csrfToken });
  setOnlineSession(null); assert.deepEqual(onlineHeaders(), { 'X-Terminal-Id': onlineTerminalId() });
});

test('cloud commands use same-origin cookies, CSRF, exact body, and no-store without replacing server errors', async t => {
  fixture(t); setOnlineSession({ csrfToken: 'isolated-csrf-token' });
  const command = { type: 'manual-complete', expectedRevision: 7, requestId: 'isolated-request', payload: { draft: { id: 'order-test' } } };
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/cashier-api/online/command'); assert.equal(init.credentials, 'same-origin'); assert.equal(init.cache, 'no-store');
    assert.equal(init.headers['X-CSRF-Token'], 'isolated-csrf-token'); assert.equal(init.headers['X-Terminal-Id'], onlineTerminalId()); assert.deepEqual(JSON.parse(init.body), command);
    return Response.json({ error: '账本已更新', code: 'REVISION_CONFLICT' }, { status: 409 });
  };
  await assert.rejects(onlineRequest('command', { method: 'POST', body: command }), issue => issue.code === 'REVISION_CONFLICT' && issue.status === 409);
});

test('expired cloud requests evict the visible session while a rejected login does not trigger another eviction', async t => {
  const events = fixture(t);
  globalThis.fetch = async () => Response.json({ error: '请登录' }, { status: 401 });
  await assert.rejects(onlineRequest('ledger'), { status: 401 });
  assert.deepEqual(events, ['online-session-expired']);
  await assert.rejects(onlineRequest('login', { method: 'POST', body: { username: 'fixture' }, allowUnauthorized: true }));
  assert.equal(events.length, 1);
});

test('duplicated tabs rotate a copied terminal identifier while an ordinary reload retains its identifier', async t => {
  fixture(t);
  const saved = '345e73e7-256f-4688-90e6-c80f171685ea', held = new Set();
  function page(value) {
    let stored = value;
    return { location: { hostname: 'cashier.example.invalid' }, sessionStorage: { getItem: () => stored, setItem: (_, next) => { stored = next; } }, navigator: { locks: {
      request(name, options, callback) {
        assert.equal(options.ifAvailable, true);
        if (held.has(name)) return Promise.resolve(callback(null));
        held.add(name); return Promise.resolve(callback({ name }));
      },
    } } };
  }
  globalThis.window = page(saved);
  const first = await import(`../src/onlineApi.js?terminal-first=${crypto.randomUUID()}`);
  assert.equal(await first.prepareOnlineTerminal(), saved);
  globalThis.window = page(saved);
  const copy = await import(`../src/onlineApi.js?terminal-copy=${crypto.randomUUID()}`);
  const copiedId = await copy.prepareOnlineTerminal();
  assert.notEqual(copiedId, saved); assert.equal(await copy.prepareOnlineTerminal(), copiedId);
  held.delete(`bubble-online-terminal:${saved}`);
  globalThis.window = page(saved);
  const reloaded = await import(`../src/onlineApi.js?terminal-reload=${crypto.randomUUID()}`);
  assert.equal(await reloaded.prepareOnlineTerminal(), saved);
});

test('without browser locks each new document gets an independent terminal instead of reusing copied storage', async t => {
  fixture(t);
  const saved = '345e73e7-256f-4688-90e6-c80f171685ea';
  globalThis.window.sessionStorage = { getItem: () => saved, setItem() {} };
  const fallback = await import(`../src/onlineApi.js?terminal-fallback=${crypto.randomUUID()}`);
  const id = await fallback.prepareOnlineTerminal();
  assert.notEqual(id, saved); assert.equal(await fallback.prepareOnlineTerminal(), id);
});
