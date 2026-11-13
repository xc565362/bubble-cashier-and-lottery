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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cashier-confirmation-'));
  const platform = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  let purchases = 0;
  let holdPayment = false;
  const remote = new Map();
  const paymentData = body => ({ ...body, order_sn: `MOCK-${body.check_sn}`, order_type: 1, order_status: holdPayment ? 3 : 4,
    tenders: [{ tender_sn: `MOCK-T-${body.check_sn}`, internal_transaction_sn: `MOCK-FLOW-${body.check_sn}`, amount: body.amount, paid_amount: body.amount, collected_amount: body.amount, pay_status: holdPayment ? 2 : 3, sub_tender_type: 302, pay_time: new Date().toISOString() }] });
  const service = createService({ directory, resolveTerminalIp: async () => '8.8.4.4', fetchFn: async (url, options) => {
    const body = JSON.parse(options.body).request.body;
    let data;
    if (url.endsWith('/refunds-query')) data = { refund_orders: [] };
    else if (url.endsWith('/purchase')) {
      purchases++;
      remote.set(body.check_sn, body);
      data = paymentData(body);
    } else if (url.endsWith('/query')) data = paymentData(remote.get(body.check_sn));
    else throw new Error('Confirmation UI test must not submit a refund');
    return new Response(signedEnvelope('response', { head: { appid: 'mock', sign_type: 'SHA256' }, body: { result_code: '200', biz_response: { result_code: '200', data } } }, platform.privateKey));
  } });
  await service.dispatch('generate-key');
  await service.dispatch('save-config', { mode: 'test', appid: 'mock', brand_code: 'MOCK', store_sn: 'mock', workstation_sn: '0', operator: 'QA', gateway: 'https://test.shouqianba.com', platformPublicKey: platform.publicKey });
  const products = [{ id: 'qa-product', name: '确认状态测试商品', barcode: 'QA-001', sku: 'QA-001', group: '测试', productType: 'sale', price: 10, originalPrice: 10, stock: 10, qty: 2, discount: 0 }];
  const draft = { id: crypto.randomUUID(), orderNo: 'MOCK-CONFIRMATION', createdAt: new Date().toISOString(), method: '收钱吧', ...priceOrder(products) };
  const paid = await service.dispatch('start', { draft, code: '130000000000000000', confirmTestPayment: true });
  const ledger = completeSqbOrder({ products, orders: [], pendingPayment: { draft } }, paid);
  await service.dispatch('acknowledge', { id: paid.id });
  const middleware = paymentMiddleware(service);
  const root = path.resolve('dist');
  const server = http.createServer((req, res) => middleware(req, res, () => {
    const file = path.resolve(root, `.${req.url === '/' ? '/index.html' : req.url.split('?')[0]}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  try {
    for (const { production = false, ...viewport } of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 1024, height: 600 }, { width: 1280, height: 800, production: true }]) {
      if (production) await service.dispatch('save-config', { mode: 'production', appid: 'mock', brand_code: 'MOCK', store_sn: 'mock', workstation_sn: '0', operator: 'QA', gateway: 'https://test.shouqianba.com', platformPublicKey: platform.publicKey });
      const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      await context.route('**/*', route => route.request().url().startsWith(url) ? route.continue() : route.abort());
      const page = await context.newPage();
      const startingPurchases = purchases;
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      await page.getByRole('heading', { name: '摆摊收银台', exact: true }).waitFor();
      await page.evaluate(value => localStorage.setItem('stall_cashier_ledger_v2', JSON.stringify(value)), ledger);
      await page.reload();
      const screenshot = async name => {
        await page.screenshot({ path: `output/playwright/confirmation-${viewport.width}-${production ? 'production-' : ''}${name}.png` });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Page must not overflow horizontally');
      };
      const checkVisual = async (checkbox, checked) => {
        assert.equal(await checkbox.isChecked(), checked);
        const state = await checkbox.evaluate(el => {
          const label = el.closest('label');
          const box = el.getBoundingClientRect();
          return { width: box.width, height: box.height, padding: getComputedStyle(el).padding, checkOpacity: getComputedStyle(el.nextElementSibling).opacity,
            text: label.querySelector('.confirmationState').textContent, selected: label.dataset.checked };
        });
        assert.equal(state.width, 24); assert.equal(state.height, 24); assert.equal(state.padding, '0px');
        assert.equal(state.checkOpacity, checked ? '1' : '0');
        assert.equal(state.selected, String(checked)); assert.equal(state.text, checked ? '已确认' : '未勾选');
      };
      await page.getByRole('button', { name: /^售卖品 确认状态测试商品/ }).click();
      await page.locator('.toast').waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: '收钱吧收款', exact: true }).click();
      const paymentCheck = page.getByRole('checkbox', { name: production ? '我确认本笔金额，将向顾客真实收款' : '我确认本笔为测试收款，可能真实扣款', exact: true });
      const payButton = page.getByRole('button', { name: '发起收款', exact: true });
      await paymentCheck.waitFor();
      const input = page.getByRole('textbox', { name: '顾客付款码', exact: true });
      assert.equal(await input.count(), 0, 'Code entry must not be active before confirmation and arming');
      await checkVisual(paymentCheck, false); assert.equal(await payButton.isDisabled(), true);
      await screenshot('payment-unchecked');
      await page.locator('.confirmationText').click();
      await checkVisual(paymentCheck, true); assert.equal(await payButton.isEnabled(), true);
      await screenshot('payment-checked');
      await paymentCheck.focus(); await paymentCheck.press('Space');
      await checkVisual(paymentCheck, false); assert.equal(await payButton.isDisabled(), true);
      const focus = await paymentCheck.evaluate(el => getComputedStyle(el.closest('label')).outlineWidth);
      assert.equal(focus, '3px');
      await page.keyboard.type('130000000000000000'); await page.keyboard.press('Enter');
      assert.equal(await input.count(), 0);
      assert.equal(purchases, startingPurchases, 'Unchecked confirmation must never start a payment');
      await paymentCheck.check(); await payButton.click();
      await input.waitFor();
      assert.equal(await input.evaluate(el => document.activeElement === el), true, 'Arming must focus the scanner without a second click');
      assert.equal(purchases, startingPurchases, 'Waiting for a code must not call purchase');
      assert.equal(await page.evaluate(() => !!JSON.parse(localStorage.getItem('stall_cashier_ledger_v2')).pendingPayment), false);
      await screenshot('payment-waiting');
      await page.keyboard.type('6912345678901'); await page.keyboard.press('Enter');
      await page.getByText('付款码不完整或不是顾客付款码，请重新扫描', { exact: true }).waitFor();
      assert.equal(await input.inputValue(), '');
      assert.equal(purchases, startingPurchases);
      await input.evaluate(el => el.blur());
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      assert.equal(await input.evaluate(el => document.activeElement === el), true);
      await page.keyboard.type('130000000000000000');
      assert.equal(purchases, startingPurchases, 'Do not submit at an assumed length before the scanner terminator');
      await page.getByRole('button', { name: '取消等待', exact: true }).click();
      await checkVisual(paymentCheck, false); assert.equal(await input.count(), 0);
      await paymentCheck.check(); await payButton.click();
      await input.waitFor(); assert.equal(await input.inputValue(), '');
      await page.getByRole('button', { name: '关闭收钱吧收款' }).click();
      assert.equal(purchases, startingPurchases);
      if (!production) {
        await page.getByRole('button', { name: '流水', exact: true }).click();
        await page.getByRole('button', { name: '退货 / 取消并退款', exact: true }).click();
        await page.getByRole('button', { name: '核对退换货', exact: true }).click();
        const amountCheck = page.getByRole('checkbox', { name: /^确认商品数量/ });
        const testCheck = page.getByRole('checkbox', { name: '确认测试商户可能真实收退款', exact: true });
        const refundButton = page.getByRole('button', { name: '确认原路退款', exact: true });
        await amountCheck.waitFor();
        await checkVisual(amountCheck, false); await checkVisual(testCheck, false);
        assert.equal(await refundButton.isDisabled(), true);
        await screenshot('refund-unchecked');
        await amountCheck.check();
        await checkVisual(amountCheck, true); assert.equal(await refundButton.isDisabled(), true);
        await screenshot('refund-partial');
        await page.locator('.confirmationCheck').filter({ has: testCheck }).locator('.confirmationState').click();
        await checkVisual(testCheck, true); assert.equal(await refundButton.isEnabled(), true);
        await refundButton.scrollIntoViewIfNeeded();
        const bounds = await refundButton.boundingBox();
        assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height);
        await screenshot('refund-checked');
        await testCheck.uncheck(); assert.equal(await refundButton.isDisabled(), true);
        await testCheck.check();
        await page.getByRole('spinbutton', { name: '确认状态测试商品退货数量', exact: true }).fill('1');
        await page.getByRole('button', { name: '核对退换货', exact: true }).click();
        await checkVisual(amountCheck, false); assert.equal(await refundButton.isDisabled(), true, 'Changing the amount must require confirmation again');
        await page.getByRole('button', { name: '关闭退换货', exact: true }).click();
        await page.getByRole('button', { name: '收银', exact: true }).click();
      }
      await page.getByRole('button', { name: '收钱吧收款', exact: true }).click();
      await paymentCheck.waitFor();
      assert.equal(await paymentCheck.isChecked(), false, 'Reopening requires a fresh confirmation');
      await paymentCheck.check(); await payButton.click();
      await input.waitFor();
      assert.equal(await input.evaluate(el => document.activeElement === el), true);
      holdPayment = true;
      await page.keyboard.type('130000000000000000');
      if (viewport.width === 1024) await page.getByRole('button', { name: '提交付款码', exact: true }).click();
      else await page.keyboard.press(viewport.width === 390 ? 'Tab' : 'Enter');
      await page.getByText('等待顾客付款 / 正在核实', { exact: true }).waitFor();
      await page.keyboard.press('Enter');
      assert.equal(purchases, startingPurchases + 1, 'A scan may start exactly one payment');
      assert.equal(await page.getByRole('button', { name: '关闭收钱吧收款' }).isDisabled(), true);
      let saved = await page.evaluate(() => JSON.parse(localStorage.getItem('stall_cashier_ledger_v2')));
      assert.equal(saved.orders.length, 1); assert.equal(saved.products[0].stock, 8);
      assert.equal(JSON.stringify(saved).includes('130000000000000000'), false);
      await page.reload();
      await page.getByRole('dialog', { name: '收钱吧收款', exact: true }).waitFor();
      assert.equal(await input.count(), 0, 'A recovered submitted payment must only query, never re-arm');
      holdPayment = false;
      await page.getByRole('button', { name: '重新查询支付结果', exact: true }).click();
      await page.getByRole('dialog', { name: '收钱吧收款', exact: true }).waitFor({ state: 'hidden' });
      saved = await page.evaluate(() => JSON.parse(localStorage.getItem('stall_cashier_ledger_v2')));
      assert.equal(saved.orders.length, 2); assert.equal(saved.products[0].stock, 7);
      assert.equal(purchases, startingPurchases + 1);
      await context.close();
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ confirmationUI: 'passed', viewports: ['1280x800', '390x844', '1024x600'], paymentGate: 'passed', configModes: ['test', 'production'], refundGate: 'passed', keyboardAndLabel: 'passed', confirmationReset: 'passed', scannerAutoFocus: 'passed', enterAndTab: 'passed', manualFallback: 'passed', cancelBeforeSubmit: 'passed', pendingRecovery: 'passed', exactOnceStock: 'passed', realNetworkPayments: 0 }));
  } finally {
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('cashier-confirmation-')) throw new Error('Unsafe temporary directory');
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
