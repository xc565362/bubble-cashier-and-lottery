const { app, BrowserWindow, Menu, session, shell, ipcMain, safeStorage, Notification, screen } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createService } = require('../payments/service.cjs');
const { showPaymentNotification } = require('./notifications.cjs');

if (process.platform === 'win32') app.setAppUserModelId('com.stall.cashier');

const isDev = !app.isPackaged;
if (!app.requestSingleInstanceLock()) app.quit();
let mainWindow;

function createMainWindow() {
  const available = screen.getPrimaryDisplay().workAreaSize;
  const window = new BrowserWindow({
    width: Math.min(1180, available.width),
    height: Math.min(820, available.height),
    minWidth: Math.min(390, available.width),
    minHeight: Math.min(360, available.height),
    title: '摆摊收银台',
    backgroundColor: '#f7f8f4',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow = window;

  if (isDev) {
    window.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173/');
  } else {
    window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
}

app.whenReady().then(() => {
  const service = createService({
    exclusive: true,
    directory: path.join(app.getPath('userData'), 'sqb'),
    protect: (value) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥存储不可用，请解锁系统钥匙串后重试');
      return safeStorage.encryptString(value).toString('base64');
    },
    unprotect: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
  });
  ipcMain.handle('sqb:call', async (event, action, payload) => {
    const expected = isDev ? (process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173/') : pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;
    if (event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== expected || event.sender !== mainWindow?.webContents) return { ok: false, error: '来源未授权' };
    try {
      const data = await service.dispatch(action, payload);
      if (action === 'claim-payment-notification' && data) {
        const shown = await showPaymentNotification(Notification, data, () => {
          if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
        });
        return { ok: true, data: { desktop: true, shown } };
      }
      return { ok: true, data };
    }
    catch (error) { return { ok: false, error: error.message }; }
  });
  Menu.setApplicationMenu(null);

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media');
  });

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
