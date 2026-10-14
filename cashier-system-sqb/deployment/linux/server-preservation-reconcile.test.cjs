'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { files, digest, mapDifference, logicalDatabase, compareDevelopment } = require('./server-preservation-reconcile.cjs');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-preservation-proof-'));
  const root = path.join(directory, 'payments'), development = path.join(root, 'coupon-development'), witnessDirectory = path.join(directory, 'witness');
  fs.mkdirSync(development, { recursive: true }); fs.mkdirSync(witnessDirectory);
  const file = path.join(development, 'coupons.sqlite');
  let db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE prizes(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, payload BLOB, realvalue REAL); INSERT INTO prizes(name,payload,realvalue) VALUES('existing',X'000102ff',1.5); CREATE INDEX prize_name ON prizes(name); PRAGMA user_version=4");
  db.close();
  fs.writeFileSync(path.join(root, 'payment-config.json'), '{"ciphertext":"isolated-fixture"}');
  const baseline = files(root);
  db = new DatabaseSync(file); db.exec('PRAGMA wal_autocheckpoint=0');
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { root, baseline, witnessDirectory, file, db };
}
test('canonical equality ignores map insertion order but keeps recursive relative file paths', () => {
  const a = { 'coupon-development/coupons.sqlite': 'first', 'payment-config.json': 'second' };
  const b = { 'payment-config.json': 'second', 'coupon-development/coupons.sqlite': 'first' };
  assert.notEqual(JSON.stringify(a), JSON.stringify(b)); assert.equal(digest(a), digest(b));
  assert.deepEqual(mapDifference(a, b), { added: [], missing: [], changed: [] });
});
test('new WAL/SHM accepted only after base-only copy matches all live logical tables including WAL', t => {
  const f = fixture(t);
  f.db.exec("BEGIN IMMEDIATE; UPDATE prizes SET name='temporary'; UPDATE prizes SET name='existing'; COMMIT");
  assert.ok(fs.statSync(f.file + '-wal').size > 0);
  const originalMain = fs.readFileSync(f.file), originalFiles = files(f.root);
  const result = compareDevelopment(f);
  assert.equal(result.ok, true); assert.equal(result.logicalEqual, true); assert.equal(result.originalFileBytesUnchanged, true);
  assert.deepEqual(result.validatedSidecars, ['coupon-development/coupons.sqlite-shm', 'coupon-development/coupons.sqlite-wal']);
  assert.equal(result.base.tables.prizes.count, 1); assert.equal(result.base.tables.sqlite_sequence.count, 1);
  assert.deepEqual(result.base, result.live); assert.deepEqual(result.reconciledPayments, f.baseline);
  assert.equal(result.canonicalBaselineHash, result.canonicalReconciledHash);
  assert.deepEqual(fs.readFileSync(f.file), originalMain);
  // SQLite can touch SHM read-lock metadata; compare every original business file.
  for (const key of Object.keys(f.baseline)) assert.equal(files(f.root)[key], originalFiles[key]);
  assert.equal(fs.readFileSync(result.baseOnlyWitness).equals(originalMain), true);
});
test('business rows changed only inside WAL fail proof even when every original file byte remains unchanged', t => {
  const f = fixture(t); f.db.exec("UPDATE prizes SET name='actual-business-change'");
  assert.equal(files(f.root)['coupon-development/coupons.sqlite'], f.baseline['coupon-development/coupons.sqlite']);
  const result = compareDevelopment(f);
  assert.equal(result.ok, false); assert.equal(result.code, 'DEVELOPMENT_DATABASE_CHANGED'); assert.equal(result.logicalEqual, false);
  assert.deepEqual(result.validatedSidecars, []); assert.notEqual(result.base.tables.prizes.sha256, result.live.tables.prizes.sha256);
  assert.ok(!JSON.stringify(result).includes('actual-business-change')); assert.ok(!JSON.stringify(result).includes('ciphertext'));
});
test('unexpected added files and modified original files are never ignored as SQLite startup metadata', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'other.sqlite-wal'), 'unrelated');
  let result = compareDevelopment(f); assert.equal(result.ok, false); assert.equal(result.code, 'PAYMENT_FILES_CHANGED');
  assert.deepEqual(result.difference.added, ['other.sqlite-wal']);
  fs.unlinkSync(path.join(f.root, 'other.sqlite-wal'));
  fs.appendFileSync(path.join(f.root, 'payment-config.json'), 'changed');
  result = compareDevelopment(f); assert.equal(result.ok, false); assert.deepEqual(result.difference.changed, ['payment-config.json']);
});
test('witness copy is exclusive and all table/schema differences are included', t => {
  const f = fixture(t), initial = logicalDatabase(f.file);
  assert.equal(compareDevelopment(f).ok, true);
  assert.throws(() => compareDevelopment(f), { code: 'EEXIST' });
  f.db.exec('CREATE TABLE extra_business(id INTEGER); INSERT INTO extra_business VALUES(1)');
  const changed = logicalDatabase(f.file); assert.notEqual(initial.schemaHash, changed.schemaHash); assert.equal(changed.tables.extra_business.count, 1);
});
