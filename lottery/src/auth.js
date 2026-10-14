import crypto from 'node:crypto';

export function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Hashing both sides first keeps the comparison constant-time across lengths.
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function isStaffKey(presented, expected) {
  return typeof expected === 'string' && expected.length > 0 &&
    typeof presented === 'string' && presented.length > 0 &&
    safeEqual(presented, expected);
}

export function maskOpenid(openid) {
  const s = String(openid || '');
  if (s.length <= 8) return s.slice(0, 2) + '…';
  return s.slice(0, 4) + '…' + s.slice(-4);
}
