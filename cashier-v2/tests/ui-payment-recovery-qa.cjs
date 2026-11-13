const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createService } = require('../payments/service.cjs');
const { paymentMiddleware } = require('../payments/http.cjs');
const { signedEnvelope } = require('../payments/litepos.cjs');

async function main() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const output = path.resolve('output/playwright/payment-recovery-20260926');
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  try {
    for (const scenario of [
      { width: 1280, height: 800, outcome: 'missing' },
      { width: 1024, height: 600, outcome: 'missing' },
      { width: 390, height: 844, outcome: 'missing' },
      { width: 1280, height: 800, outcome: 'paid' },
      { width: 1280, height: 800, outcome: 'offline' },
    ]) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cashier-ui-recovery-'));
      let service;
      let server;
      let context;
      try {
        const platform = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
        let outcome = 'missing';
        let purchases = 0;
        const sign = biz_response => signedEnvelope('response', { head: { appid: 'mock', sign_type: 'SHA256' }, body: { result_code: '200', biz_response } }, platform.privateKey);
        const fetchFn = async (url, options) => {
          if (url.endsWith('/purchase')) { purchases++; throw new TypeError('offline'); }
          assert.ok(url.endsWith('/query'), 'Only mock purchase/query allowed');
          if (outcome === 'offline') throw new TypeError('offline');
          const identity = JSON.parse(options.body).request.body;
          return new Response(outcome === 'paid' ? sign({ result_code: '200', data: { ...identity, order_sn: 'MOCK-PAID',
            order_type: 1, order_status: 4, amount: 28900, currency: '156',
            tenders: [{ tender_sn: 'MOCK-TENDER', amount: 28900, pay_status: 3 }] } })
            : sign({ result_code: '32005', error_code: 'ACQ.ORDER_NOT_FOUND', error_message: '订单不存在' }));
        };
        service = createService({ directory, resolveTerminalIp: async () => '8.8.4.4', fetchFn });
        await service.dispatch('generate-key');
        await service.dispatch('save-config', { mode: 'production', appid: 'mock', brand_code: 'MOCK', store_sn: 'mock', workstation_sn: '0', operator: 'QA', gateway: 'https://test.shouqianba.com', platformPublicKey: platform.publicKey });
        const product = { id: 'qa-item', name: '网络异常测试商品', barcode: 'QA-001', sku: 'QA-001', group: '测试', productType: 'sale', price: 289, originalPrice: 289, stock: 10 };
        const draft = { id: crypto.randomUUID(), orderNo: `MOCK${Date.now()}`, createdAt: new Date(Date.now() - 600000).toISOString(), method: '收钱吧', total: 289, items: [{ ...product, qty: 1, discount: 0 }] };
        await service.dispatch('start', { draft, code: '130000000000000000' });
        const record = await service.dispatch('query', { id: draft.id });
        record.createdAt = draft.createdAt;
        record.missingOrder.firstCheckedAt = new Date(Date.now() - 120000).toISOString();
        record.missingOrder.count = 3;
        // Seed aged evidence only in this isolated mock journal, never production data.
        fs.writeFileSync(path.join(directory, 'payments.json'), JSON.stringify({ [draft.id]: record }));
        service.close();
        service = createService({ directory, resolveTerminalIp: async () => '8.8.4.4', fetchFn });
        const middleware = paymentMiddleware(service);
        const root = path.resolve('dist');
        server = http.createServer((req, res) => middleware(req, res, () => {
          const file = path.resolve(root, `.${req.url === '/' ? '/index.html' : req.url.split('?')[0]}`);
          if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; res.end(); return; }
          res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
          res.end(fs.readFileSync(file));
        }));
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${server.address().port}/`;
        context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, serviceWorkers: 'block' });
        await context.route('**/*', route => route.request().url().startsWith(url) ? route.continue() : route.abort());
        await context.addInitScript(value => {
          if (!localStorage.getItem('stall_cashier_ledger_v2')) localStorage.setItem('stall_cashier_ledger_v2', JSON.stringify(value));
        }, { products: [product], orders: [], pendingPayment: { draft, started: true, record }, heldOrders: [], promoRules: [] });
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(url);
        const dialog = page.getByRole('dialog', { name: '收钱吧收款', exact: true });
        await dialog.waitFor();
        await page.reload();
        await dialog.waitFor();
        const check = page.getByRole('checkbox', { name: '我已核对顾客账单，确认本笔未扣款' });
        const finish = page.getByRole('button', { name: '核实并结束本次收款' });
        assert.equal(await finish.isDisabled(), true);
        assert.equal(await page.getByRole('button', { name: '关闭收钱吧收款' }).isDisabled(), true);
        await check.check();
        assert.equal(await finish.isEnabled(), true);
        await finish.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(output, `${scenario.width}-${scenario.outcome}-confirm.png`) });
        const bounds = await finish.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= scenario.width && bounds.y + bounds.height <= scenario.height);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        outcome = scenario.outcome;
        await finish.click();
        if (outcome === 'offline') {
          await page.getByRole('alert').filter({ hasText: '本次查单未确认订单不存在' }).waitFor();
          assert.equal(await page.getByRole('button', { name: '关闭收钱吧收款' }).isDisabled(), true);
        } else if (outcome === 'missing') {
          await page.getByText('已核对未扣款，本次收款已结束', { exact: true }).waitFor();
          await page.getByRole('button', { name: '返回购物车', exact: true }).click();
          await dialog.waitFor({ state: 'hidden' });
          const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('stall_cashier_ledger_v2')));
          assert.equal(saved.products[0].stock, 10); assert.equal(saved.orders.length, 0); assert.equal(saved.pendingPayment, null);
          assert.equal((await service.dispatch('pending')).length, 0);
          await page.getByRole('button', { name: '收钱吧收款', exact: true }).click();
          await page.getByRole('button', { name: '发起收款', exact: true }).waitFor();
          await page.getByRole('button', { name: '关闭收钱吧收款' }).click();
        } else {
          await dialog.waitFor({ state: 'hidden' });
          const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('stall_cashier_ledger_v2')));
          assert.equal(saved.products[0].stock, 9); assert.equal(saved.orders.length, 1); assert.equal(saved.pendingPayment, null);
          assert.equal(saved.orders[0].payment.orderSn, 'MOCK-PAID');
        }
        assert.equal(purchases, 1, 'Recovery must not issue a second purchase');
      } finally {
        await context?.close();
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        service?.close();
        if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('cashier-ui-recovery-')) throw new Error('Unsafe temporary directory');
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'passed', scenarios: 5, realPayments: 0, realRefunds: 0, reloadRecovery: true, unchangedUnpaidStockAndRevenue: true, freshPaidWins: true }));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
