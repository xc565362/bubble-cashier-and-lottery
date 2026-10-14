'use strict';

// Run while the online service is stopped, as its service account. Secrets are
// read from one explicitly named private file, never from command-line values.
// The only mutation outside encrypted connection files is coupon-connect's
// registration of this server's cashier device. No financial/lottery operation
// or account/ledger module is invoked here.
const fs = require('node:fs');
const path = require('node:path');
const { createServerProtector } = require('./secrets.cjs');
const { createService } = require('../payments/service.cjs');

const MAX_FILE_BYTES = 65536;
const SCARF_CAMPAIGN = 'scarf-xhs-50-v1';
const CAPABILITIES = new Set(['physical-prize-v1', 'quota-increase-v1', 'redemption-deadline-v1', 'lottery-catalog-v1', 'rules-text-v1']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = category => Object.assign(new Error(category), { provisionFailure: category });
const reject = category => { throw failure(category); };

function shape(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) reject('invalid_configuration');
}
function endpoint(value, kind) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value)) reject('invalid_configuration');
  let url; try { url = new URL(value); } catch { reject('invalid_configuration'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) reject('invalid_configuration');
  if (kind === 'coupon' && url.pathname !== '/' || kind === 'lottery' && url.pathname === '/' || kind === 'scarf' && url.pathname !== '/api/scarf-management') reject('invalid_configuration');
  return kind === 'coupon' ? url.origin : url.href;
}
function validateConnections(input) {
  shape(input, ['coupon', 'lottery', 'scarf']);
  if (!Object.keys(input).length) reject('invalid_configuration');
  const normalized = {};
  if (Object.hasOwn(input, 'coupon')) {
    const value = input.coupon; shape(value, ['mode', 'baseUrl', 'adminToken']);
    if (value.mode !== undefined && value.mode !== 'remote' || !/^[A-Za-z0-9_.-]{32,300}$/.test(value.adminToken || '')) reject('invalid_configuration');
    normalized.coupon = { mode: 'remote', baseUrl: endpoint(value.baseUrl, 'coupon'), adminToken: value.adminToken };
  }
  for (const component of ['lottery', 'scarf']) if (Object.hasOwn(input, component)) {
    const value = input[component]; shape(value, ['url', 'campaignId', 'key']);
    if (typeof value.campaignId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value.campaignId) || component === 'scarf' && value.campaignId !== SCARF_CAMPAIGN || !/^[0-9a-f]{64}$/.test(value.key || '')) reject('invalid_configuration');
    normalized[component] = { url: endpoint(value.url, component), campaignId: value.campaignId, key: value.key };
  }
  return normalized;
}
function readPrivateJson(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) reject('invalid_file_path');
  let descriptor;
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_FILE_BYTES || process.platform !== 'win32' && (stat.mode & 0o077) !== 0) reject('file_not_private_or_regular');
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size < 2 || opened.size > MAX_FILE_BYTES || opened.dev !== stat.dev || opened.ino !== stat.ino) reject('file_changed');
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    const size = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (size > MAX_FILE_BYTES || size !== opened.size) reject('file_changed');
    let parsed; try { parsed = JSON.parse(bytes.subarray(0, size).toString('utf8').replace(/^\uFEFF/, '')); } catch { reject('invalid_json'); }
    return validateConnections(parsed);
  } catch (error) { if (error.provisionFailure) throw error; throw failure('file_unavailable'); }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
function safeCategory(error, fallback) {
  const known = new Set(['invalid_arguments', 'invalid_environment', 'invalid_configuration', 'invalid_file_path', 'file_not_private_or_regular', 'file_changed', 'invalid_json', 'file_unavailable']);
  if (known.has(error?.provisionFailure)) return error.provisionFailure;
  if (error?.code === 'SECRET_INVALID') return 'server_encryption_unavailable';
  if (['UNAUTHORIZED', 'FORBIDDEN', 'INVALID_SIGNATURE', 'INVALID_KEY'].includes(error?.code)) return 'authorization_rejected';
  if (['AbortError', 'TimeoutError'].includes(error?.name) || ['ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND'].includes(error?.code)) return 'network_unavailable';
  return fallback;
}
function publicReport(component, configured, data, secrets) {
  const candidate = data?.centerId || data?.fulfillment?.centerId || '';
  const centerId = typeof candidate === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(candidate) && !secrets.some(secret => candidate.includes(secret)) ? candidate : '';
  const offered = Array.isArray(data?.capabilities) ? data.capabilities : [];
  const capabilities = [...new Set(offered.filter(value => CAPABILITIES.has(value)))];
  if (data?.physicalSupported === true && !capabilities.includes('physical-prize-v1')) capabilities.push('physical-prize-v1');
  if (data?.lotteryCatalogSupported === true && !capabilities.includes('lottery-catalog-v1')) capabilities.push('lottery-catalog-v1');
  return { component, configured, centerId, capabilities };
}
async function provisionConnections({ input, directory, keyFile, report = () => {}, serviceFactory = createService, protectorFactory = createServerProtector } = {}) {
  const normalized = validateConnections(input);
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || typeof keyFile !== 'string' || !path.isAbsolute(keyFile) || path.resolve(directory) === path.resolve(keyFile)) reject('invalid_environment');
  const secrets = Object.values(normalized).flatMap(value => [value.key, value.adminToken].filter(Boolean));
  let service; const results = [];
  try {
    let protector;
    try { protector = protectorFactory({ keyFile }); } catch (error) { const result = { component: 'server', configured: false, failure: safeCategory(error, 'server_encryption_unavailable') }; results.push(result); report(result); return { ok: false, results }; }
    try { service = serviceFactory({ directory: path.join(directory, 'payments'), ...protector, exclusive: true }); }
    catch (error) { const result = { component: 'server', configured: false, failure: safeCategory(error, 'service_unavailable_or_running') }; results.push(result); report(result); return { ok: false, results }; }
    for (const component of ['coupon', 'lottery', 'scarf']) {
      if (!normalized[component]) continue;
      let connected = false, data;
      try {
        data = await service.dispatch(`${component}-connect`, normalized[component]); connected = component === 'coupon' ? data?.connected === true : data?.configured === true;
        if (!connected) throw failure('unexpected_connection_response');
        if (component !== 'coupon') data = await service.dispatch(`${component}-snapshot`, {});
        const result = publicReport(component, true, data, secrets); results.push(result); report(result);
      } catch (error) {
        const result = { ...publicReport(component, connected, connected ? data : null, secrets), failure: safeCategory(error, connected ? 'capability_check_failed' : 'connection_failed') };
        results.push(result); report(result);
      }
    }
    return { ok: results.every(result => !result.failure), results };
  } finally { service?.close(); }
}
async function main({ argv = process.argv.slice(2), env = process.env, write = line => process.stdout.write(line), ...dependencies } = {}) {
  try {
    if (argv.length !== 2 || argv[0] !== '--file') reject('invalid_arguments');
    const input = readPrivateJson(argv[1]);
    const result = await provisionConnections({ input, directory: env.BUBBLE_ONLINE_DATA_DIR, keyFile: env.BUBBLE_ONLINE_KEY_FILE, ...dependencies,
      report: entry => write(JSON.stringify(entry) + '\n') });
    return result.ok ? 0 : 1;
  } catch (error) { write(JSON.stringify({ component: 'server', configured: false, failure: safeCategory(error, 'provision_failed') }) + '\n'); return 1; }
}
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(() => { process.stderr.write('{"component":"server","configured":false,"failure":"provision_failed"}\n'); process.exitCode = 1; });
module.exports = { validateConnections, readPrivateJson, provisionConnections, main };
