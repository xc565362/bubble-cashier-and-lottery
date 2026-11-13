'use strict';
// Independent read-only reconciliation. Never overwrite the original audit or
// a business file. SQLite witness copies contain private data and stay private.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const allowedSidecars = new Set(['coupon-development/coupons.sqlite-shm', 'coupon-development/coupons.sqlite-wal']);
const developmentDatabase = 'coupon-development/coupons.sqlite';
function walFingerprint(file) {
  if (!fs.existsSync(file)) return null;
  const bytes = read(file); return bytes.length ? sha(bytes) : null;
}
function read(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink()) fail('UNSAFE_FILE', 'Expected a regular private file');
  return fs.readFileSync(file);
}
function files(root) {
  const out = {};
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (entry.name === 'service.lock' || entry.name.startsWith('.migration-backup-')) continue;
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) fail('UNSAFE_FILE', 'Unexpected symlink in business directory');
    if (entry.isDirectory()) for (const [key, value] of Object.entries(files(file))) out[entry.name + '/' + key] = value;
    else if (entry.isFile()) out[entry.name] = sha(read(file));
    else fail('UNSAFE_FILE', 'Unexpected special file in business directory');
  }
  return out;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const digest = value => sha(JSON.stringify(canonical(value)));
function mapDifference(before, after) {
  return {
    added: Object.keys(after).filter(key => !Object.hasOwn(before, key)).sort(),
    missing: Object.keys(before).filter(key => !Object.hasOwn(after, key)).sort(),
    changed: Object.keys(before).filter(key => Object.hasOwn(after, key) && before[key] !== after[key]).sort(),
  };
}
function validatePaymentMap(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail('INVALID_BASELINE', 'Original payment witness is missing');
  for (const [name, valueHash] of Object.entries(value)) if (!name || name.includes('\\') || path.isAbsolute(name) || name.split('/').some(part => !part || part === '.' || part === '..') || !/^[a-f0-9]{64}$/.test(valueHash)) fail('INVALID_BASELINE', 'Original payment witness has unsafe paths or hashes');
  if (!value[developmentDatabase]) fail('INVALID_BASELINE', 'Original development database witness is missing');
}
const quote = name => '"' + name.replaceAll('"', '""') + '"';
function logicalDatabase(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    if (Object.values(db.prepare('PRAGMA quick_check').get())[0] !== 'ok') fail('DATABASE_INVALID', 'SQLite integrity validation failed');
    const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name,tbl_name').all();
    const tables = {};
    // Include internal sequence/statistics tables too; no business table allowlist.
    for (const item of schema.filter(item => item.type === 'table')) {
      const statement = db.prepare(`SELECT * FROM ${quote(item.name)}`);
      statement.setReadBigInts(true);
      statement.setReturnArrays(true);
      const rows = statement.all().map(row => JSON.stringify(row.map(value => {
        if (value === null) return ['null'];
        if (typeof value === 'bigint') return ['integer', value.toString()];
        if (typeof value === 'number') return ['real', value];
        if (typeof value === 'string') return ['text', value];
        if (value instanceof Uint8Array) return ['blob', Buffer.from(value).toString('base64')];
        fail('DATABASE_VALUE', 'Unsupported SQLite value');
      }))).sort();
      tables[item.name] = { count: rows.length, sha256: sha(JSON.stringify(rows)) };
    }
    return { schemaHash: digest(schema), userVersion: db.prepare('PRAGMA user_version').get().user_version, applicationId: db.prepare('PRAGMA application_id').get().application_id, tables };
  } finally { db.close(); }
}
function compareDevelopment({ root, baseline, witnessDirectory }) {
  validatePaymentMap(baseline);
  const observed = files(root), difference = mapDifference(baseline, observed);
  if (difference.missing.length || difference.changed.length || difference.added.some(name => !allowedSidecars.has(name))) return { ok: false, code: 'PAYMENT_FILES_CHANGED', difference };
  const source = path.join(root, ...developmentDatabase.split('/'));
  const copy = path.join(witnessDirectory, 'unchanged-development-base.sqlite');
  const walBefore = walFingerprint(source + '-wal');
  fs.copyFileSync(source, copy, fs.constants.COPYFILE_EXCL); fs.chmodSync(copy, 0o600);
  const expected = baseline[developmentDatabase];
  if (sha(read(copy)) !== expected || sha(read(source)) !== expected) fail('DATABASE_COPY_RACE', 'Database base changed while creating witness');
  const base = logicalDatabase(copy), live = logicalDatabase(source);
  if (sha(read(copy)) !== expected || sha(read(source)) !== expected) fail('DATABASE_COPY_RACE', 'Database base changed during read-only comparison');
  const latest = files(root), finalDifference = mapDifference(baseline, latest);
  if (walFingerprint(source + '-wal') !== walBefore) fail('DATABASE_WAL_RACE', 'Database WAL changed during read-only comparison');
  if (finalDifference.missing.length || finalDifference.changed.length || finalDifference.added.some(name => !allowedSidecars.has(name))) return { ok: false, code: 'PAYMENT_FILES_CHANGED', difference: finalDifference };
  const equal = digest(base) === digest(live);
  // Sidecars are excluded only after their database's full logical state matches.
  const normalized = { ...latest };
  if (equal) for (const name of finalDifference.added) delete normalized[name];
  return { ok: equal, code: equal ? null : 'DEVELOPMENT_DATABASE_CHANGED', difference: finalDifference,
    baselineFiles: Object.keys(baseline).length, observedFiles: Object.keys(latest).length,
    originalFileBytesUnchanged: true, validatedSidecars: equal ? finalDifference.added : [],
    baseOnlyWitness: copy, baseFileSha256: expected, base, live, logicalEqual: equal,
    walStableDuringComparison: true,
    canonicalBaselineHash: digest(baseline), canonicalObservedHash: digest(latest),
    canonicalReconciledHash: digest(normalized), reconciledPayments: normalized };
}
function environment(file) {
  const out = {};
  for (const line of read(file).toString().split(/\r?\n/)) {
    const value = line.trim(); if (!value || value.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(value);
    if (!match || Object.hasOwn(out, match[1])) fail('INVALID_ENV', 'Unsupported existing environment format');
    out[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
// Exactly the original audit row/hash encoding, for comparable evidence.
function businessTables(file, names) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN'); const out = {};
    for (const name of names) { const rows = db.prepare(`SELECT * FROM ${quote(name)}`).all().map(row => JSON.stringify(row)).sort(); out[name] = { count: rows.length, sha256: sha(JSON.stringify(rows)) }; }
    return out;
  } finally { db.close(); }
}
function currentState(payments) {
  const online = environment('/etc/bubble-online/service.env'), coupon = environment('/var/lib/bubble-coupons/deployment/coupon.env');
  if (online.BUBBLE_ONLINE_DATA_DIR !== '/var/lib/bubble-online' || !/^\/var\/lib\/bubble-coupons(?:\/[A-Za-z0-9_-]+)*$/.test(coupon.COUPON_DATA_DIR || '') || fs.realpathSync(coupon.COUPON_DATA_DIR) !== coupon.COUPON_DATA_DIR) fail('INVALID_ENV', 'Unexpected business data location');
  return {
    onlineLedger: businessTables('/var/lib/bubble-online/ledger.sqlite', ['online_ledger', 'online_commands', 'online_ack', 'online_awards']),
    users: businessTables('/var/lib/bubble-online/accounts.sqlite', ['users']),
    coupons: businessTables(path.join(coupon.COUPON_DATA_DIR, 'coupons.sqlite'), ['meta', 'campaigns', 'coupons', 'api_keys', 'operations', 'events', 'coupon_tokens']),
    payments,
    protectedFiles: Object.fromEntries(['/etc/bubble-online/service.env', '/etc/bubble-online/keys/config.key', '/var/lib/bubble-coupons/deployment/coupon.env'].map(file => [file, sha(read(file))])),
  };
}
function privatePath(file, exists) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file) fail('INVALID_PATH', 'Use an explicit absolute private path');
  const parent = fs.realpathSync(path.dirname(file));
  if (parent !== path.dirname(file) || !(parent === '/var/lib/bubble-online-deploy-backups' || parent.startsWith('/var/lib/bubble-online-deploy-backups/'))) fail('INVALID_PATH', 'Witness must stay in the private deployment backup directory');
  const st = fs.statSync(parent);
  if (st.uid !== 0 || (st.mode & 0o077)) fail('UNSAFE_DIRECTORY', 'Witness directory must be root-only');
  if (exists) read(file); else if (fs.existsSync(file)) fail('REPORT_EXISTS', 'Refusing to replace existing evidence');
}
function reconcile({ beforeFile, afterFile, reportFile }) {
  for (const file of [beforeFile, afterFile]) privatePath(file, true); privatePath(reportFile, false);
  if (beforeFile === afterFile || reportFile === beforeFile || reportFile === afterFile) fail('INVALID_PATH', 'Evidence paths must be distinct');
  const beforeBytes = read(beforeFile), afterBytes = read(afterFile), before = JSON.parse(beforeBytes), after = JSON.parse(afterBytes);
  if (!before.state || sha(JSON.stringify(before.state)) !== before.stateHash || after.beforeHash !== before.stateHash || after.phase !== 'after') fail('INVALID_BASELINE', 'Original audit evidence does not match');
  const witnessDirectory = reportFile + '.witness'; fs.mkdirSync(witnessDirectory, { mode: 0o700 });
  const result = { kind: 'preservation-reconciliation-v1', at: new Date().toISOString(), scope: 'original-baseline-to-current-read-only-observation',
    originalEvidence: [{ file: beforeFile, sha256: sha(beforeBytes) }, { file: afterFile, sha256: sha(afterBytes) }], witnessDirectory, readOnlyBusiness: true, originalsPreserved: true };
  try {
    const comparison = compareDevelopment({ root: '/var/lib/bubble-online/payments', baseline: before.state.payments, witnessDirectory });
    const { reconciledPayments, ...proof } = comparison; result.development = proof;
    if (!comparison.ok) { result.ok = false; result.code = comparison.code; }
    else {
      const state = currentState(reconciledPayments);
      const changed = [...new Set([...Object.keys(before.state), ...Object.keys(state)])].filter(key => digest(before.state[key]) !== digest(state[key]));
      result.ok = changed.length === 0; result.changed = changed; result.state = state;
      result.canonicalBeforeHash = digest(before.state); result.canonicalCurrentHash = digest(state);
      result.excludedOnlyAfterLogicalValidation = comparison.validatedSidecars;
    }
    if (sha(read(beforeFile)) !== sha(beforeBytes) || sha(read(afterFile)) !== sha(afterBytes)) fail('EVIDENCE_CHANGED', 'Original evidence changed during reconciliation');
  } catch (error) { result.ok = false; result.code = error.code || 'RECONCILIATION_FAILED'; }
  fs.writeFileSync(reportFile, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  return result;
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 6 || args[0] !== '--before' || args[2] !== '--after' || args[4] !== '--report') fail('INVALID_ARGS', 'Usage: --before /private/before.json --after /private/after.json --report /private/new-reconciliation.json');
    const result = reconcile({ beforeFile: args[1], afterFile: args[3], reportFile: args[5] });
    console.log(JSON.stringify({ ok: result.ok, report: args[5], code: result.code || null, changed: result.changed || [],
      originalFileBytesUnchanged: result.development?.originalFileBytesUnchanged || false,
      logicalDatabaseEqual: result.development?.logicalEqual || false,
      baselineFiles: result.development?.baselineFiles, observedFiles: result.development?.observedFiles,
      validatedSidecars: result.development?.validatedSidecars || [], readOnlyBusiness: true }));
    if (!result.ok) process.exitCode = 2;
  } catch (error) { console.error(JSON.stringify({ ok: false, code: error.code || 'RECONCILIATION_FAILED' })); process.exitCode = 2; }
}
module.exports = { files, digest, mapDifference, logicalDatabase, compareDevelopment, reconcile };
