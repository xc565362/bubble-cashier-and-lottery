'use strict';

// Trusted server/CLI module. There is deliberately no public registration endpoint.
// Password methods are async; session reads, logout and user listing are synchronous.
// Times are Unix milliseconds. HTTP callers must enforce secure cookies, Origin,
// CSRF and route permissions; context.ip must come from a trusted network source.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const scrypt = promisify(crypto.scrypt);
const SESSION_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 10;
const MAX_BUCKETS = 5000;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const DUMMY_SALT = Buffer.alloc(16, 79).toString('hex');
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const csrf = (token) => crypto.createHmac('sha256', token).update('bubble-online-csrf-v1').digest('base64url');

function fail(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function usernameOf(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]{3,64}$/.test(value.trim())) {
    throw fail('INVALID_USERNAME', '用户名须为 3 至 64 位字母、数字、点、下划线或横线');
  }
  return value.trim().toLowerCase();
}

function passwordOf(value) {
  if (typeof value !== 'string' || [...value].length < 12 || Buffer.byteLength(value, 'utf8') > 1024) {
    throw fail('INVALID_PASSWORD', '密码至少需要 12 个字符，且不能超过 1024 字节');
  }
  return value;
}

function displayNameOf(value, fallback) {
  const name = value === undefined ? fallback : value;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    throw fail('INVALID_DISPLAY_NAME', '显示名称需要 1 至 100 个字符');
  }
  return name.trim();
}

function roleOf(value) {
  if (value !== 'admin' && value !== 'cashier') throw fail('INVALID_ROLE', '无效的账号角色');
  return value;
}

