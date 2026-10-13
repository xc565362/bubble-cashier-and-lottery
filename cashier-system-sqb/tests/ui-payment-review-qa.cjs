const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createService } = require('../payments/service.cjs');
const { paymentMiddleware } = require('../payments/http.cjs');

async function main() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const output = path.resolve('output/playwright/payment-review-0.7.10');
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [], results = [];
  try {
    for (const scenario of [
      { width: 1280, height: 800, acknowledged: true, missing: true },
      { width: 1024, height: 600, acknowledged: true, missing: false },
      { width: 390, height: 844, acknowledged: false, missing: true },
    ]) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cashier-review-'));
      let service, server, context;
      let requests = 0;
      const actions = [];
      try {
        const options = { directory, fetchFn: async () => { requests++; throw new Error('No real financial calls in review QA'); } };
        const publicKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }).publicKey;
        service = createService(options);
        await service.dispatch('generate-key');
        await service.dispatch('save-config', { mode: 'production', appid: 'mock', brand_code: 'MOCK', store_sn: 'mock', workstation_sn: '0', operator: 'QA', gateway: 'https://test.shouqianba.com', platformPublicKey: publicKey });
        service.close();
        const product = { id: 'review-item', name: '原收银测试商品', barcode: 'REVIEW-001', sku: 'REVIEW-001', productType: 'sale', price: 0.01, stock: 10 };
        const draft = { id: 'review-payment', orderNo: 'POS-REVIEW-001', createdAt: '2026-09-18T09:00:00Z', method: '收钱吧', total: 0.01, items: [{ ...product, qty: 1, discount: 0 }] };
        const record = { id: draft.id, draft, acknowledged: scenario.acknowledged, state: 'paid', amount: 1, orderSn: 'MOCK-PAID', identity: { check_sn: draft.orderNo }, updatedAt: draft.createdAt,
          tenders: [{ tenderSn: 'MOCK-TENDER', amount: 1, payStatus: 3 }] };
        const journal = JSON.stringify({ [draft.id]: record });
        fs.writeFileSync(path.join(directory, 'payments.json'), journal);
        service = createService(options);
        const middleware = paymentMiddleware(service);
        const root = path.resolve('dist');
        server = http.createServer((req, res) => {
          if (req.url.startsWith('/api/sqb/')) actions.push(req.url.slice('/api/sqb/'.length));
          middleware(req, res, () => {
            const file = path.resolve(root, `.${req.url === '/' ? '/index.html' : req.url.split('?')[0]}`);
            if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; res.end(); return; }
            res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
            res.end(fs.readFileSync(file));
          });
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${server.address().port}/`;
        context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, serviceWorkers: 'block' });
        await context.route('**/*', route => route.request().url().startsWith(url) ? route.continue() : route.abort());
        const products = [scenario.missing ? { ...product, id: 'unrelated', name: '示例商品' } : product];
        const existing = { id: 'legacy', orderNo: 'POS-LEGACY', items: [{ ...products[0], qty: 1, discount: 0 }], total: 0.01, status: '已收款', method: '收款码', createdAt: new Date().toISOString() };
        await context.addInitScript(value => {
          if (!localStorage.getItem('stall_cashier_ledger_v2')) localStorage.setItem('stall_cashier_ledger_v2', JSON.stringify(value));
        }, { products, orders: [existing], pendingPayment: { draft, started: true, record }, heldCarts: [], promoRules: [] });
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(url);
        await page.waitForLoadState('networkidle');
        const dialog = page.getByRole('dialog', { name: '收钱吧收款', exact: true });
        await dialog.waitFor();
        const getLedger = () => page.evaluate(() => JSON.parse(localStorage.getItem('stall_cashier_ledger_v2')));
        const before = await getLedger();
        await page.getByRole('button', { name: '重试保存订单', exact: true }).click();
        await dialog.getByRole('alert').filter({ hasText: scenario.acknowledged ? '不能在这里重复入账' : '当前浏览器的经营数据无法保存' }).waitFor();
        await page.screenshot({ path: path.join(output, `dialog-${scenario.width}.png`), fullPage: true });
        await page.getByRole('button', { name: '关闭收钱吧收款', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        await page.getByRole('button', { name: '查看待核对收款', exact: true }).waitFor();
        let saved = await getLedger();
        assert.deepEqual(saved.products, before.products); assert.deepEqual(saved.orders, before.orders);
        assert.deepEqual(saved.pendingPayment.draft, draft); assert.equal(saved.pendingPayment.review.dismissed, true);
        assert.equal(saved.pendingPayment.record.acknowledged, scenario.acknowledged);
        assert.equal(await page.getByRole('button', { name: '收钱吧收款', exact: true }).isDisabled(), true);
        // Focus/online recovery and full reload must not reopen a deliberately dismissed review.
        const recovering = page.waitForResponse(response => response.url().endsWith('/api/sqb/pending'));
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await recovering; await page.waitForLoadState('networkidle');
        assert.equal(await dialog.count(), 0);
        await page.reload(); await page.waitForLoadState('networkidle');
        assert.equal(await dialog.count(), 0);
        await page.screenshot({ path: path.join(output, `reloaded-${scenario.width}.png`), fullPage: true });
        await page.getByRole('navigation').getByRole('button', { name: '流水', exact: true }).click();
        await page.getByRole('heading', { name: '收款流水' }).waitFor();
        await page.getByRole('button', { name: '全部日期', exact: true }).click();
        assert.equal(await page.getByRole('button', { name: '取消订单', exact: true }).isDisabled(), true);
        assert.deepEqual((await getLedger()).orders, before.orders, 'Old non-SQB orders cannot bypass financial lock');
        await page.getByRole('button', { name: '查看待核对收款', exact: true }).click();
        await dialog.waitFor();
        await page.getByRole('button', { name: '关闭弹窗，保留待核对', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        await page.screenshot({ path: path.join(output, `retained-${scenario.width}.png`), fullPage: true });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.equal(fs.readFileSync(path.join(directory, 'payments.json'), 'utf8'), journal, 'No backend acknowledgment or record rewriting');
        assert.equal(requests, 0);
        assert.equal(actions.some(action => ['start', 'acknowledge', 'resolve-missing-payment', 'start-adjustment'].includes(action)), false);
        results.push({ ...scenario, closeBothButtons: true, retainedAfterReload: true, noAutoReopen: true, checkoutLocked: true, journalUnchanged: true });
      } finally {
        await context?.close();
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        service?.close();
        if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('cashier-review-')) throw new Error('Unsafe cleanup');
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ results, errors, realPayments: 0, realRefunds: 0 }, null, 2));
    console.log(JSON.stringify({ cases: results.length, errors, realPayments: 0, realRefunds: 0, output }));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
