'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const GRANT_MS = 24 * 60 * 60 * 1000;
const tokenHash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const denied = () => Object.assign(new Error('初始化未完成，请检查设置码、账号和密码，或联系管理员'), { code: 'SETUP_DENIED', status: 403 });

function timestamp(now) {
  const time = Number(now());
  if (!Number.isSafeInteger(time) || time < 0) throw denied();
  return time;
}

// Trusted deployment/CLI use only. The returned token must never be logged by a
// public route; deliver it out of band or in a URL fragment, never a query string.
function generateGrant({ file, now = Date.now } = {}) {
  if (typeof file !== 'string' || !file || typeof now !== 'function') throw denied();
  const expiresAt = timestamp(now) + GRANT_MS;
  const token = `setup1_${crypto.randomBytes(32).toString('base64url')}`;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ tokenHash: tokenHash(token), expiresAt }), 'utf8');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  return { token, expiresAt };
}

// Only construct this module when an operator explicitly configures a setup file.
// HTTP still needs a same-origin POST and must take the token from a header.
function createSetup({ auth, file, now = Date.now } = {}) {
  if (!auth || typeof auth.hasUsers !== 'function' || typeof auth.createInitialAdmin !== 'function'
    || typeof file !== 'string' || !file || typeof now !== 'function') throw denied();

  function grant() {
    try {
      if (auth.hasUsers()) return null;
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) return null;
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      const time = timestamp(now);
      if (!value || !/^[a-f0-9]{64}$/.test(value.tokenHash) || !Number.isSafeInteger(value.expiresAt)
        || value.expiresAt <= time || value.expiresAt > time + GRANT_MS) return null;
      return value;
    } catch { return null; }
  }

  async function accept({ token, username, password, displayName } = {}) {
    const value = grant();
    const validToken = typeof token === 'string' && /^setup1_[A-Za-z0-9_-]{43}$/.test(token);
    const presentedHash = Buffer.from(tokenHash(validToken ? token : ''), 'hex');
    const expectedHash = Buffer.from(value?.tokenHash || '0'.repeat(64), 'hex');
    const matched = crypto.timingSafeEqual(presentedHash, expectedHash);
    if (!value || !validToken || !matched) throw denied();
    let user;
    try { user = await auth.createInitialAdmin({ username, password, displayName }); }
    catch { throw denied(); }
    // Account creation is authoritative. A crash or failed unlink cannot reopen
    // setup because hasUsers() and the auth transaction reject any second admin.
    try { fs.unlinkSync(file); } catch { /* hasUsers permanently closes setup. */ }
    return user;
  }

  return { setupEnabled: () => Boolean(grant()), accept };
}

module.exports = { createSetup, generateGrant, GRANT_MS };