function publicUser(row) {
  return {
    id: row.id, username: row.username, displayName: row.display_name,
    role: row.role, disabled: Boolean(row.disabled),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function createAuthStore({ file, now = Date.now } = {}) {
  if (typeof file !== 'string' || !file || typeof now !== 'function') throw fail('INVALID_STORE', '需要认证数据库文件');
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw fail('INVALID_STORE', '认证数据库必须是普通文件');
    } else {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.closeSync(fd);
    }
    fs.chmodSync(file, 0o600);
  }
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','cashier')), disabled INTEGER NOT NULL DEFAULT 0,
      salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id, created_at);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS login_limits (bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL,
      actor_id TEXT, user_id TEXT, metadata TEXT NOT NULL
    );`);
  let closed = false;
  let kdfInFlight = 0;
  const timestamp = () => {
    const value = Number(now());
    if (!Number.isSafeInteger(value) || value < 0) throw fail('INVALID_CLOCK', '无效的服务器时间', 500);
    return value;
  };
  const userById = (id) => typeof id === 'string' ? db.prepare('SELECT * FROM users WHERE id = ?').get(id) : undefined;

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function audit(action, actorId, userId, metadata = {}) {
    db.prepare('INSERT INTO audit(at, action, actor_id, user_id, metadata) VALUES(?,?,?,?,?)')
      .run(timestamp(), action, actorId || null, userId || null, JSON.stringify(metadata));
    db.exec('DELETE FROM audit WHERE id < COALESCE((SELECT id FROM audit ORDER BY id DESC LIMIT 1 OFFSET 4999), 0)');
  }

  function requireAdmin(actor) {
    const user = userById(actor?.id);
    if (!user || user.disabled || user.role !== 'admin') throw fail('FORBIDDEN', '需要管理员权限', 403);
    return user;
  }

  async function derive(password, salt) {
    if (kdfInFlight >= 4) throw fail('AUTH_BUSY', '认证服务繁忙，请稍后重试', 503);
    kdfInFlight += 1;
    try {
      return await scrypt(password, salt, 32, SCRYPT);
    } finally {
      kdfInFlight -= 1;
    }
  }

  async function hashPassword(password) {
    passwordOf(password);
    const salt = crypto.randomBytes(16).toString('hex');
    return { salt, hash: (await derive(password, salt)).toString('hex') };
  }

  async function matches(password, row) {
    const validInput = typeof password === 'string' && Buffer.byteLength(password, 'utf8') <= 1024;
    const result = await derive(validInput ? password : '', row?.salt || DUMMY_SALT);
    const expected = row?.password_hash && /^[a-f0-9]{64}$/.test(row.password_hash)
      ? Buffer.from(row.password_hash, 'hex') : Buffer.alloc(32);
    return validInput && crypto.timingSafeEqual(result, expected) && Boolean(row);
  }

  // All buckets are persisted, opaque hashes and bounded. No unbounded IP maps.
  // Account/pair buckets reset after success; IP/global caps also bound valid logins.
  function consumeLimits(specs) {
    const time = timestamp();
    const blocked = transaction(() => {
      db.prepare('DELETE FROM login_limits WHERE reset_at <= ?').run(time);
      const count = Number(db.prepare('SELECT count(*) AS n FROM login_limits').get().n);
      const entries = specs.map(([label, max, window]) => {
        const bucket = digest(label);
        return { bucket, max, window, row: db.prepare('SELECT * FROM login_limits WHERE bucket = ?').get(bucket) };
      });
      if (count + entries.filter((entry) => !entry.row).length > MAX_BUCKETS) return true;
      let limited = false;
      for (const entry of entries) {
        if (entry.row && entry.row.attempts >= entry.max) { limited = true; continue; }
        db.prepare(`INSERT INTO login_limits(bucket,attempts,reset_at) VALUES(?,1,?)
          ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1`).run(entry.bucket, time + entry.window);
      }
      return limited;
    });
    if (blocked) throw fail('RATE_LIMITED', '尝试过于频繁，请稍后重试', 429);
  }

  function insertUser(input, role, password) {
    const time = timestamp();
    const id = crypto.randomUUID();
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(input.username)) throw fail('USERNAME_EXISTS', '用户名已存在', 409);
    db.prepare(`INSERT INTO users(id,username,display_name,role,salt,password_hash,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, input.username, input.displayName, role, password.salt, password.hash, time, time);
    return publicUser(userById(id));
  }

  async function createInitialAdmin({ username, password, displayName } = {}) {
    const name = usernameOf(username);
    const input = { username: name, displayName: displayNameOf(displayName, name) };
    const hashed = await hashPassword(password);
    return transaction(() => {
      if (db.prepare('SELECT id FROM users LIMIT 1').get()) throw fail('ALREADY_INITIALIZED', '管理员已初始化', 409);
      const user = insertUser(input, 'admin', hashed);
      audit('admin.initialized', user.id, user.id);
      return user;
    });
  }

  async function authenticate(username, password, context = {}) {
    let name;
    try { name = usernameOf(username); } catch { name = '<invalid>'; }
    const ip = typeof context.ip === 'string' && context.ip.length <= 256 ? context.ip : '<unknown>';
    const accountBucket = `account:${name}`;
    const pairBucket = `pair:${name}:${ip}`;
    consumeLimits([
      [pairBucket, 5, 15 * 60 * 1000], [accountBucket, 20, 15 * 60 * 1000],
      [`ip:${ip}`, 60, 15 * 60 * 1000], ['global', 200, 60 * 1000],
    ]);
    const initial = db.prepare('SELECT * FROM users WHERE username = ?').get(name);
    const match = await matches(password, initial);
    return transaction(() => {
      const user = initial && userById(initial.id);
      if (!match || !user || user.disabled || user.password_hash !== initial.password_hash) {
        audit('login.failed', null, initial?.id, { account: digest(name), ip: digest(ip) });
        // Commit the audit/limits before reporting an authentication failure.
        return null;
      }
      const time = timestamp();
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(time);
      db.prepare(`DELETE FROM sessions WHERE user_id = ? AND id NOT IN
        (SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`)
        .run(user.id, user.id, MAX_SESSIONS - 1);
      const token = `s1_${crypto.randomBytes(32).toString('base64url')}`;
      const sessionId = crypto.randomUUID();
      const expiresAt = time + SESSION_MS;
      db.prepare('INSERT INTO sessions(id,token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?,?)')
        .run(sessionId, digest(token), user.id, time, expiresAt);
      db.prepare('DELETE FROM login_limits WHERE bucket IN (?,?)').run(digest(accountBucket), digest(pairBucket));
      audit('login.succeeded', user.id, user.id, { sessionId, ip: digest(ip) });
      return { token, sessionId, user: publicUser(user), csrfToken: csrf(token), expiresAt };
    }) || (() => { throw fail('INVALID_CREDENTIALS', '用户名或密码不正确', 401); })();
  }

  function getSession(rawToken) {
    if (typeof rawToken !== 'string' || !/^s1_[A-Za-z0-9_-]{43}$/.test(rawToken)) return null;
    const session = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(digest(rawToken));
    if (!session) return null;
    const user = userById(session.user_id);
    if (!user || user.disabled || session.expires_at <= timestamp()) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
      return null;
    }
    return { sessionId: session.id, user: publicUser(user), csrfToken: csrf(rawToken), expiresAt: session.expires_at };
  }

  function logout(rawToken) {
    if (typeof rawToken !== 'string' || !/^s1_[A-Za-z0-9_-]{43}$/.test(rawToken)) return { ok: true };
    return transaction(() => {
      const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(digest(rawToken));
      if (row) {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
        audit('logout', row.user_id, row.user_id, { sessionId: row.id });
      }
      return { ok: true };
    });
  }

  async function createUser({ username, password, displayName, role = 'cashier' } = {}, actor) {
    requireAdmin(actor);
    const name = usernameOf(username);
    const input = { username: name, displayName: displayNameOf(displayName, name) };
    const checkedRole = roleOf(role);
    const hashed = await hashPassword(password);
    return transaction(() => {
      const admin = requireAdmin(actor);
      const user = insertUser(input, checkedRole, hashed);
      audit('user.created', admin.id, user.id, { role: checkedRole });
      return user;
    });
  }

  async function updateUser(id, patch = {}, actor) {
    requireAdmin(actor);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)
      || Object.keys(patch).some((key) => !['displayName', 'role', 'disabled', 'password'].includes(key))) {
      throw fail('INVALID_UPDATE', '无效的账号更新内容');
    }
    const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
    const displayName = has('displayName') ? displayNameOf(patch.displayName) : undefined;
    const role = has('role') ? roleOf(patch.role) : undefined;
    if (has('disabled') && typeof patch.disabled !== 'boolean') throw fail('INVALID_UPDATE', '停用状态必须是布尔值');
    const password = has('password') ? await hashPassword(patch.password) : undefined;
    return transaction(() => {
      const admin = requireAdmin(actor);
      const user = userById(id);
      if (!user) throw fail('USER_NOT_FOUND', '账号不存在', 404);
      const nextRole = role ?? user.role;
      const disabled = has('disabled') ? Number(patch.disabled) : user.disabled;
      if (user.role === 'admin' && !user.disabled && (nextRole !== 'admin' || disabled)) {
        const count = db.prepare("SELECT count(*) AS n FROM users WHERE role='admin' AND disabled=0").get().n;
        if (count <= 1) throw fail('LAST_ADMIN', '必须保留至少一个启用的管理员', 409);
      }
      db.prepare('UPDATE users SET display_name=?, role=?, disabled=?, salt=?, password_hash=?, updated_at=? WHERE id=?')
        .run(displayName ?? user.display_name, nextRole, disabled, password?.salt ?? user.salt,
          password?.hash ?? user.password_hash, timestamp(), user.id);
      const revoked = Boolean(password) || nextRole !== user.role || disabled !== user.disabled;
      if (revoked) db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      audit('user.updated', admin.id, user.id, { fields: Object.keys(patch), sessionsRevoked: revoked });
      return publicUser(userById(id));
    });
  }

  async function changePassword(userId, currentPassword, newPassword) {
    passwordOf(newPassword);
    const initial = userById(userId);
    if (!initial || initial.disabled) throw fail('INVALID_CREDENTIALS', '用户名或密码不正确', 401);
    consumeLimits([[`password:${initial.id}`, 5, 15 * 60 * 1000]]);
    if (!(await matches(currentPassword, initial))) {
      audit('password.failed', initial.id, initial.id);
      throw fail('INVALID_CREDENTIALS', '用户名或密码不正确', 401);
    }
    const hashed = await hashPassword(newPassword);
    return transaction(() => {
      const user = userById(initial.id);
      if (!user || user.disabled || user.password_hash !== initial.password_hash) throw fail('INVALID_CREDENTIALS', '用户名或密码不正确', 401);
      db.prepare('UPDATE users SET salt=?,password_hash=?,updated_at=? WHERE id=?')
        .run(hashed.salt, hashed.hash, timestamp(), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      db.prepare('DELETE FROM login_limits WHERE bucket=?').run(digest(`password:${user.id}`));
      audit('password.changed', user.id, user.id, { sessionsRevoked: true });
      return publicUser(userById(user.id));
    });
  }

  return {
    createInitialAdmin, authenticate, getSession, logout, createUser, updateUser, changePassword,
    listUsers: () => db.prepare('SELECT * FROM users ORDER BY created_at, username').all().map(publicUser),
    hasUsers: () => Boolean(db.prepare('SELECT id FROM users LIMIT 1').get()),
    close() { if (!closed) { db.close(); closed = true; } },
  };
}

module.exports = { createAuthStore, SESSION_MS };
