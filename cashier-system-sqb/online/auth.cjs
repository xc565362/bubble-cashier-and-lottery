'use strict';

// Trusted server/CLI module. There is deliberately no public registration endpoint.
// All methods are async (MySQL storage, tables pos_users/pos_sessions/
// pos_login_limits/pos_audit). Times are Unix milliseconds. HTTP callers must
// enforce secure cookies, Origin, CSRF and route permissions; context.ip must
// come from a trusted network source.
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { withTransaction } = require('./mysql.cjs');

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
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

function createAuthStore({ pool, ns = '', now = Date.now } = {}) {
  if (!pool || typeof pool.query !== 'function') throw fail('INVALID_STORE', '需要认证数据库连接池', 500);
  if (typeof now !== 'function') throw fail('INVALID_STORE', '需要认证时间源', 500);
  let kdfInFlight = 0;
  const timestamp = () => {
    const value = Number(now());
    if (!Number.isSafeInteger(value) || value < 0) throw fail('INVALID_CLOCK', '无效的服务器时间', 500);
    return value;
  };
  const userById = async (id, q = pool) => {
    if (typeof id !== 'string') return undefined;
    const [rows] = await q.query('SELECT * FROM pos_users WHERE ns = ? AND id = ?', [ns, id]);
    return rows[0];
  };

  async function audit(q, action, actorId, userId, metadata = {}) {
    await q.query('INSERT INTO pos_audit(ns, at, action, actor_id, user_id, metadata) VALUES(?,?,?,?,?,?)',
      [ns, timestamp(), action, actorId || null, userId || null, JSON.stringify(metadata)]);
    await q.query(`DELETE FROM pos_audit WHERE ns = ? AND id < COALESCE(
      (SELECT id FROM (SELECT id FROM pos_audit WHERE ns = ? ORDER BY id DESC LIMIT 1 OFFSET 4999) trimmed), 0)`, [ns, ns]);
  }

  async function requireAdmin(actor, q = pool) {
    const user = await userById(actor?.id, q);
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
  async function consumeLimits(specs) {
    const time = timestamp();
    const blocked = await withTransaction(pool, async (q) => {
      await q.query('DELETE FROM pos_login_limits WHERE ns = ? AND reset_at <= ?', [ns, time]);
      const [countRows] = await q.query('SELECT COUNT(*) AS n FROM pos_login_limits WHERE ns = ?', [ns]);
      const count = Number(countRows[0].n);
      const entries = [];
      for (const [label, max, window] of specs) {
        const bucket = digest(label);
        const [rows] = await q.query('SELECT * FROM pos_login_limits WHERE ns = ? AND bucket = ?', [ns, bucket]);
        entries.push({ bucket, max, window, row: rows[0] });
      }
      if (count + entries.filter((entry) => !entry.row).length > MAX_BUCKETS) return true;
      let limited = false;
      for (const entry of entries) {
        if (entry.row && entry.row.attempts >= entry.max) { limited = true; continue; }
        await q.query(`INSERT INTO pos_login_limits(ns, bucket, attempts, reset_at) VALUES(?,?,1,?)
          ON DUPLICATE KEY UPDATE attempts = attempts + 1`, [ns, entry.bucket, time + entry.window]);
      }
      return limited;
    });
    if (blocked) throw fail('RATE_LIMITED', '尝试过于频繁，请稍后重试', 429);
  }

  async function insertUser(q, input, role, password) {
    const time = timestamp();
    const id = crypto.randomUUID();
    const [rows] = await q.query('SELECT id FROM pos_users WHERE ns = ? AND username = ?', [ns, input.username]);
    if (rows.length) throw fail('USERNAME_EXISTS', '用户名已存在', 409);
    try {
      await q.query(`INSERT INTO pos_users(ns, id, username, display_name, role, salt, password_hash, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`, [ns, id, input.username, input.displayName, role, password.salt, password.hash, time, time]);
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') throw fail('USERNAME_EXISTS', '用户名已存在', 409);
      throw error;
    }
    return publicUser(await userById(id, q));
  }

  async function createInitialAdmin({ username, password, displayName } = {}) {
    const name = usernameOf(username);
    const input = { username: name, displayName: displayNameOf(displayName, name) };
    const hashed = await hashPassword(password);
    return withTransaction(pool, async (q) => {
      // RR snapshots cannot serialize the "first user" phantom; a server-wide
      // named lock replaces SQLite's BEGIN IMMEDIATE single-writer guarantee.
      const [lockRows] = await q.query('SELECT GET_LOCK(?, 10) AS acquired', [`pos_auth_init_${ns}`]);
      if (Number(lockRows[0].acquired) !== 1) throw fail('AUTH_BUSY', '认证服务繁忙，请稍后重试', 503);
      try {
        const [rows] = await q.query('SELECT id FROM pos_users WHERE ns = ? LIMIT 1', [ns]);
        if (rows.length) throw fail('ALREADY_INITIALIZED', '管理员已初始化', 409);
        const user = await insertUser(q, input, 'admin', hashed);
        await audit(q, 'admin.initialized', user.id, user.id);
        return user;
      } finally {
        await q.query('SELECT RELEASE_LOCK(?)', [`pos_auth_init_${ns}`]).catch(() => {});
      }
    });
  }

  async function authenticate(username, password, context = {}) {
    let name;
    try { name = usernameOf(username); } catch { name = '<invalid>'; }
    const ip = typeof context.ip === 'string' && context.ip.length <= 256 ? context.ip : '<unknown>';
    const accountBucket = `account:${name}`;
    const pairBucket = `pair:${name}:${ip}`;
    await consumeLimits([
      [pairBucket, 5, 15 * 60 * 1000], [accountBucket, 20, 15 * 60 * 1000],
      [`ip:${ip}`, 60, 15 * 60 * 1000], ['global', 200, 60 * 1000],
    ]);
    const [initialRows] = await pool.query('SELECT * FROM pos_users WHERE ns = ? AND username = ?', [ns, name]);
    const initial = initialRows[0];
    const match = await matches(password, initial);
    const session = await withTransaction(pool, async (q) => {
      const user = initial && await userById(initial.id, q);
      if (!match || !user || user.disabled || user.password_hash !== initial.password_hash) {
        await audit(q, 'login.failed', null, initial?.id, { account: digest(name), ip: digest(ip) });
        // Commit the audit/limits before reporting an authentication failure.
        return null;
      }
      const time = timestamp();
      await q.query('DELETE FROM pos_sessions WHERE ns = ? AND expires_at <= ?', [ns, time]);
      await q.query(`DELETE FROM pos_sessions WHERE ns = ? AND user_id = ? AND id NOT IN
        (SELECT id FROM (SELECT id FROM pos_sessions WHERE ns = ? AND user_id = ? ORDER BY created_at DESC, seq DESC LIMIT ?) kept)`,
        [ns, user.id, ns, user.id, MAX_SESSIONS - 1]);
      const token = `s1_${crypto.randomBytes(32).toString('base64url')}`;
      const sessionId = crypto.randomUUID();
      const expiresAt = time + SESSION_MS;
      await q.query('INSERT INTO pos_sessions(ns, id, token_hash, user_id, created_at, expires_at) VALUES(?,?,?,?,?,?)',
        [ns, sessionId, digest(token), user.id, time, expiresAt]);
      await q.query('DELETE FROM pos_login_limits WHERE ns = ? AND bucket IN (?,?)', [ns, digest(accountBucket), digest(pairBucket)]);
      await audit(q, 'login.succeeded', user.id, user.id, { sessionId, ip: digest(ip) });
      return { token, sessionId, user: publicUser(user), csrfToken: csrf(token), expiresAt };
    });
    return session || (() => { throw fail('INVALID_CREDENTIALS', '用户名或密码不正确', 401); })();
  }

  async function getSession(rawToken) {
    if (typeof rawToken !== 'string' || !/^s1_[A-Za-z0-9_-]{43}$/.test(rawToken)) return null;
    const [rows] = await pool.query('SELECT * FROM pos_sessions WHERE ns = ? AND token_hash = ?', [ns, digest(rawToken)]);
    const session = rows[0];
    if (!session) return null;
    const user = await userById(session.user_id);
    if (!user || user.disabled || Number(session.expires_at) <= timestamp()) {
      await pool.query('DELETE FROM pos_sessions WHERE ns = ? AND id = ?', [ns, session.id]);
      return null;
    }
    return { sessionId: session.id, user: publicUser(user), csrfToken: csrf(rawToken), expiresAt: Number(session.expires_at) };
  }

  async function logout(rawToken) {
    if (typeof rawToken !== 'string' || !/^s1_[A-Za-z0-9_-]{43}$/.test(rawToken)) return { ok: true };
    return withTransaction(pool, async (q) => {
      const [rows] = await q.query('SELECT * FROM pos_sessions WHERE ns = ? AND token_hash = ?', [ns, digest(rawToken)]);
      const row = rows[0];
      if (row) {
        await q.query('DELETE FROM pos_sessions WHERE ns = ? AND id = ?', [ns, row.id]);
        await audit(q, 'logout', row.user_id, row.user_id, { sessionId: row.id });
      }
      return { ok: true };
    });
  }

  async function createUser({ username, password, displayName, role = 'cashier' } = {}, actor) {
    await requireAdmin(actor);
    const name = usernameOf(username);
    const input = { username: name, displayName: displayNameOf(displayName, name) };
    const checkedRole = roleOf(role);
    const hashed = await hashPassword(password);
    return withTransaction(pool, async (q) => {
      const admin = await requireAdmin(actor, q);
      const user = await insertUser(q, input, checkedRole, hashed);
      await audit(q, 'user.created', admin.id, user.id, { role: checkedRole });
      return user;
    });
  }

  async function updateUser(id, patch = {}, actor) {
    await requireAdmin(actor);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)
      || Object.keys(patch).some((key) => !['displayName', 'role', 'disabled', 'password'].includes(key))) {
      throw fail('INVALID_UPDATE', '无效的账号更新内容');
    }
    const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
    const displayName = has('displayName') ? displayNameOf(patch.displayName) : undefined;
    const role = has('role') ? roleOf(patch.role) : undefined;
    if (has('disabled') && typeof patch.disabled !== 'boolean') throw fail('INVALID_UPDATE', '停用状态必须是布尔值');
    const password = has('password') ? await hashPassword(patch.password) : undefined;
    return withTransaction(pool, async (q) => {
      const admin = await requireAdmin(actor, q);
      const user = await userById(id, q);
      if (!user) throw fail('USER_NOT_FOUND', '账号不存在', 404);
      const nextRole = role ?? user.role;
      const disabled = has('disabled') ? Number(patch.disabled) : user.disabled;
      if (user.role === 'admin' && !user.disabled && (nextRole !== 'admin' || disabled)) {
        const [rows] = await q.query("SELECT COUNT(*) AS n FROM pos_users WHERE ns = ? AND role = 'admin' AND disabled = 0", [ns]);
        if (Number(rows[0].n) <= 1) throw fail('LAST_ADMIN', '必须保留至少一个启用的管理员', 409);
      }
      await q.query('UPDATE pos_users SET display_name = ?, role = ?, disabled = ?, salt = ?, password_hash = ?, updated_at = ? WHERE ns = ? AND id = ?',
        [displayName ?? user.display_name, nextRole, disabled, password?.salt ?? user.salt,
          password?.hash ?? user.password_hash, timestamp(), ns, user.id]);
      const revoked = Boolean(password) || nextRole !== user.role || disabled !== user.disabled;
      if (revoked) await q.query('DELETE FROM pos_sessions WHERE ns = ? AND user_id = ?', [ns, user.id]);
      await audit(q, 'user.updated', admin.id, user.id, { fields: Object.keys(patch), sessionsRevoked: revoked });
      return publicUser(await userById(id, q));
    });
  }

  async function changePassword(userId, currentPassword, newPassword) {
    passwordOf(newPassword);
    const initial = await userById(userId);
    if (!initial || initial.disabled) throw fail('INVALID_CREDENTIALS', '用户名或密码不正确', 401);
    await consumeLimits([[`password:${initial.id}`, 5, 15 * 60 * 1000]]);
    if (!(await matches(currentPassword, initial))) {
      await audit(pool, 'password.failed', initial.id, initial.id);
      throw fail('INVALID_CREDENTIALS', '用户名或密码不正确', 401);
    }
    const hashed = await hashPassword(newPassword);
    return withTransaction(pool, async (q) => {
      const user = await userById(initial.id, q);
      if (!user || user.disabled || user.password_hash !== initial.password_hash) throw fail('INVALID_CREDENTIALS', '用户名或密码不正确', 401);
      await q.query('UPDATE pos_users SET salt = ?, password_hash = ?, updated_at = ? WHERE ns = ? AND id = ?',
        [hashed.salt, hashed.hash, timestamp(), ns, user.id]);
      await q.query('DELETE FROM pos_sessions WHERE ns = ? AND user_id = ?', [ns, user.id]);
      await q.query('DELETE FROM pos_login_limits WHERE ns = ? AND bucket = ?', [ns, digest(`password:${user.id}`)]);
      await audit(q, 'password.changed', user.id, user.id, { sessionsRevoked: true });
      return publicUser(await userById(user.id, q));
    });
  }

  return {
    createInitialAdmin, authenticate, getSession, logout, createUser, updateUser, changePassword,
    async listUsers() {
      const [rows] = await pool.query('SELECT * FROM pos_users WHERE ns = ? ORDER BY created_at, username', [ns]);
      return rows.map(publicUser);
    },
    async hasUsers() {
      const [rows] = await pool.query('SELECT id FROM pos_users WHERE ns = ? LIMIT 1', [ns]);
      return Boolean(rows.length);
    },
    // The pool belongs to the caller; close() is kept for interface stability.
    close() {},
  };
}

module.exports = { createAuthStore, SESSION_MS };
