'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const AAD = Buffer.from('bubble-online-server-config:v1');
const PREFIX = 'bsv1';
const MAX_BYTES = 1024 * 1024;
const invalid = () => Object.assign(new Error('无法解密服务器配置，请检查独立密钥文件'), { code: 'SECRET_INVALID', status: 500 });

// The key file is separate from the config/database and must be backed up separately.
// No plaintext fallback: online servers must explicitly import old desktop settings.
function createServerProtector({ keyFile } = {}) {
  if (typeof keyFile !== 'string' || !keyFile) throw new Error('需要服务器独立密钥文件路径');
  const filename = path.resolve(keyFile);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  try {
    const fd = fs.openSync(filename, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${crypto.randomBytes(32).toString('hex')}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128) throw invalid();
  fs.chmodSync(filename, 0o600);
  const encoded = fs.readFileSync(filename, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(encoded)) throw invalid();
  const key = Buffer.from(encoded, 'hex');

  function protect(plaintext) {
    if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext, 'utf8') > MAX_BYTES) throw invalid();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [PREFIX, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
  }

  function unprotect(envelope) {
    if (typeof envelope !== 'string' || envelope.length > MAX_BYTES * 2) throw invalid();
    const parts = envelope.split('.');
    if (parts.length !== 4 || parts[0] !== PREFIX || !/^[A-Za-z0-9_-]{16}$/.test(parts[1])
      || !/^[A-Za-z0-9_-]{22}$/.test(parts[2]) || !/^[A-Za-z0-9_-]*$/.test(parts[3])) throw invalid();
    try {
      const [iv, tag, ciphertext] = parts.slice(1).map((part) => Buffer.from(part, 'base64url'));
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > MAX_BYTES
        || parts.slice(1).some((part, index) => [iv, tag, ciphertext][index].toString('base64url') !== part)) throw invalid();
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(AAD);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch { throw invalid(); }
  }

  return { protect, unprotect };
}

module.exports = { createServerProtector };
