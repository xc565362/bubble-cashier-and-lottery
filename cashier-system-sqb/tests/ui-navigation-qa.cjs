const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createService } = require('../payments/service.cjs');
const { paymentMiddleware } = require('../payments/http.cjs');

const tabs = ['收银', '商品', '流水', '赠品', '券管理', '抽奖'];
const output = path.resolve('output/playwright/navigation-' + require('../package.json').version);

async function verifyNavigation(page, name) {
  await page.waitForFunction(() => {
    const nav = document.querySelector('.bottomNav');
    return nav && Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bottom-nav-height')) - nav.getBoundingClientRect().height) < 1;
  }, undefined, { polling: 100, timeout: 15000 });
  const state = await page.locator('.bottomNav').evaluate(nav => {
    const bounds = nav.getBoundingClientRect();
    return {
      position: getComputedStyle(nav).position, bottom: bounds.bottom, height: bounds.height,
      viewportHeight: innerHeight, fits: bounds.left >= 0 && bounds.right <= innerWidth + 1,
      padding: parseFloat(getComputedStyle(document.querySelector('.shell')).paddingBottom),
      buttons: [...nav.querySelectorAll('button')].map(button => {
        const box = button.getBoundingClientRect();
        const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { width: box.width, height: box.height, fits: button.scrollWidth <= button.clientWidth + 1,
          reachable: target?.closest('button') === button };
      }),
    };
  });
  assert.equal(state.position, 'fixed', `${name}: navigation must always be fixed`);
  assert.ok(Math.abs(state.bottom - state.viewportHeight) < 1, `${name}: navigation must touch the viewport bottom`);
  assert.ok(state.fits, `${name}: navigation must fit horizontally`);
  assert.ok(state.padding >= state.height + 16, `${name}: content must reserve the full navigation height`);
  assert.equal(state.buttons.length, tabs.length);
  for (const button of state.buttons) {
    assert.ok(button.width >= 44 && button.height >= 44, `${name}: touch target too small`);
    assert.ok(button.fits, `${name}: label overflow`);
    assert.ok(button.reachable, `${name}: navigation is obscured`);
  }
  return state;
}

async function main() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const { priceOrder } = await import('../src/orderLogic.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cashier-navigation-'));
  let externalRequests = 0;
  const service = createService({ directory, fetchFn: async () => { externalRequests++; throw new Error('Navigation tests must not access payment gateways'); } });
  const now = new Date().toISOString();
  const products = Array.from({ length: 30 }, (_, i) => ({ id: `nav-${i}`, name: `导航测试商品 ${i + 1}`, barcode: `NAV-${i}`, sku: `NAV-${i}`, group: '测试', productType: 'sale', price: 10, originalPrice: 12, stock: 100 }));
  products.push({ id: 'nav-gift', name: '导航测试赠品', barcode: 'NAV-GIFT', group: '赠品', productType: 'gift', price: 0, stock: 100 });
  const ledger = { products, heldCarts: [], paymentQr: '', orders: Array.from({ length: 20 }, (_, i) => ({
    id: `nav-order-${i}`, orderNo: `QA-${i}`, status: '已收款', method: '扫码收款', createdAt: now, paidAt: now,
    ...priceOrder([{ ...products[i], qty: 1, discount: 0 }]),
  })), promoRules: Array.from({ length: 12 }, (_, i) => ({ id: `nav-rule-${i}`, enabled: false, mode: 'all', mainProductIds: [products[i].id], stackable: false, gifts: [{ productId: 'nav-gift', qty: 1 }], startAt: '', endAt: '' })) };
  for (let i = 0; i < 12; i++) await service.dispatch('coupon-create-campaign', {
    requestId: `nav-campaign-${i}`, name: `导航测试券 ${i + 1}`, amountCents: 100, minimumCents: 0, quota: 5,
    startsAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  const middleware = paymentMiddleware(service);
  const root = path.resolve('dist');
  const server = http.createServer((req, res) => middleware(req, res, () => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  let browser;
  const errors = [];
  const results = [];
  fs.mkdirSync(output, { recursive: true });
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => route.request().url().startsWith(url) ? route.continue() : route.abort());
    await context.addInitScript(value => localStorage.setItem('stall_cashier_ledger_v2', JSON.stringify(value)), ledger);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.waitForSelector('.modalBackdrop', { state: 'hidden' });
    for (const viewport of [
      { width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 },
      { width: 600, height: 480 }, { width: 859, height: 600 }, { width: 860, height: 600 },
      { width: 1024, height: 600 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 },
      { width: 3840, height: 2160 }, { width: 900, height: 280 },
    ]) {
      await page.setViewportSize(viewport);
      for (const [index, tab] of tabs.entries()) {
        await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: tab, exact: true }).click();
        if (tab === '券管理') await page.locator('.couponLoading').waitFor({ state: 'hidden' });
        const name = `${viewport.width}x${viewport.height}-${index}`;
        assert.equal(await page.locator('.bottomNav [aria-current="page"]').innerText(), tab);
        for (const progress of [0, 0.5, 1]) {
          await page.evaluate(value => scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * value), progress);
          await verifyNavigation(page, `${name}-${progress}`);
        }
        const clear = await page.locator('.workspace').evaluate(section => section.getBoundingClientRect().bottom <= document.querySelector('.bottomNav').getBoundingClientRect().top - 8);
        assert.ok(clear, `${name}: last content row is hidden by navigation`);
        if ([320, 390, 1024, 1920].includes(viewport.width)) await page.screenshot({ path: path.join(output, `${name}.png`) });
        results.push({ ...viewport, tab, scrolling: 'passed', lastRow: 'visible' });
      }
    }
    await page.setViewportSize({ width: 390, height: 600 });
    const enlarged = await page.addStyleTag({ content: '.bottomNav { padding-bottom: 44px; } .bottomNav button { font-size: 24px; }' });
    const expanded = await verifyNavigation(page, 'large-text-and-safe-area');
    assert.ok(expanded.height > 100);
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await page.screenshot({ path: path.join(output, 'large-text-and-safe-area.png') });
    await enlarged.evaluate(element => element.remove());
    await page.setViewportSize({ width: 1024, height: 600 });
    await page.getByRole('navigation').getByRole('button', { name: '商品', exact: true }).click();
    await page.getByRole('button', { name: '收钱吧设置', exact: true }).click();
    const modal = await page.locator('.modalBackdrop').evaluate(element => ({ modal: Number(getComputedStyle(element).zIndex), nav: Number(getComputedStyle(document.querySelector('.bottomNav')).zIndex) }));
    assert.ok(modal.modal > modal.nav, 'Modal confirmation must remain above navigation');
    await page.getByRole('button', { name: '关闭收钱吧设置' }).click();
    await verifyNavigation(page, 'after-modal');
    assert.equal(externalRequests, 0);
    assert.deepEqual(errors, []);
    const report = { cases: results.length, results, dynamicHeight: 'passed', modalLayer: 'passed', externalRequests, pageErrors: errors };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ cases: results.length, dynamicHeight: 'passed', modalLayer: 'passed', externalRequests, pageErrors: errors }));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    service.close();
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('cashier-navigation-')) throw new Error('Unsafe test directory cleanup');
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { verifyNavigation };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
