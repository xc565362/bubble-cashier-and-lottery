'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createService } = require('../payments/service.cjs');
const { createAuthStore } = require('./auth.cjs');
const { createServerProtector } = require('./secrets.cjs');
const { createOnlineLedger } = require('./ledger.cjs');
const { createOnlineHandler } = require('./http.cjs');
const { createSetup } = require('./setup.cjs');
const { createPool, assertReachable, ensureSchema } = require('./mysql.cjs');

async function startOnlineServer({ directory = process.env.BUBBLE_ONLINE_DATA_DIR,
  keyFile = process.env.BUBBLE_ONLINE_KEY_FILE,
  publicOrigin = process.env.PUBLIC_ORIGIN,
  port = Number(process.env.PORT || 5175), host = process.env.HOST || '127.0.0.1',
  allowHttpLocal = process.env.BUBBLE_ALLOW_HTTP_LOCAL === '1',
  setupFile = process.env.BUBBLE_ONLINE_SETUP_FILE,
  staticRoot = path.resolve(__dirname, '../dist'), fetchFn = fetch, pool = null } = {}) {
  if (!directory || !path.isAbsolute(directory)) throw new Error('请设置独立的绝对路径 BUBBLE_ONLINE_DATA_DIR');
  if (!keyFile || !path.isAbsolute(keyFile)) throw new Error('请设置独立的绝对路径 BUBBLE_ONLINE_KEY_FILE');
  if (!publicOrigin) throw new Error('请设置 PUBLIC_ORIGIN 正式 HTTPS 地址');
  if (allowHttpLocal && !['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('本机测试模式只能监听回环地址');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const ownPool = !pool;
  pool = pool || createPool();
  let service, auth, ledger, handler;
  try {
    await assertReachable(pool);
    await ensureSchema(pool);
    const protector = createServerProtector({ keyFile });
    service = createService({ directory: path.join(directory, 'payments'), ...protector, fetchFn, exclusive: true });
    auth = createAuthStore({ pool });
    ledger = await createOnlineLedger({ pool, service });
    const setup = setupFile ? createSetup({ auth, file: setupFile }) : undefined;
    handler = createOnlineHandler({ auth, ledger, service, publicOrigin, staticRoot, setup, allowHttpLocal, trustProxy: true });
  } catch (error) { ledger?.close(); auth?.close(); service?.close(); if (ownPool) await pool.end().catch(() => {}); throw error; }
  const server = http.createServer(handler);
  server.headersTimeout = 15000;
  server.requestTimeout = 120000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 80;
  let closed = false;
  const close = () => new Promise(resolve => {
    if (closed) return resolve(); closed = true;
    server.close(() => { ledger.close(); auth.close(); service.close(); if (ownPool) pool.end(() => resolve()); else resolve(); });
    server.closeIdleConnections();
  });
  server.listen(port, host);
  return { server, auth, ledger, service, close };
}
if (require.main === module) {
  startOnlineServer().then(app => {
    app.server.on('listening', () => console.log('Bubble online cashier started. Use the configured HTTPS address.'));
    app.server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '在线服务端口已被占用' : '在线服务启动失败'); app.close().then(() => { process.exitCode = 1; }); });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { app.close().then(() => process.exit(0)); });
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { startOnlineServer };
