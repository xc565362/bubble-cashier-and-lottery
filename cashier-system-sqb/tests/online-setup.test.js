import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAuthStore } = require('../online/auth.cjs');
const { createSetup, generateGrant, GRANT_MS } = require('../online/setup.cjs');
const { createPosFixture } = require('./helpers/posfixture.cjs');

async function fixture(t) {
  const pos = await createPosFixture(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-online-setup-'));
  const file = path.join(directory, 'operator-setup-grant.json');
  let time = 1_800_000_000_000;
  const now = () => time;
  const auth = createAuthStore({ pool: pos.pool, ns: pos.ns, now });
  const setup = createSetup({ auth, file, now });
  t.after(() => {
    auth.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.match(path.basename(resolved), /^bubble-online-setup-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { auth, setup, file, now, advance(ms) { time += ms; }, grant: () => generateGrant({ file, now }) };
}

const credentials = { username: 'admin', password: 'only-a-temporary-test-password', displayName: '管理员' };
const denied = (error) => error.code === 'SETUP_DENIED' && error.status === 403;

test('online setup requires an explicit one-time grant and stores only its hash for 24 hours', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.setup.setupEnabled(), false);
  const grant = f.grant();
  assert.equal(grant.expiresAt, f.now() + GRANT_MS);
  const stored = fs.readFileSync(f.file, 'utf8');
  assert.equal(stored.includes(grant.token), false);
  assert.deepEqual(Object.keys(JSON.parse(stored)).sort(), ['expiresAt', 'tokenHash']);
  assert.match(JSON.parse(stored).tokenHash, /^[a-f0-9]{64}$/);
  assert.throws(f.grant, (error) => error.code === 'EEXIST');
  assert.equal(await f.setup.setupEnabled(), true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  const user = await f.setup.accept({ ...credentials, token: grant.token });
  assert.equal(user.role, 'admin');
  assert.equal(await f.auth.hasUsers(), true);
  assert.equal(await f.setup.setupEnabled(), false);
  assert.equal(fs.existsSync(f.file), false);
  await assert.rejects(f.setup.accept({ ...credentials, token: grant.token }), denied);
});

test('online setup rejects wrong, expired and malformed grants with a generic error', async (t) => {
  const f = await fixture(t);
  const grant = f.grant();
  for (const token of ['', null, 'setup1_' + 'A'.repeat(43), grant.token + 'x']) {
    await assert.rejects(f.setup.accept({ ...credentials, token }), denied);
  }
  assert.equal(await f.auth.hasUsers(), false);
  await assert.rejects(f.setup.accept({ ...credentials, password: 'short', token: grant.token }), denied);
  assert.equal(await f.setup.setupEnabled(), true);
  f.advance(GRANT_MS);
  assert.equal(await f.setup.setupEnabled(), false);
  await assert.rejects(f.setup.accept({ ...credentials, token: grant.token }), denied);
  fs.writeFileSync(f.file, '{malformed', 'utf8');
  assert.equal(await f.setup.setupEnabled(), false);
  await assert.rejects(f.setup.accept({ ...credentials, token: grant.token }), denied);
});

test('online setup admits one concurrent initialization and remains closed with a leftover grant', async (t) => {
  const f = await fixture(t);
  const grant = f.grant();
  const storedGrant = fs.readFileSync(f.file, 'utf8');
  const results = await Promise.allSettled([
    f.setup.accept({ ...credentials, token: grant.token }),
    f.setup.accept({ ...credentials, username: 'admin2', token: grant.token }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'SETUP_DENIED');
  assert.equal((await f.auth.listUsers()).length, 1);
  fs.writeFileSync(f.file, storedGrant, 'utf8');
  const restarted = createSetup({ auth: f.auth, file: f.file, now: f.now });
  assert.equal(await restarted.setupEnabled(), false);
  await assert.rejects(restarted.accept({ ...credentials, token: grant.token }), denied);
});
