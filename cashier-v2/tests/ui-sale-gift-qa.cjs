const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createService } = require('../payments/service.cjs');
const { paymentMiddleware } = require('../payments/http.cjs');

async function main() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cashier-sale-gift-'));
  const output = path.resolve('output/playwright/sale-gift-0.7.8');
  fs.mkdirSync(output, { recursive: true });
  let requests = 0;
  const service = createService({ directory, fetchFn: async () => { requests++; throw new Error('No real network in gift tests'); } });
  const root = path.resolve('dist');
  const middleware = paymentMiddleware(service);
  const server = http.createServer((req, res) => middleware(req, res, () => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const initial = {
    products: [
      { id: 'main', name: '测试主品', barcode: 'MAIN001', sku: 'MAIN001', productType: 'sale', price: 100, stock: 10 },
      { id: 'dual', name: '同码可售可赠商品', barcode: 'DUAL001', sku: 'DUAL001', productType: 'gift', price: 0, stock: 4 }
    ], orders: [], heldCarts: [], paymentQr: '',
    promoRules: [{ id: 'old-rule', enabled: true, mode: 'all', mainProductIds: ['main'], stackable: false, gifts: [{ productId: 'dual', qty: 1 }], startAt: '', endAt: '' }]
  };
  let browser;
  let currentPage;
  const errors = [];
  const results = [];
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    for (const viewport of [{ width: 1280, height: 800 }, { width: 1024, height: 600 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      await context.route('**/*', route => route.request().url().startsWith(url) ? route.continue() : route.abort());
      const page = await context.newPage();
      currentPage = page;
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      await page.getByRole('heading', { name: '摆摊收银台', exact: true }).waitFor();
      await page.evaluate(value => localStorage.setItem('stall_cashier_ledger_v2', JSON.stringify(value)), initial);
      await page.reload();
      await page.waitForLoadState('networkidle');
      const nav = name => page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
      const getLedger = () => page.evaluate(() => JSON.parse(localStorage.getItem('stall_cashier_ledger_v2')));
      const scan = async code => { const input = page.getByRole('textbox', { name: '商品或优惠券条码' }); await input.fill(code); await input.press('Enter'); };
      await nav('商品');
      await page.locator('.inventoryRow').filter({ hasText: '同码可售可赠商品' }).getByRole('button').first().click();
      await page.getByLabel(/^商品类型/).selectOption('sale');
      const eligible = page.getByRole('checkbox', { name: '可参与买赠', exact: true });
      assert.equal(await eligible.isChecked(), true, 'Converting an existing gift preserves its gift eligibility');
      await eligible.uncheck();
      assert.match(await page.locator('.giftEligibility').innerText(), /未启用/);
      await eligible.check();
      await page.getByLabel('售价', { exact: true }).fill('20');
      const save = page.getByRole('button', { name: '保存商品', exact: true });
      const box = await save.boundingBox();
      assert.ok(box.y >= 0 && box.y + box.height <= viewport.height, 'Save button remains visible on small screens');
      await eligible.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `editor-${viewport.width}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await save.click();
      let data = await getLedger();
      assert.equal(data.products.length, 2);
      assert.equal(data.products[1].id, 'dual');
      assert.equal(data.products[1].barcode, 'DUAL001');
      assert.equal(data.products[1].sku, 'DUAL001');
      assert.equal(data.products[1].stock, 4);
      assert.equal(data.products[1].giftEligible, true);
      await nav('赠品');
      assert.match(await page.getByLabel('赠品1', { exact: true }).innerText(), /同码可售可赠商品（可售可赠）/);
      await nav('收银');
      await scan('DUAL001');
      await scan('MAIN001');
      assert.equal(await page.locator('.cartItem').count(), 3);
      assert.match(await page.locator('.cartTotals strong').innerText(), /120\.00/);
      const freeLine = page.locator('.cartItem').filter({ hasText: '活动赠送 · 免费' });
      assert.equal(await freeLine.locator('input').isDisabled(), true);
      assert.match(await freeLine.innerText(), /¥0\.00/);
      await page.locator('.cartPanel').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `cart-${viewport.width}.png`) });
      await page.getByRole('button', { name: '挂起', exact: true }).click();
      data = await getLedger();
      assert.equal(data.heldCarts.length, 1);
      assert.equal(data.heldCarts[0].items.length, 3);
      assert.deepEqual(data.heldCarts[0].items.filter(item => item.id === 'dual').map(item => item.price), [20, 0]);
      assert.equal(data.products[1].stock, 4);
      await page.getByRole('button', { name: '挂单 (1)', exact: true }).click();
      await page.getByRole('button', { name: '取单', exact: true }).click();
      assert.match(await page.locator('.cartTotals strong').innerText(), /120\.00/);
      await scan('MAIN001');
      assert.equal(await freeLine.count(), 1);
      assert.match(await freeLine.innerText(), /× 1/);
      await scan('DUAL001');
      await scan('DUAL001');
      await scan('DUAL001');
      assert.match(await page.locator('.cartTotals strong').innerText(), /260\.00/);
      assert.equal(await freeLine.getByRole('button', { name: '增加数量' }).isDisabled(), true);
      await page.getByRole('button', { name: '生成收款码', exact: true }).click();
      await page.getByRole('button', { name: '确认收款', exact: true }).click();
      data = await getLedger();
      assert.equal(data.orders.length, 1);
      assert.equal(data.orders[0].total, 260);
      assert.equal(data.products[1].stock, 0);
      assert.equal(data.products[1].price, 20);
      assert.equal(data.products[0].stock, 8);
      // Importing an older template must not remove the new eligibility flag.
      await nav('商品');
      await page.locator('input[type="file"][accept=".csv,.xlsx,.xls"]').setInputFiles({ name: 'old.csv', mimeType: 'text/csv', buffer: Buffer.from('\ufeff产品名称,条码,货品编码,商品类型,原价,售价,库存数量\n同码可售可赠商品,DUAL001,DUAL001,售卖品,20,20,4') });
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('stall_cashier_ledger_v2')).products.find(p => p.id === 'dual').stock === 4);
      assert.equal((await getLedger()).products[1].giftEligible, true);
      for (const enabled of [false, true]) {
        await page.locator('input[type="file"][accept=".csv,.xlsx,.xls"]').setInputFiles({ name: 'new.csv', mimeType: 'text/csv', buffer: Buffer.from(`\ufeff产品名称,条码,货品编码,商品类型,原价,售价,库存数量,可参与买赠\n同码可售可赠商品,DUAL001,DUAL001,售卖品,20,20,4,${enabled ? '是' : '否'}`) });
        await page.waitForFunction(value => JSON.parse(localStorage.getItem('stall_cashier_ledger_v2')).products.find(p => p.id === 'dual').giftEligible === value, enabled);
      }
      // Choice gifts must account for paid units that already occupy the same stock.
      data = await getLedger();
      data.products[1].stock = 1;
      data.promoRules[0].mode = 'choice';
      await page.evaluate(value => localStorage.setItem('stall_cashier_ledger_v2', JSON.stringify(value)), data);
      await page.reload();
      await page.waitForLoadState('networkidle');
      await scan('DUAL001');
      await scan('MAIN001');
      await page.getByRole('heading', { name: '选择赠品', exact: true }).waitFor();
      assert.equal(await page.locator('.giftChoiceCard').isDisabled(), true);
      assert.match(await page.locator('.giftChoiceCard').innerText(), /可用库存 0/);
      await page.screenshot({ path: path.join(output, `choice-${viewport.width}.png`) });
      await page.getByRole('button', { name: '稍后选择', exact: true }).click();
      await page.locator('.cartItem').filter({ hasText: '同码可售可赠商品' }).getByRole('button', { name: '减少数量' }).click();
      await page.getByRole('button', { name: '选择赠品', exact: true }).click();
      assert.equal(await page.locator('.giftChoiceCard').isEnabled(), true);
      await page.locator('.giftChoiceCard').click();
      assert.match(await page.locator('.cartItem').filter({ hasText: '活动赠送 · 免费' }).innerText(), /¥0\.00/);
      assert.match(await page.locator('.cartTotals strong').innerText(), /100\.00/);
      data = await getLedger();
      data.products[1].stock = 4;
      data.promoRules[0] = { ...data.promoRules[0], mainProductIds: ['dual'], mode: 'all', stackable: true };
      await page.evaluate(value => localStorage.setItem('stall_cashier_ledger_v2', JSON.stringify(value)), data);
      await page.reload();
      await page.waitForLoadState('networkidle');
      await scan('DUAL001');
      await scan('DUAL001');
      assert.equal(await page.locator('.cartItem').count(), 2, 'Buy-one-get-one on the same SKU must not recurse');
      assert.match(await page.locator('.cartTotals strong').innerText(), /40\.00/);
      assert.match(await page.locator('.cartItem').filter({ hasText: '活动赠送 · 免费' }).innerText(), /× 2/);
      results.push({ viewport, editing: 'passed', paidAndGift: 'passed', sharedStock: 'passed', held: 'passed', oldImport: 'passed', choiceStock: 'passed' });
      await context.close();
    }
    assert.equal(requests, 0);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ results, requests, errors }, null, 2));
    console.log(JSON.stringify({ cases: results.length, requests, errors, output }));
  } catch (error) {
    if (currentPage && !currentPage.isClosed()) {
      await currentPage.screenshot({ path: path.join(output, 'failure.png') });
      console.error((await currentPage.locator('body').innerText()).slice(-7000));
    }
    throw error;
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    service.close();
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('cashier-sale-gift-')) throw new Error('Unsafe cleanup');
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
