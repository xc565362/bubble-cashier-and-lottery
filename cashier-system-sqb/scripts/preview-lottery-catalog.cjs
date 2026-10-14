// Local integration preview. No external request is permitted; all stores are temporary.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCouponStore } = require('../coupons/store.cjs');
const { createPool, ensureSchema, deleteNamespace } = require('../online/mysql.cjs');
const { endpoints } = require('../coupons/http.cjs');
const { createService: createPayments } = require('../payments/service.cjs');
const { paymentMiddleware } = require('../payments/http.cjs');
const { createService } = require('../lottery-backend/service.js');
const { createCenterLottery } = require('../lottery-backend/center-lottery.cjs');
const { createPhysicalCenter } = require('../lottery-backend/physical-center.cjs');
const { createManagementHttp } = require('../lottery-backend/management-http.cjs');
const baseline = require('../lottery-backend/config.js');
const h5Root = path.resolve(__dirname, '../../miniprogram/Bubble-H5-1.0.3-qr0922');
const { createGateway } = require(path.join(h5Root, 'server/cloudfunctions/bubble-h5-gateway/gateway.cjs'));

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-catalog-preview-'));
  const pool = createPool();
  await ensureSchema(pool);
  const ns = 'preview-' + crypto.randomBytes(6).toString('hex');
  const couponStore = await createCouponStore({ pool, ns, environment: 'production' });
  const admin = { id: 'administrator', role: 'admin' };
  const adminToken = crypto.randomBytes(32).toString('hex');
  const managementKey = crypto.randomBytes(32).toString('hex');
  const centerId = (await couponStore.dispatch(admin, 'info')).centerId;
  const now = Date.now;
  const campaign = { ...structuredClone(baseline.campaign), title: '赛场同行 · 隔离联动演示', enabled: false,
    startsAt: now() - 60000, endsAt: now() + 7 * 86400000, redeemEndsAt: now() + 7 * 86400000, redemptionEndsAt: undefined };
  const prizes = structuredClone(baseline.prizes);
  let tables = new Map(), queue = Promise.resolve();
  const store = { transaction(fn) { const job = queue.then(async () => {
    const copy = structuredClone(tables);
    const result = await fn({ get: async (table, id) => structuredClone(copy.get(table + ':' + id)),
      set: async (table, id, value) => copy.set(table + ':' + id, structuredClone(value)) });
    tables = copy; return result;
  }); queue = job.catch(() => {}); return job; } };
  const centerConfig = { baseUrl: 'https://coupon-preview.invalid', centerId, environment: 'production', prizes: {} };
  const physicalConfig = { ...centerConfig, stage: 'active', handoffReadyAt: now() - 1000, prizes: {} };
  const managementCenterConfig = { baseUrl: centerConfig.baseUrl, centerId, adminToken, prizes: {} };
  for (const p of prizes) {
    const c = await couponStore.dispatch(admin, 'create-campaign', { requestId: 'preview-campaign-' + p.id, name: p.name, kind: p.kind,
      amountCents: Math.round((p.amount || 0) * 100), minimumCents: 0, quota: campaign.inventory.quantities[p.id],
      startsAt: new Date(campaign.startsAt).toISOString(), expiresAt: new Date(campaign.redeemEndsAt).toISOString(),
      ...(p.kind === 'physical' ? { physical: { prizeId: p.id, quantity: 1 } } : {}) });
    const key = await couponStore.dispatch(admin, 'create-key', { requestId: 'preview-key-' + p.id, name: 'Preview ' + p.id, role: 'lottery', campaignId: c.id });
    const mapping = { campaignId: c.id, token: key.token, minimumCents: 0 };
    (p.kind === 'physical' ? physicalConfig : centerConfig).prizes[p.id] = mapping;
    managementCenterConfig.prizes[p.id] = c.id;
  }
  const mockFetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.origin === centerConfig.baseUrl) {
      try {
        const token = options.headers?.Authorization?.replace(/^Bearer /, '');
        const actor = token === adminToken ? admin : await couponStore.authenticate(token);
        const action = Object.entries(endpoints).find(([, [method, route]]) => method === (options.method || 'GET') && route === parsed.pathname)?.[0];
        if (!action) throw new Error('Unexpected fixture coupon route');
        const data = await couponStore.dispatch(actor, action, options.body ? JSON.parse(options.body) : Object.fromEntries(parsed.searchParams));
        return Response.json({ ok: true, data });
      } catch (error) { return Response.json({ ok: false, error: error.message, code: error.code }, { status: error.status || 400 }); }
    }
    if (parsed.href === 'https://management-preview.invalid/lottery') {
      const response = await management({ httpMethod: 'POST', headers: options.headers, body: options.body });
      return new Response(response.body, { status: response.statusCode, headers: response.headers });
    }
    throw new Error('隔离预览已阻止外部网络请求');
  };
  const options = { store, campaign, prizes, now, adminIds: ['preview-admin'], catalogCenterConfig: managementCenterConfig,
    randomIndex: limit => crypto.randomInt(limit), randomTicket: () => crypto.randomInt(100),
    makeCode: () => crypto.randomBytes(8).toString('hex').toUpperCase(),
    makeCouponCode: () => 'LJC1_' + crypto.randomBytes(16).toString('hex').toUpperCase(),
    entryId: id => crypto.createHash('sha256').update(campaign.id + ':' + id).digest('hex').slice(0, 32), fetchFn: mockFetch };
  const base = createCenterLottery({ ...options, createService, centerConfig, physicalConfig });
  const lottery = createPhysicalCenter({ ...options, base, physicalConfig });
  await lottery('initializePool', {}, 'preview-admin');
  campaign.enabled = true;
  const management = createManagementHttp({ store, campaign, prizes, key: managementKey, centerConfig: managementCenterConfig, fetchFn: mockFetch });
  const payments = createPayments({ directory: path.join(directory, 'cashier'), fetchFn: mockFetch });
  await payments.dispatch('lottery-connect', { url: 'https://management-preview.invalid/lottery', campaignId: campaign.id, key: managementKey });
  await payments.dispatch('coupon-connect', { mode: 'remote', baseUrl: centerConfig.baseUrl, adminToken });
  const products = [
    ['cap', 'BB250005', '户外棒球帽'], ['bucket', 'BB250003', '户外渔夫帽'], ['waist', 'BB240011', '运动腰包'], ['tote', 'BB260057', '超大编织袋'],
    ['scarf', 'DEMO-SCARF', '黄橘拼色魔术头巾'], ['bottle', 'DEMO-BOTTLE', '赛事运动水壶']
  ].map(([id, sku, name]) => ({ id: 'preview-' + id, sku, barcode: sku, name, group: '联动演示商品', productType: 'sale', price: 29, originalPrice: 39, stock: 200 }));
  await payments.dispatch('coupon-bind-physical-products', { products });
  const port = Number(process.env.BUBBLE_CATALOG_PORT || 5208), origin = 'http://127.0.0.1:' + port;
  const codes = new Map();
  const gateway = createGateway({ config: { enabled: true, appId: 'wx0000000000000001', tokenSecret: crypto.randomBytes(32).toString('hex'),
    sessionTtlMs: 30 * 60000, origins: [origin], basePath: '/h5-api' },
    exchangeCode: async code => { const identity = codes.get(code); if (!identity) throw new Error('无效演示登录'); codes.delete(code); return identity; },
    consumeRate: async () => {}, callLottery: async (action, payload, openId) => {
      const data = await lottery(action, payload, openId);
      const receipt = entry => entry?.prize?.kind === 'physical' ? { ...entry, requiresPos: true } : entry;
      return action === 'state' ? { ...data, entry: receipt(data.entry) } : receipt(data);
    } });
  const middleware = paymentMiddleware(payments);
  const cashierRoot = path.resolve(__dirname, '../output/lottery-catalog-20260930/preview-dist');
  const runId = crypto.randomUUID();
  const banner = '<div style="padding:10px;background:#fff1bf;color:#624a04;text-align:center;font:14px system-ui;position:relative;z-index:5">本机隔离联动演示 · 奖品与库存均为演示数据 · 不能真实支付或领取　<a href="/" style="color:inherit">收银台</a>　<a href="/h5-enter" target="_blank" style="color:inherit">打开 H5</a>　<a href="/h5-enter?fresh=1" target="_blank" style="color:inherit">新测试参与者</a></div>';
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers.host !== '127.0.0.1:' + port) { res.writeHead(403); res.end(); return; }
    const pathname = new URL(req.url, origin).pathname;
    if (pathname === '/h5-enter') {
      const code = 'preview_' + crypto.randomBytes(16).toString('hex');
      const identity = new URL(req.url, origin).searchParams.get('fresh') === '1' ? 'preview-customer-' + crypto.randomUUID() : 'preview-customer-account';
      if (codes.size > 100) codes.clear();
      codes.set(code, identity);
      res.writeHead(302, { Location: '/h5/#/home?wx_code=' + code }); res.end(); return;
    }
    if (pathname.startsWith('/h5-api/')) {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 12000) { res.writeHead(413); res.end(); return; } }
      const response = await gateway({ httpMethod: req.method, path: pathname, headers: req.headers, body });
      res.writeHead(response.statusCode, response.headers); res.end(response.body); return;
    }
    if (pathname.startsWith('/api/sqb/')) {
      const action = pathname.slice('/api/sqb/'.length);
      if (!['config', 'records', 'notifications', 'pending', 'diagnostics', 'restore-status'].includes(action) && !action.startsWith('lottery-') && !action.startsWith('coupon-')) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: '联动演示仅开放抽奖管理和演示券核销' })); return; }
      if (/connect|import-|export-/.test(action)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: '隔离预览使用固定演示连接' })); return; }
      middleware(req, res, () => { res.writeHead(404); res.end(); }); return;
    }
    if (pathname === '/h5/runtime-config.js') { res.setHeader('Content-Type', 'application/javascript'); res.end('window.BUBBLE_H5_CONFIG=' + JSON.stringify({ mode: 'production', apiBase: origin + '/h5-api' })); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const isH5 = pathname.startsWith('/h5/'), root = isH5 ? path.join(h5Root, 'public') : cashierRoot;
    let file;
    try { const relative = decodeURIComponent(isH5 ? pathname.slice(3) : pathname); file = path.resolve(root, '.' + (relative === '/' ? '/index.html' : relative)); } catch { res.writeHead(400); res.end(); return; }
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const type = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
    let bytes = fs.readFileSync(file);
    if (path.extname(file) === '.html') {
      let html = bytes.toString('utf8').replace('<body>', '<body>' + banner);
      if (!isH5) html = html.replace('</head>', '<script>if(localStorage.getItem("bubble_catalog_preview_run")!==' + JSON.stringify(runId) + '){localStorage.setItem("stall_cashier_ledger_v2",' + JSON.stringify(JSON.stringify({ products, orders: [], heldCarts: [] })) + ');localStorage.setItem("bubble_catalog_preview_run",' + JSON.stringify(runId) + ')}</script></head>');
      bytes = Buffer.from(html);
    }
    res.setHeader('Content-Type', type); res.end(req.method === 'HEAD' ? undefined : bytes);
  });
  server.listen(port, '127.0.0.1', () => console.log('Isolated cashier + H5 preview: ' + origin + '/ (no production connections)'));
  process.on('SIGINT', () => { server.closeAllConnections(); server.close(); payments.close(); couponStore.close(); deleteNamespace(pool, ns).finally(() => pool.end().finally(() => process.exit(0))); });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
