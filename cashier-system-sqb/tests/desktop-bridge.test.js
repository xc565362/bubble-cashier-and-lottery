import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('desktop bridge exposes refund and complete migration actions without exposing arbitrary IPC', async () => {
  let api;
  const calls = [];
  const sandbox = { require(name) {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld(key, value) { assert.equal(key, 'sqb'); api = value; } },
      ipcRenderer: { invoke(channel, action, payload) { calls.push({ channel, action, payload }); return Promise.resolve({ ok: true }); } } };
  } };
  vm.runInNewContext(fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8'), sandbox);
  for (const action of ['preview-adjustment', 'start-adjustment', 'export-backup', 'prepare-restore', 'commit-restore', 'abort-restore', 'restore-status', 'coupon-physical-bindings', 'coupon-bind-physical-products', 'coupon-fulfilment', 'lottery-config', 'lottery-snapshot', 'lottery-connect', 'lottery-update', 'lottery-increase-capacity', 'lottery-export-connection', 'lottery-import-connection']) {
    assert.equal((await api.call(action, { sample: true })).ok, true);
    assert.deepEqual(calls.at(-1), { channel: 'sqb:call', action, payload: { sample: true } });
  }
  await assert.rejects(api.call('arbitrary-command'), /不支持/);
  assert.equal(calls.length, 17);
});

test('desktop windows fit the available display and allow short screens on Windows and Mac', async () => {
  for (const platform of ['win32', 'darwin']) {
    for (const area of [{ width: 1920, height: 1040 }, { width: 1024, height: 560 }, { width: 320, height: 300 }]) {
      let options;
      const electron = {
        app: { isPackaged: true, setAppUserModelId() {}, requestSingleInstanceLock: () => true,
          whenReady: () => Promise.resolve(), getPath: () => '/isolated-profile', on() {} },
        screen: { getPrimaryDisplay: () => ({ workAreaSize: area }) },
        BrowserWindow: class {
          constructor(value) { options = value; this.webContents = { setWindowOpenHandler() {}, on() {} }; }
          loadFile() {}
        },
        ipcMain: { handle() {} }, Menu: { setApplicationMenu() {} },
        session: { defaultSession: { setPermissionRequestHandler() {} } },
      };
      vm.runInNewContext(fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8'), {
        __dirname: fileURLToPath(new URL('../electron', import.meta.url)), process: { platform, env: {} },
        require(name) {
          if (name === 'electron') return electron;
          if (name === 'node:path') return path;
          if (name === 'node:url') return { pathToFileURL: value => ({ href: value }) };
          if (name === '../payments/service.cjs') return { createService: () => ({}) };
          if (name === './notifications.cjs') return { showPaymentNotification() {} };
          throw new Error(`Unexpected module: ${name}`);
        },
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(options.width, Math.min(1180, area.width));
      assert.equal(options.height, Math.min(820, area.height));
      assert.ok(options.minWidth <= area.width);
      assert.equal(options.minHeight, Math.min(360, area.height));
      assert.equal(options.webPreferences.contextIsolation, true);
      assert.equal(options.webPreferences.sandbox, true);
    }
  }
});
