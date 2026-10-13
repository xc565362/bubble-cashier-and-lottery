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
  const { priceOrder, completeSqbOrder } = await import('../src/orderLogic.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cashier-ui-refund-'));
  const platform = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const config = { mode: 'production', appid: 'mock', brand_code: 'MOCK', store_sn: 'mock-store', workstation_sn: '0', operator: 'QA', gateway: 'https://test.shouqianba.com', platformPublicKey: platform.publicKey };
  const remote = new Map();
  let waiting = true;
  let refundCalls = 0;
  let purchaseCalls = 0;
  const data = (body) => {
    const refund = Number(body.amount) < 0;
    return { ...body, order_sn: `SQB-${body.check_sn}`, order_type: refund ? 2 : 1, order_status: refund && waiting ? 3 : 4, currency: '156',
      tenders: refund ? body.tenders.map((entry, index) => ({ ...entry, tender_sn: `R-${body.check_sn}-${index}`, pay_status: waiting ? 4 : 5, sub_tender_type: '302', pay_time: new Date().toISOString(), internal_transaction_sn: `RS-${body.check_sn}-${index}`, paid_amount: entry.amount, collected_amount: entry.amount }))
        : [{ tender_sn: `T-${body.check_sn}`, amount: body.amount, pay_status: 3, sub_tender_type: '302', pay_time: new Date().toISOString(), internal_transaction_sn: `S-${body.check_sn}`, paid_amount: body.amount, collected_amount: body.amount }] };
  };
  const fetchFn = async (url, options) => {
    const body = JSON.parse(options.body).request.body;
    let result;
    if (url.endsWith('/refunds-query')) result = { refund_orders: [] };
    else if (url.endsWith('/refund')) {
      refundCalls++; remote.set(body.check_sn, body);
      result = { ...body, order_sn: `SQB-${body.check_sn}`, order_status: 4 };
    } else if (url.endsWith('/purchase')) { purchaseCalls++; remote.set(body.check_sn, body); result = data(body); }
    else if (url.endsWith('/query')) result = data(remote.get(body.check_sn));
    else throw new Error('Mock does not permit this endpoint');
    return new Response(signedEnvelope('response', { head: { appid: 'mock', sign_type: 'SHA256' }, body: { result_code: '200', biz_response: { result_code: '200', data: result } } }, platform.privateKey));
  };
  const service = createService({ directory, fetchFn, resolveTerminalIp: async () => '8.8.4.4' });
  await service.dispatch('generate-key'); await service.dispatch('save-config', config);
  const products = [
    { id: 'p1', name: '测试主品', barcode: 'ITEM-01', sku: 'A', group: '眼镜', price: 10, originalPrice: 12, qty: 2, discount: 1, productType: 'sale', stock: 10 },
    { id: 'g1', name: '测试赠品', barcode: 'GIFT-01', sku: 'G', group: '赠品', price: 0, qty: 1, productType: 'gift', stock: 10 },
    { id: 'c1', name: '三元优惠券', barcode: 'COUPON', price: 0, qty: 1, productType: 'coupon', couponAmount: 3, stock: 0 },
    { id: 'p2', name: '测试换入商品', barcode: 'ITEM-02', sku: 'B', group: '眼镜', price: 25, qty: 1, discount: 0, productType: 'sale', stock: 10 },
  ];
  const draft = { id: crypto.randomUUID(), orderNo: `POS${Date.now()}`, createdAt: new Date().toISOString(), method: '收钱吧', ...priceOrder(products.slice(0, 3)) };
  const paid = await service.dispatch('start', { draft, code: '130000000000000000' });
  const ledger = completeSqbOrder({ products, orders: [], pendingPayment: { draft } }, paid);
  await service.dispatch('acknowledge', { id: paid.id });
  const middleware = paymentMiddleware(service);
  const root = path.resolve('dist');
  const server = http.createServer((req, res) => middleware(req, res, () => {
    const file = path.join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let page;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    await context.route('**/*', (route) => route.request().url().startsWith(url) ? route.continue() : route.abort());
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(url);
    await page.getByRole('heading', { name: '摆摊收银台', exact: true }).waitFor();
    await page.evaluate((ledger) => localStorage.setItem('stall_cashier_ledger_v2', JSON.stringify(ledger)), ledger);
    await page.reload();
    await page.getByRole('button', { name: '流水', exact: true }).click();
    await page.getByRole('button', { name: '退货 / 取消并退款', exact: true }).click();
    await page.getByRole('spinbutton', { name: '测试主品退货数量', exact: true }).fill('1');
    assert.equal(await page.getByRole('checkbox', { name: '实际收回测试赠品' }).isChecked(), false);
    await page.getByRole('button', { name: '核对退换货' }).click();
    await page.getByRole('checkbox', { name: /确认商品数量/ }).check();
    await page.screenshot({ path: 'output/playwright/refund-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'output/playwright/refund-mobile.png' });
    const bounds = await page.getByRole('button', { name: '确认原路退款', exact: true }).boundingBox();
    assert.ok(bounds.y + bounds.height <= 844, 'Refund confirmation must remain reachable on mobile');
    await page.getByRole('button', { name: '确认原路退款', exact: true }).click();
    await page.getByText('正在核实资金结果', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '关闭退换货' }).isDisabled(), true);
    assert.equal(refundCalls, 1);
    await page.reload();
    await page.getByRole('dialog', { name: '退货换货' }).waitFor();
    await page.evaluate(() => { window.originalStorageSet = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) { if (key === 'stall_cashier_ledger_v2') throw new Error('Mock quota failure'); return window.originalStorageSet.call(this, key, value); }; });
    waiting = false;
    await page.getByRole('button', { name: '查询处理结果' }).click();
    await page.getByText(/资金已处理，账务尚未保存/).waitFor();
    assert.equal(refundCalls, 1);
    await page.evaluate(() => { Storage.prototype.setItem = window.originalStorageSet; });
    await page.getByRole('button', { name: '重试保存账务' }).click();
    await page.getByRole('dialog', { name: '退货换货' }).waitFor({ state: 'hidden' });
    let saved = await page.evaluate(() => JSON.parse(localStorage.getItem('stall_cashier_ledger_v2')));
    assert.equal(saved.orders[0].afterSales.length, 1);
    assert.equal(saved.products[0].stock, 9);
    assert.equal(saved.products[1].stock, 9);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole('button', { name: '流水', exact: true }).click();
    await page.getByRole('button', { name: '编辑 / 换货', exact: true }).click();
    await page.getByRole('spinbutton', { name: '测试主品退货数量', exact: true }).fill('1');
    await page.getByLabel('换入商品', { exact: true }).selectOption('p2');
    await page.getByRole('button', { name: '加入', exact: true }).click();
    await page.getByRole('button', { name: '核对退换货' }).click();
    await page.getByRole('checkbox', { name: /确认商品数量/ }).check();
    await page.getByRole('textbox', { name: '补款付款码' }).fill('130000000000000000');
    await page.setViewportSize({ width: 1024, height: 600 });
    await page.screenshot({ path: 'output/playwright/exchange-small-desktop.png' });
    await page.getByRole('button', { name: '确认补款', exact: true }).click();
    await page.getByRole('dialog', { name: '退货换货' }).waitFor({ state: 'hidden' });
    assert.equal(purchaseCalls, 2);
    await page.getByRole('button', { name: '退货 / 取消并退款', exact: true }).click();
    await page.getByRole('checkbox', { name: '实际收回测试赠品' }).check();
    await page.getByRole('button', { name: '核对退换货' }).click();
    await page.getByRole('checkbox', { name: /确认商品数量/ }).check();
    await page.getByRole('button', { name: '确认原路退款', exact: true }).click();
    await page.getByRole('dialog', { name: '退货换货' }).waitFor({ state: 'hidden', timeout: 15000 });
    saved = await page.evaluate(() => JSON.parse(localStorage.getItem('stall_cashier_ledger_v2')));
    assert.equal(saved.orders[0].afterSales.length, 3);
    assert.equal(saved.products[1].stock, 10);
    assert.equal(saved.products[3].stock, 10);
    await page.getByText('退换货记录 (3)').click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: 'output/playwright/after-sales-ledger.png' });
    const csvDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出当天明细' }).click();
    const csv = await csvDownload;
    await csv.saveAs('output/playwright/after-sales-ledger.csv');
    await page.getByRole('button', { name: '商品', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出备份', exact: true }).click();
    const backup = await download;
    const bundle = JSON.parse(fs.readFileSync(await backup.path(), 'utf8'));
    assert.equal(bundle.type, 'stall-cashier-signed-backup');
    assert.equal(JSON.parse(bundle.content).business.orders[0].afterSales.length, 3);
    const second = await context.newPage();
    await second.goto(url);
    await second.getByRole('heading', { name: '收银台已在其他窗口打开' }).waitFor();
    await page.close();
    await second.getByRole('heading', { name: '摆摊收银台', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ui: 'passed', screenshots: 4, responsiveViewports: ['1280x800', '390x844', '1024x600'], refundCalls, purchaseCalls, storageFailureRecovery: 'passed', reloadRecovery: 'passed', completeBackup: 'passed', multipleTabs: 'passed', realNetworkPayments: 0 }));
  } catch (error) {
    if (page) { await page.screenshot({ path: 'output/playwright/after-sales-failure.png' }); console.error(await page.locator('body').innerText()); }
    throw error;
  } finally {
    await browser.close();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('cashier-ui-refund-')) throw new Error('Unsafe temporary directory');
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
