const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createService } = require('../payments/service.cjs');
const { paymentMiddleware } = require('../payments/http.cjs');

async function main() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const { searchOrders } = await import('./fixtures/ledger-search.js');
  const { LEDGER_SEARCH_FIELDS } = await import('../src/ledgerSearch.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cashier-ledger-search-'));
  const output = path.resolve('output/playwright/ledger-search-0.7.9');
  fs.mkdirSync(output, { recursive: true });
  let requests = 0;
  const service = createService({ directory, fetchFn: async () => { requests++; throw new Error('Real payment network forbidden in search QA'); } });
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
  const initial = { products: [], orders: searchOrders(), heldCarts: [], paymentQr: '', promoRules: [] };
  let browser, page;
  const errors = [], results = [];
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    for (const viewport of [{ width: 1280, height: 800 }, { width: 1024, height: 600 }, { width: 390, height: 844 }, { width: 320, height: 700 }]) {
      const context = await browser.newContext({ viewport, timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
      await context.route('**/*', route => route.request().url().startsWith(url) ? route.continue() : route.abort());
      page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      await page.getByRole('heading', { name: '摆摊收银台', exact: true }).waitFor();
      await page.evaluate(value => localStorage.setItem('stall_cashier_ledger_v2', JSON.stringify(value)), initial);
      await page.reload();
      await page.waitForLoadState('networkidle');
      const baseline = await page.evaluate(() => JSON.parse(localStorage.getItem('stall_cashier_ledger_v2')));
      const nav = name => page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
      await nav('流水');
      const form = page.getByRole('form', { name: '流水查询' });
      const field = form.getByLabel('查询字段', { exact: true });
      const keyword = form.getByLabel('查询内容', { exact: true });
      assert.equal(await keyword.isDisabled(), true);
      assert.equal(await form.getByRole('button', { name: '查询', exact: true }).isDisabled(), true);
      assert.equal(await field.locator('option').count(), LEDGER_SEARCH_FIELDS.length + 1);
      await page.getByRole('button', { name: '全部日期', exact: true }).click();
      assert.equal(await page.locator('.orderRow').count(), 4);
      assert.match(await page.locator('.orderSummary').innerText(), /120\.00/);
      const query = async (id, value) => {
        await field.selectOption(id);
        await keyword.fill(value);
        await keyword.press('Enter');
      };
      await query('货品编码', 'bb240011');
      assert.equal(await page.locator('.orderRow').count(), 1);
      assert.match(await page.locator('.orderRow').innerText(), /运动腰包/);
      assert.match(await page.locator('.orderSummary').innerText(), /匹配订单净收入\n¥120\.00/);
      await page.screenshot({ path: path.join(output, `search-${viewport.width}.png`), fullPage: true });
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: '导出匹配订单明细', exact: true }).click();
      const file = await download;
      assert.match(file.suggestedFilename(), /全部日期_查询结果/);
      const csv = fs.readFileSync(await file.path(), 'utf8');
      assert.equal(csv.trim().split('\n').length, 2);
      assert.ok(csv.includes('BB240011')); assert.ok(!csv.includes('BB250005'));
      await nav('收银'); await nav('流水');
      assert.equal(await field.inputValue(), '货品编码');
      assert.equal(await keyword.inputValue(), 'bb240011');
      await field.selectOption('产品名称');
      assert.equal(await keyword.inputValue(), '');
      assert.equal(await page.getByRole('button', { name: '导出匹配订单明细', exact: true }).isDisabled(), true);
      await keyword.fill('不存在的商品'); await keyword.press('Enter');
      await page.getByText('没有符合查询条件的流水', { exact: true }).waitFor();
      assert.match(await page.locator('.orderSummary').innerText(), /¥0\.00/);
      await form.getByRole('button', { name: '重置', exact: true }).click();
      assert.equal(await page.locator('.orderRow').count(), 4);
      assert.equal(await keyword.isDisabled(), true);
      await page.getByLabel('查看日期', { exact: true }).fill('2026-09-29');
      await query('流水号', 'SERIAL-REFUND');
      assert.equal(await page.locator('.orderRow').count(), 1);
      assert.match(await page.locator('.orderSummary').innerText(), /-¥95\.00/);
      const refundDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: '导出匹配订单明细', exact: true }).click();
      const refundFile = await refundDownload;
      const refundCsv = fs.readFileSync(await refundFile.path(), 'utf8');
      assert.equal(refundCsv.trim().split('\n').length, 2);
      assert.ok(refundCsv.includes('SERIAL-REFUND')); assert.ok(!refundCsv.includes('SERIAL-ORIGINAL'));
      await page.getByLabel('查看日期', { exact: true }).fill('2026-09-28');
      assert.equal(await page.locator('.orderRow').count(), 0);
      await page.getByRole('button', { name: '全部日期', exact: true }).click();
      await query('产品名称', '运动腰包');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'No horizontal overflow');
      for (const control of [field, keyword, form.getByRole('button', { name: '查询', exact: true })]) {
        const box = await control.boundingBox();
        assert.ok(box.width > 40 && box.x >= 0 && box.x + box.width <= viewport.width, 'Search controls stay in viewport');
      }
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('stall_cashier_ledger_v2'))), baseline, 'Searching must not modify the ledger');
      results.push({ viewport, fieldFirst: true, query: true, reset: true, retainedOnTabChange: true, dateIntersection: true, csv: true, ledgerUnchanged: true });
      await context.close();
    }
    assert.equal(requests, 0); assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ results, requests, errors }, null, 2));
    console.log(JSON.stringify({ cases: results.length, requests, errors, output }));
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
    throw error;
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    service.close();
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('cashier-ledger-search-')) throw new Error('Unsafe cleanup');
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
