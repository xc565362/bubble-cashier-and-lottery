// Uses the existing merchant signing key. Only signed order queries are sent.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { parseArgs } = require('node:util');
const { createService, atomicWrite } = require('../payments/service.cjs');
const { rsaKey, normalizePrivateKey, publicFingerprint } = require('../payments/credentials.cjs');
const { validateConfig, requestApi } = require('../payments/litepos.cjs');
const { createPublicIpResolver } = require('../payments/network.cjs');
const { safeMessage } = require('../payments/diagnostics.cjs');

async function activate({ runtime, appid, brand, store, gateway, platformFile, merchantKeyFile, merchantPublicFile, apply }, electron) {
  if (!apply || !['web', 'desktop'].includes(runtime) || !appid || !brand || !store || !platformFile) throw new Error('Explicit --apply, runtime, appid, brand, store and platform-key are required.');
  if (runtime === 'desktop' && !electron) throw new Error('Desktop activation must run with Electron OS key storage.');
  const directory = runtime === 'web' ? path.join(os.homedir(), '.stall-cashier-sqb-web') : path.join(electron.app.getPath('userData'), 'sqb');
  const credentials = JSON.parse(fs.readFileSync(path.join(directory, 'credentials.json'), 'utf8'));
  if (!credentials.config || !credentials.key?.privateKey) throw new Error('Existing configured credentials are required; no keys will be generated.');
  const read = (name, fallback) => fs.existsSync(path.join(directory, name)) ? JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) : fallback;
  if (Object.values(read('payments.json', {})).some(row => !row.acknowledged)) throw new Error('Resolve all unacknowledged payments/refunds before changing merchant.');
  if (read('restore-stage.json', null) || Object.values(read('coupon-transactions.json', {})).some(row => !row.finished)) throw new Error('Resolve pending restore/coupon operations first.');
  const platformPublicKey = rsaKey(fs.readFileSync(platformFile, 'utf8')).export({ type: 'spki', format: 'pem' });
  const url = new URL(gateway);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Gateway must be an HTTPS origin without credentials or parameters.');
  const next = validateConfig({ ...credentials.config, appid, brand_code: brand, store_sn: store, gateway: url.origin, platformPublicKey, mode: 'production' });
  const unprotect = runtime === 'desktop' ? value => electron.safeStorage.decryptString(Buffer.from(value, 'base64')) : value => value;
  const signing = merchantKeyFile ? JSON.parse(fs.readFileSync(merchantKeyFile, 'utf8')) : credentials.key;
  const pair = normalizePrivateKey(merchantKeyFile ? signing.privateKey : unprotect(signing.privateKey));
  const fingerprint = publicFingerprint(pair.publicKey);
  if (fingerprint !== publicFingerprint(signing.publicKey)) throw new Error('Existing public and private keys do not match.');
  if (merchantKeyFile && (!merchantPublicFile || fingerprint !== publicFingerprint(fs.readFileSync(merchantPublicFile, 'utf8')))) throw new Error('Recovered key must match the public key previously supplied to SQB.');
  const journalFile = path.join(directory, 'payments.json');
  const journalHash = () => fs.existsSync(journalFile) ? crypto.createHash('sha256').update(fs.readFileSync(journalFile)).digest('hex') : null;
  const beforeJournal = journalHash();
  // Setup can wait longer for fresh IP discovery; do not reuse a stale address.
  const resolveTerminalIp = createPublicIpResolver((url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) }));
  const service = createService({ directory, exclusive: true, unprotect, resolveTerminalIp,
    protect: runtime === 'desktop' ? value => electron.safeStorage.encryptString(value).toString('base64') : value => value });
  try {
    const terminalIp = await resolveTerminalIp({ fresh: true });
    const checkSn = `CHK${Date.now()}${crypto.randomBytes(6).toString('hex')}`;
    let verified = false;
    try {
      await requestApi(next, pair.privateKey, '/api/lite-pos/v1/sales/query', { brand_code: next.brand_code, store_sn: next.store_sn,
        workstation_sn: next.workstation_sn, check_sn: checkSn }, fetch, terminalIp);
    } catch (error) {
      if (error.verifiedResponse === true && error.gatewayCode === 'ACQ.ORDER_NOT_FOUND') verified = true;
      else throw new Error(`Production probe failed; original configuration unchanged: ${safeMessage(error.message)}`);
    }
    if (!verified) throw new Error('Unexpected existing probe order; original configuration unchanged.');
    await service.dispatch('import-credentials', { config: next, privateKey: pair.privateKey, confirmReplace: true });
    const active = await service.dispatch('check-connection');
    if (!active.connectionCheck?.verified || active.keyFingerprint !== fingerprint || journalHash() !== beforeJournal) {
      await service.dispatch('import-credentials', { config: credentials.config, privateKey: unprotect(credentials.key.privateKey), confirmReplace: true });
      throw new Error('Post-save verification failed; restored the original configuration.');
    }
    const report = { activatedAt: new Date().toISOString(), runtime, directory, mode: active.mode, appid: active.appid, brand_code: active.brand_code,
      store_sn: active.store_sn, gateway: active.gateway, ready: active.ready, verifiedQuery: active.connectionCheck.verified,
      resultCode: active.connectionCheck.code, reusedExistingMerchantKey: true, generatedNewKey: false, paymentJournalUnchanged: true,
      previousKeyFingerprint: publicFingerprint(credentials.key.publicKey),
      merchantKeyFingerprint: fingerprint, platformKeyFingerprint: publicFingerprint(platformPublicKey), moneyMovingRequests: 0 };
    atomicWrite(path.join(directory, 'production-activation.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { service.close(); }
}

const { values } = parseArgs({ args: process.argv.slice(2), options: {
  runtime: { type: 'string', default: 'web' }, appid: { type: 'string' }, brand: { type: 'string' }, store: { type: 'string' },
  gateway: { type: 'string' }, 'platform-key': { type: 'string' }, apply: { type: 'boolean', default: false },
  'merchant-key-json': { type: 'string' }, 'merchant-public-file': { type: 'string' },
} });
const input = { ...values, platformFile: values['platform-key'], merchantKeyFile: values['merchant-key-json'], merchantPublicFile: values['merchant-public-file'] };
const electron = process.versions.electron ? require('electron') : null;
async function main() {
  if (electron) {
    const name = require('../package.json').name;
    electron.app.setName(name);
    electron.app.setPath('userData', path.join(electron.app.getPath('appData'), name));
    await electron.app.whenReady();
    if (!electron.safeStorage.isEncryptionAvailable()) throw new Error('OS key storage is unavailable.');
  }
  await activate(input, electron);
  if (electron) electron.app.quit();
}
main().catch(error => {
  console.error(safeMessage(error.message));
  if (electron) electron.app.exit(1); else process.exitCode = 1;
});
