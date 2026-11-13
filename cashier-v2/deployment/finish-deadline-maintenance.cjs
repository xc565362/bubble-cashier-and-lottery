const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
// Exported historical maintenance source. Review deployment/README.md before use.
function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) throw new Error('Set ' + name + ' explicitly before running this historical maintenance script.');
  return value.trim();
}
function requiredHttpsOrigin(name) {
  const value = requiredEnv(name);
  let url;
  try { url = new URL(value); } catch { throw new Error(name + ' must be a valid HTTPS origin.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(name + ' must be an HTTPS origin without credentials, path or query.');
  return url.origin;
}
function requiredDirectory(name) {
  const value = requiredEnv(name);
  if (!path.isAbsolute(value) || path.resolve(value) === path.parse(value).root) throw new Error(name + ' must be an explicit non-root absolute directory.');
  return path.resolve(value);
}
const maintenanceHome = requiredDirectory('BUBBLE_MAINTENANCE_HOME');
const operation = process.argv[2];
if (!['backup', 'revoke'].includes(operation)) throw new Error('Expected backup or revoke');
const backupsDirectory = operation === 'backup' ? requiredDirectory('BUBBLE_COUPON_BACKUPS_DIR') : null;
const revokePublicKey = operation === 'revoke' ? requiredEnv('BUBBLE_MAINTENANCE_SSH_PUBLIC_KEY') : null;
if (revokePublicKey && !/^[A-Za-z0-9+/]{40,}={0,2}$/.test(revokePublicKey)) throw new Error('BUBBLE_MAINTENANCE_SSH_PUBLIC_KEY must contain only the base64 public-key blob from the reviewed authorized_keys entry.');
assert.equal(process.getuid(), 0);
if (process.argv[2] === 'backup') {
  const file = path.join(maintenanceHome, "coupon-deadline-backup-20260922.tar.gz");
  assert.ok(!fs.existsSync(file));
  process.umask(0o077);
  const result = spawnSync('tar', ['-czf', file, '-C', backupsDirectory, 'deadline-20260922'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  fs.chmodSync(file, 0o600);
  const owner = fs.statSync(maintenanceHome); fs.chownSync(file, owner.uid, owner.gid);
  console.log(JSON.stringify({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
} else if (process.argv[2] === 'revoke') {
  const file = path.join(maintenanceHome, ".ssh/authorized_keys");
  const key = revokePublicKey;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const kept = lines.filter(line => !line.trim().split(/\s+/).includes(key));
  assert.ok(kept.length < lines.length, 'Temporary key not found; inspect before retry');
  fs.writeFileSync(file, kept.join('\n')); fs.chmodSync(file, 0o600);
  for (const target of [path.join(maintenanceHome, "coupon-deadline-20260922.tar.gz"), path.join(maintenanceHome, "coupon-deadline-backup-20260922.tar.gz"), path.join(maintenanceHome, "finish-deadline-maintenance.cjs")]) {
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }
  console.log(JSON.stringify({ temporaryKeyRevoked: true, otherAuthorizedKeysPreserved: true }));
} else throw new Error('Expected backup or revoke');
