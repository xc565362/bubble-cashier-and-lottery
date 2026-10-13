// Run with Electron. Only imports an already-authorized local credential set and queries connectivity.
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createService } = require('../payments/service.cjs');
const packageInfo = require('../package.json');

app.setName(packageInfo.name);
app.setPath('userData', path.join(app.getPath('appData'), packageInfo.name));
app.whenReady().then(async () => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS key storage unavailable');
  const source = path.join(os.homedir(), '.stall-cashier-sqb-web', 'credentials.json');
  const imported = JSON.parse(fs.readFileSync(source, 'utf8'));
  if (imported.version !== 1 || !imported.config || !imported.key?.privateKey) throw new Error('Invalid local credential source');
  const service = createService({ directory: path.join(app.getPath('userData'), 'sqb'), exclusive: true,
    protect: (value) => safeStorage.encryptString(value).toString('base64'),
    unprotect: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
  });
  const importedConfig = await service.dispatch('import-credentials', { config: imported.config, privateKey: imported.key.privateKey, confirmReplace: true });
  const checked = await service.dispatch('check-connection');
  console.log(JSON.stringify({ configured: importedConfig.ready, mode: checked.mode, appid: checked.appid,
    keyFingerprint: checked.keyFingerprint, encryptedWithOS: true, connectionCheck: checked.connectionCheck, userData: app.getPath('userData'), moneyMovingRequests: 0 }));
  app.quit();
}).catch(() => { console.error('Desktop configuration failed. Existing business data was not modified; secret details withheld.'); app.exit(1); });
