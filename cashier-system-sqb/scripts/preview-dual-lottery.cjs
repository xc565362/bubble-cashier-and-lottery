'use strict';
// One localhost origin for the cashier and both H5s. Production connections are never opened.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createFixture } = require('./dual-lottery-fixture.cjs');
const { paymentMiddleware } = require('../payments/http.cjs');
const cashierRoot = path.resolve(__dirname, '../output/dual-lottery-20261008/preview-dist');
const allowedRead = new Set(['config', 'records', 'notifications', 'pending', 'diagnostics', 'restore-status']);
const isAllowedAction = action => (allowedRead.has(action) || /^(lottery|scarf|coupon)-[a-z-]+$/.test(action)) && !/connect|import-|export-/.test(action);

async function createPreviewServer({ port = 5211, fixture, root = cashierRoot } = {}) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('无效本机预览端口');
  if (!fs.existsSync(path.join(root, 'index.html'))) throw new Error('请先构建双活动预览：npm run build -- --outDir output/dual-lottery-20261008/preview-dist');
  const f = fixture || await createFixture(), origin = 'http://127.0.0.1:' + port;
  const gateways = f.createGateways(origin), middleware = paymentMiddleware(f.payments), runId = crypto.randomUUID();
  let closed = false;
  const banner = '<div style="padding:10px;background:#fff1bf;color:#624a04;text-align:center;font:14px/1.6 system-ui;position:relative;z-index:5">本机隔离演示 · 两个活动共用演示收银台 · 不能真实支付或领取　<a href="/" style="color:inherit">收银台</a>　<a href="/original-enter" target="_blank" rel="noopener" style="color:inherit">此刻在地 H5</a>　<a href="/scarf-enter" target="_blank" rel="noopener" style="color:inherit">山野有约 H5</a>　<span style="white-space:nowrap">新参与者：<a href="/original-enter?fresh=1" target="_blank" rel="noopener" style="color:inherit">此刻在地</a> / <a href="/scarf-enter?fresh=1" target="_blank" rel="noopener" style="color:inherit">山野有约</a></span></div>';
  async function route(req, res) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    // Browser assets and API calls also stay local, including any image URL entered into the demo manager.
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; worker-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'self'");
    if (req.headers.host !== '127.0.0.1:' + port) { res.writeHead(403); res.end(); return; }
    const url = new URL(req.url, origin), pathname = url.pathname;
    if (req.method === 'GET' && ['/original-enter', '/scarf-enter'].includes(pathname)) {
      const location = await gateways.enter(pathname === '/original-enter' ? 'original' : 'scarf', { fresh: url.searchParams.get('fresh') === '1' });
      res.writeHead(302, { Location: location }); res.end(); return;
    }
    if (pathname.startsWith('/original-api/') || pathname.startsWith('/scarf-api/')) {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 16000) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
      const gateway = pathname.startsWith('/original-api/') ? gateways.original : gateways.scarf;
      const result = await gateway({ httpMethod: req.method, path: pathname, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(result.statusCode, result.headers); res.end(result.body); return;
    }
    if (pathname.startsWith('/api/sqb/')) {
      if (!isAllowedAction(pathname.slice('/api/sqb/'.length))) { res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '隔离演示仅开放双活动管理和演示券核销，不连接真实收款服务' })); return; }
      await middleware(req, res, () => { res.writeHead(404); res.end(); }); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    if (['/original', '/scarf'].includes(pathname)) { res.writeHead(302, { Location: pathname + '/' }); res.end(); return; }
    const runtimeKind = pathname === '/original/runtime-config.js' ? 'original' : pathname === '/scarf/runtime-config.js' ? 'scarf' : null;
    if (runtimeKind) { res.setHeader('Content-Type', 'application/javascript; charset=utf-8'); res.end(req.method === 'HEAD' ? undefined : 'window.BUBBLE_H5_CONFIG=' + JSON.stringify({ mode: 'production', apiBase: origin + '/' + runtimeKind + '-api' })); return; }
    // The preview cannot be served later from an obsolete offline cashier cache.
    if (pathname === '/sw.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(req.method === 'HEAD' ? undefined : 'self.addEventListener("install",()=>self.skipWaiting());self.addEventListener("activate",event=>event.waitUntil(self.registration.unregister()));'); return; }
    const kind = pathname.startsWith('/original/') ? 'original' : pathname.startsWith('/scarf/') ? 'scarf' : null;
    const staticRoot = kind ? path.join(f[kind].h5Root, 'public') : path.resolve(root);
    let file;
    try { const relative = decodeURIComponent(kind ? pathname.slice(kind.length + 1) : pathname); file = path.resolve(staticRoot, '.' + (relative === '/' ? '/index.html' : relative)); }
    catch { res.writeHead(400); res.end(); return; }
    if (!file.startsWith(staticRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const extension = path.extname(file).toLowerCase();
    const type = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }[extension] || 'application/octet-stream';
    let bytes = fs.readFileSync(file);
    if (extension === '.html') {
      let html = bytes.toString('utf8').replace('<body>', '<body>' + banner);
      if (!kind) html = html.replace('</head>', '<script>if(localStorage.getItem("bubble_dual_demo_run")!==' + JSON.stringify(runId) + '){localStorage.setItem("stall_cashier_ledger_v2",' + JSON.stringify(JSON.stringify({ products: f.products, orders: [], heldCarts: [] })) + ');localStorage.setItem("bubble_dual_demo_run",' + JSON.stringify(runId) + ')}</script></head>');
      bytes = Buffer.from(html);
    }
    res.setHeader('Content-Type', type); res.end(req.method === 'HEAD' ? undefined : bytes);
  }
  const server = http.createServer((req, res) => route(req, res).catch(error => {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(error.message);
  }));
  const close = () => { if (closed) return; closed = true; server.closeAllConnections(); if (server.listening) server.close(); f.close(); };
  return { server, fixture: f, origin, close };
}

async function main() {
  const preview = await createPreviewServer({ port: Number(process.env.BUBBLE_DUAL_PORT || 5211) });
  preview.server.on('error', error => { preview.close(); console.error(error.message); process.exitCode = 1; });
  preview.server.listen(new URL(preview.origin).port, '127.0.0.1', () => console.log('Isolated dual-activity cashier + H5 preview: ' + preview.origin + '/ (no production connections)'));
  process.once('SIGINT', () => { preview.close(); process.exit(0); });
  process.once('SIGTERM', () => { preview.close(); process.exit(0); });
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { createPreviewServer, isAllowedAction, cashierRoot };
