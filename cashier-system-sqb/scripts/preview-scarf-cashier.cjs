// Isolated local preview: temporary records, no outbound network, no real payments.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createFixture } = require('./scarf-cashier-fixture.cjs');
const { paymentMiddleware } = require('../payments/http.cjs');

async function main() {
  const f = await createFixture();
  const { createGateway } = require(path.join(f.backend, 'gateway.cjs'));
  const cashierRoot = path.resolve(__dirname, '../output/scarf-cashier-20261008/preview-dist');
  if (!fs.existsSync(path.join(cashierRoot, 'index.html'))) { f.close(); throw new Error('请先构建联动演示：npm run build -- --outDir output/scarf-cashier-20261008/preview-dist'); }
  const port = Number(process.env.BUBBLE_SCARF_PORT || 5209), origin = 'http://127.0.0.1:' + port;
  const logins = new Map(), runId = crypto.randomUUID();
  const gateway = createGateway({ config: { enabled: true, appId: 'wx0000000000000001', tokenSecret: crypto.randomBytes(32).toString('hex'), sessionTtlMs: 30 * 60000, origins: [origin], basePath: '/scarf-api' },
    exchangeCode: async code => { const identity = logins.get(code); if (!identity) throw new Error('演示登录已失效，请从顶部入口重进'); logins.delete(code); return identity; },
    consumeRate: async () => {}, callLottery: f.call });
  const middleware = paymentMiddleware(f.payments);
  const banner = '<div style="padding:10px;background:#fff1bf;color:#624a04;text-align:center;font:14px system-ui;position:relative;z-index:5">本机隔离演示 · 示例商品和库存 · 不能真实支付或领取　<a href="/">收银台</a>　<a href="/h5-enter" target="_blank">打开头巾 H5</a>　<a href="/h5-enter?fresh=1" target="_blank">新测试参与者</a></div>';
  async function route(req, res) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers.host !== '127.0.0.1:' + port) { res.writeHead(403); res.end(); return; }
    const url = new URL(req.url, origin), pathname = url.pathname;
    if (req.method === 'GET' && pathname === '/h5-enter') {
      const loginCode = 'preview_' + crypto.randomBytes(16).toString('hex');
      const identity = url.searchParams.get('fresh') === '1' ? 'oScarf_Visitor_' + crypto.randomUUID() : 'oScarf_PreviewVisitor0001';
      // This is only the local stand-in for staff's real attention check and invitation.
      const state = await f.call('state', {}, identity);
      const invitation = state.entry ? null : await f.call('grant', {}, 'oScarf_PreviewStaff0001');
      if (logins.size > 100) logins.clear(); logins.set(loginCode, identity);
      res.writeHead(302, { Location: '/h5/#/home?wx_code=' + loginCode + (invitation ? '&inviteCode=' + invitation.inviteCode : '') }); res.end(); return;
    }
    if (pathname.startsWith('/scarf-api/')) {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 16000) { res.writeHead(413); res.end(); return; } }
      const result = await gateway({ httpMethod: req.method, path: pathname, headers: req.headers, body });
      res.writeHead(result.statusCode, result.headers); res.end(result.body); return;
    }
    if (pathname.startsWith('/api/sqb/')) {
      const action = pathname.slice('/api/sqb/'.length);
      if ((!['config', 'records', 'notifications', 'pending', 'diagnostics', 'restore-status'].includes(action) && !action.startsWith('lottery-') && !action.startsWith('scarf-') && !action.startsWith('coupon-')) || /connect|import-|export-/.test(action)) {
        res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: '隔离演示仅开放活动管理和示例奖品核销，不连接真实收款服务' })); return;
      }
      await middleware(req, res, () => { res.writeHead(404); res.end(); }); return;
    }
    if (pathname === '/h5/runtime-config.js') { res.setHeader('Content-Type', 'application/javascript'); res.end('window.BUBBLE_H5_CONFIG=' + JSON.stringify({ mode: 'production', apiBase: origin + '/scarf-api' })); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const isH5 = pathname.startsWith('/h5/'), root = isH5 ? path.join(f.h5Root, 'public') : cashierRoot;
    let file;
    try { const relative = decodeURIComponent(isH5 ? pathname.slice(3) : pathname); file = path.resolve(root, '.' + (relative === '/' ? '/index.html' : relative)); } catch { res.writeHead(400); res.end(); return; }
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const type = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
    let bytes = fs.readFileSync(file);
    if (path.extname(file) === '.html') {
      let html = bytes.toString('utf8').replace('<body>', '<body>' + banner);
      // Only this dedicated demo origin is seeded. Live cashier storage is never opened.
      if (!isH5) html = html.replace('</head>', '<script>if(localStorage.getItem("bubble_scarf_demo_run")!==' + JSON.stringify(runId) + '){localStorage.setItem("stall_cashier_ledger_v2",' + JSON.stringify(JSON.stringify({ products: f.products, orders: [], heldCarts: [] })) + ');localStorage.setItem("bubble_scarf_demo_run",' + JSON.stringify(runId) + ')}</script></head>');
      bytes = Buffer.from(html);
    }
    res.setHeader('Content-Type', type); res.end(req.method === 'HEAD' ? undefined : bytes);
  }
  const server = http.createServer((req, res) => route(req, res).catch(error => {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(error.message);
  }));
  server.on('error', error => { f.close(); console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log('Isolated scarf + cashier preview: ' + origin + '/ (no production connections)'));
  process.on('SIGINT', () => { server.closeAllConnections(); server.close(); f.close(); process.exit(0); });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
