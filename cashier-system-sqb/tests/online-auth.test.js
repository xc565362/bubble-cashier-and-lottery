import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const { createAuthStore, SESSION_MS } = require('../online/auth.cjs');
const { createServerProtector } = require('../online/secrets.cjs');
const PASSWORD = 'temporary-admin-password-42';
const OTHER_PASSWORD = '另一组独立测试密码至少十二个字';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-online-auth-'));
  const file = path.join(directory, 'auth.sqlite');
  let time = 1_800_000_000_000;
  let store = createAuthStore({ file, now: () => time });
  t.after(() => {
    store.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.match(path.basename(resolved), /^bubble-online-auth-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return {
    directory, file, get store() { return store; },
    advance(ms) { time += ms; },
    reopen() { store.close(); store = createAuthStore({ file, now: () => time }); return store; },
    admin: () => store.createInitialAdmin({ username: 'Admin', password: PASSWORD, displayName: '管理员' }),
    login: (username = 'admin', password = PASSWORD, ip = '127.0.0.1') => store.authenticate(username, password, { ip }),
  };
}

const errorCode = (code) => (error) => error.code === code;

test('online auth initializes only once, validates password policy and supports Chinese passwords', async (t) => {
  const f = fixture(t);
  assert.equal(f.store.hasUsers(), false);
  await assert.rejects(f.store.createInitialAdmin({ username: 'aa', password: PASSWORD }), errorCode('INVALID_USERNAME'));
  await assert.rejects(f.store.createInitialAdmin({ username: 'admin', password: 'short' }), errorCode('INVALID_PASSWORD'));
  await assert.rejects(f.store.createInitialAdmin({ username: 'admin', password: '中'.repeat(342) }), errorCode('INVALID_PASSWORD'));
  const results = await Promise.allSettled([
    f.store.createInitialAdmin({ username: 'Admin', password: OTHER_PASSWORD, displayName: '管理员' }),
    f.store.createInitialAdmin({ username: 'Other', password: PASSWORD }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'ALREADY_INITIALIZED');
  const user = results.find((result) => result.status === 'fulfilled').value;
  assert.equal(user.role, 'admin');
  assert.equal(f.store.hasUsers(), true);
  const session = await f.login(user.username, user.username === 'admin' ? OTHER_PASSWORD : PASSWORD);
  assert.equal(session.user.id, user.id);
  await assert.rejects(f.admin(), errorCode('ALREADY_INITIALIZED'));
});

test('online sessions persist only token hashes and expose stable CSRF and non-secret session ids', async (t) => {
  const f = fixture(t);
  const admin = await f.admin();
  const session = await f.login(' ADMIN ');
  assert.equal(session.expiresAt, 1_800_000_000_000 + SESSION_MS);
  assert.match(session.sessionId, /^[a-f0-9-]{36}$/);
  assert.notEqual(session.sessionId, session.token);
  assert.notEqual(session.csrfToken, session.token);
  const restored = f.reopen().getSession(session.token);
  assert.deepEqual(restored, { sessionId: session.sessionId, user: session.user, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
  const reader = new DatabaseSync(f.file);
  try {
    const stored = reader.prepare('SELECT * FROM sessions').get();
    assert.equal(stored.token_hash.length, 64);
    assert.ok(!JSON.stringify(stored).includes(session.token));
    const persisted = JSON.stringify({
      users: reader.prepare('SELECT * FROM users').all(),
      sessions: reader.prepare('SELECT * FROM sessions').all(),
      audit: reader.prepare('SELECT * FROM audit').all(),
    });
    for (const secret of [PASSWORD, session.token, session.csrfToken]) assert.equal(persisted.includes(secret), false);
  } finally { reader.close(); }
  assert.deepEqual(f.store.listUsers(), [admin]);
  assert.equal(f.store.getSession('malformed'), null);
  assert.equal(f.store.getSession(`s1_${'A'.repeat(43)}`), null);
  assert.deepEqual(f.store.logout(session.token), { ok: true });
  assert.equal(f.store.getSession(session.token), null);
  assert.deepEqual(f.store.logout(session.token), { ok: true });
});

test('online failed logins have generic errors and durable throttling that expires', async (t) => {
  const f = fixture(t);
  await f.admin();
  await assert.rejects(f.login('missing', 'wrong'), errorCode('INVALID_CREDENTIALS'));
  for (let i = 0; i < 5; i += 1) await assert.rejects(f.login('admin', 'wrong'), errorCode('INVALID_CREDENTIALS'));
  f.reopen();
  await assert.rejects(f.login(), errorCode('RATE_LIMITED'));
  assert.ok(await f.login('admin', PASSWORD, '127.0.0.2'));
  // Successful login on another IP clears the account counter, not the old pair.
  await assert.rejects(f.login(), errorCode('RATE_LIMITED'));
  f.advance(15 * 60 * 1000 + 1);
  assert.ok(await f.login());
});

test('online user mutations recheck administrator privileges and protect the last enabled admin', async (t) => {
  const f = fixture(t);
  const admin = await f.admin();
  const cashier = await f.store.createUser({ username: 'cashier', password: PASSWORD }, admin);
  assert.equal(cashier.role, 'cashier');
  await assert.rejects(f.store.createUser({ username: 'another', password: PASSWORD }, { ...cashier, role: 'admin' }), errorCode('FORBIDDEN'));
  await assert.rejects(f.store.updateUser(admin.id, { disabled: true }, admin), errorCode('LAST_ADMIN'));
  await assert.rejects(f.store.updateUser(admin.id, { role: 'cashier' }, admin), errorCode('LAST_ADMIN'));
  await assert.rejects(f.store.updateUser(cashier.id, { disabled: 'false' }, admin), errorCode('INVALID_UPDATE'));
  await assert.rejects(f.store.updateUser(cashier.id, { role: 'owner' }, admin), errorCode('INVALID_ROLE'));
  await assert.rejects(f.store.updateUser(cashier.id, { username: 'newname' }, admin), errorCode('INVALID_UPDATE'));
  await assert.rejects(f.store.createUser({ username: 'CASHIER', password: PASSWORD }, admin), errorCode('USERNAME_EXISTS'));
  const second = await f.store.createUser({ username: 'admin2', password: PASSWORD, role: 'admin' }, admin);
  await f.store.updateUser(admin.id, { role: 'cashier' }, second);
  await assert.rejects(f.store.createUser({ username: 'another', password: PASSWORD }, admin), errorCode('FORBIDDEN'));
  await assert.rejects(f.store.updateUser(second.id, { disabled: true }, second), errorCode('LAST_ADMIN'));
});

test('online password, role and disable changes revoke only the affected user sessions durably', async (t) => {
  const f = fixture(t);
  const admin = await f.admin();
  const cashier = await f.store.createUser({ username: 'cashier', password: PASSWORD }, admin);
  const adminSession = await f.login();
  const first = await f.login('cashier');
  const second = await f.login('cashier');
  await f.store.updateUser(cashier.id, { displayName: '赛事收银员' }, admin);
  assert.equal(f.store.getSession(first.token).user.displayName, '赛事收银员');
  await f.store.updateUser(cashier.id, { password: OTHER_PASSWORD }, admin);
  assert.equal(f.store.getSession(first.token), null);
  assert.equal(f.store.getSession(second.token), null);
  assert.ok(f.store.getSession(adminSession.token));
  await assert.rejects(f.login('cashier'), errorCode('INVALID_CREDENTIALS'));
  const changed = await f.login('cashier', OTHER_PASSWORD);
  await f.store.updateUser(cashier.id, { role: 'admin' }, admin);
  assert.equal(f.store.getSession(changed.token), null);
  const promoted = await f.login('cashier', OTHER_PASSWORD);
  await f.store.updateUser(cashier.id, { disabled: true }, admin);
  f.reopen();
  assert.equal(f.store.getSession(promoted.token), null);
  await assert.rejects(f.login('cashier', OTHER_PASSWORD), errorCode('INVALID_CREDENTIALS'));
  assert.equal(f.store.listUsers().find((user) => user.id === cashier.id).disabled, true);
  await f.store.updateUser(cashier.id, { disabled: false }, admin);
  assert.ok(await f.login('cashier', OTHER_PASSWORD));
});

test('online password change requires the current password and revokes all existing sessions', async (t) => {
  const f = fixture(t);
  const user = await f.admin();
  const session = await f.login();
  await assert.rejects(f.store.changePassword(user.id, 'wrong', OTHER_PASSWORD), errorCode('INVALID_CREDENTIALS'));
  assert.ok(f.store.getSession(session.token));
  await f.store.changePassword(user.id, PASSWORD, OTHER_PASSWORD);
  assert.equal(f.store.getSession(session.token), null);
  await assert.rejects(f.login(), errorCode('INVALID_CREDENTIALS'));
  assert.ok(await f.login('admin', OTHER_PASSWORD));
});

test('online session count is bounded and the absolute eight-hour expiry survives restart', async (t) => {
  const f = fixture(t);
  await f.admin();
  const sessions = [];
  for (let i = 0; i < 11; i += 1) {
    sessions.push(await f.login());
    f.advance(1);
  }
  assert.equal(f.store.getSession(sessions[0].token), null);
  assert.ok(f.store.getSession(sessions[1].token));
  f.advance(SESSION_MS);
  f.reopen();
  assert.equal(f.store.getSession(sessions.at(-1).token), null);
});

test('server protector encrypts randomly, persists its separate key and rejects tampering', (t) => {
  const f = fixture(t);
  const keyFile = path.join(f.directory, 'separate-secret.key');
  const protector = createServerProtector({ keyFile });
  const secret = '仅用于隔离测试的配置内容';
  const first = protector.protect(secret);
  const second = protector.protect(secret);
  assert.notEqual(first, second);
  assert.equal(first.includes(secret), false);
  assert.equal(protector.unprotect(first), secret);
  assert.equal(createServerProtector({ keyFile }).unprotect(first), secret);
  assert.equal(protector.unprotect(protector.protect('')), '');
  const parts = first.split('.');
  parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
  assert.throws(() => protector.unprotect(parts.join('.')), errorCode('SECRET_INVALID'));
  assert.throws(() => protector.unprotect(secret), errorCode('SECRET_INVALID'));
  assert.throws(() => protector.unprotect(first.replace('bsv1.', 'bsv2.')), errorCode('SECRET_INVALID'));
  assert.throws(() => createServerProtector({ keyFile: path.join(f.directory, 'wrong-key') }).unprotect(first), errorCode('SECRET_INVALID'));
  assert.equal(fs.readFileSync(keyFile, 'utf8').includes(secret), false);
  assert.equal(fs.readFileSync(keyFile, 'utf8').trim().length, 64);
  if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
});
