const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createService } = require('../payments/service.cjs');
const { paymentMiddleware } = require('../payments/http.cjs');
const { signedEnvelope } = require('../payments/litepos.cjs');
const { createCouponStore } = require('../coupons/store.cjs');

async function main() {
  const { priceOrder } = await import('../src/orderLogic.js');
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coupon-ui-'));
  const platform = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  let purchases = 0;
  const service = createService({ directory, resolveTerminalIp: async () => '8.8.4.4', fetchFn: async (url, options) => {
    assert.ok(url.endsWith('/purchase'), 'No real network or refund in coupon UI QA'); purchases++;
    const body = JSON.parse(options.body).request.body;
    assert.equal(Number(body.amount), 500);
    const data = { ...body, order_sn: `MOCK-${body.check_sn}`, order_type: 1, order_status: 4,
      tenders: [{ tender_sn: `MOCK-T-${body.check_sn}`, internal_transaction_sn: `MOCK-F-${body.check_sn}`, amount: body.amount, pay_status: 3 }] };
    return new Response(signedEnvelope('response', { head: { appid: 'mock', sign_type: 'SHA256' }, body: { result_code: '200', biz_response: { result_code: '200', data } } }, platform.privateKey));
  } });
  await service.dispatch('generate-key');
  await service.dispatch('save-config', { mode: 'test', appid: 'mock', brand_code: 'MOCK', store_sn: 'mock', workstation_sn: '0', operator: 'QA', gateway: 'https://test.shouqianba.com', platformPublicKey: platform.publicKey });
  const middleware = paymentMiddleware(service); const root = path.resolve('dist');
  const server = http.createServer((req, res) => middleware(req, res, () => {
    const file = path.resolve(root, `.${req.url === '/' ? '/index.html' : req.url.split('?')[0]}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); const errors = [];
  fs.mkdirSync('output/playwright', { recursive: true });
  try {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 1024, height: 600 }]) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: viewport.width < 500 ? 2 : 1, serviceWorkers: 'block' });
      await context.addInitScript(() => {
        if (!localStorage.getItem('stall_cashier_ledger_v2')) localStorage.setItem('stall_cashier_ledger_v2', JSON.stringify({ products: [{ id: 'qa', name: '联动测试商品', barcode: 'QA001', price: 10, originalPrice: 10, productType: 'sale', stock: 10, group: '测试', sku: '' }], orders: [], heldCarts: [] }));
      });
      await context.route('**/*', route => route.request().url().startsWith(url) ? route.continue() : route.abort());
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      await page.getByRole('button', { name: '券管理', exact: true }).click();
      await page.getByText('本机联调 · 尚未连接小程序券中心', { exact: true }).waitFor();
      await page.getByRole('button', { name: '创建券活动', exact: true }).click();
      const editor = page.getByRole('dialog', { name: '创建券活动', exact: true });
      await editor.getByLabel('券名称', { exact: true }).fill(`夏日抽奖立减5元-${viewport.width}`);
      await editor.getByLabel('面额（元）', { exact: true }).fill('5');
      await editor.getByLabel('发放上限（张）', { exact: true }).fill('20');
      const shot = async name => {
        await page.screenshot({ path: `output/playwright/coupon-center-${viewport.width}-${name}.png` });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Page has horizontal overflow');
      };
      await editor.getByRole('button', { name: '保存', exact: true }).scrollIntoViewIfNeeded();
      await shot('editor');
      await editor.getByRole('button', { name: '保存', exact: true }).click();
      await editor.waitFor({ state: 'hidden' });
      await page.getByText('正在读取券数据', { exact: true }).waitFor({ state: 'hidden' });
      const issuedCampaign = (await service.dispatch('coupon-campaigns')).find(c => c.name.endsWith(`-${viewport.width}`));
      const cutoff = new Date(Date.now() + 86400000).toISOString();
      const cutoffLabel = new Date(cutoff).toLocaleString('zh-CN', { hour12: false });
      const fixtureStore = createCouponStore({ file: path.join(directory, 'coupon-development', 'coupons.sqlite') });
      try { fixtureStore.dispatch({ id: 'fixture-admin', role: 'admin' }, 'set-deadline', { requestId: crypto.randomUUID(), campaignIds: [issuedCampaign.id], redemptionEndsAt: cutoff, reason: 'Isolated UI deadline test' }); }
      finally { fixtureStore.close(); }
      await page.getByRole('button', { name: '刷新券状态', exact: true }).click();
      await page.getByText('正在读取券数据', { exact: true }).waitFor({ state: 'hidden' });
      await shot('campaigns');
      const card = page.locator('.couponCampaign').filter({ hasText: `夏日抽奖立减5元-${viewport.width}` });
      assert.ok((await card.textContent()).includes(cutoffLabel), 'Campaign must show earlier redemption cutoff');
      await card.getByRole('button', { name: '发券', exact: true }).click();
      const issue = page.getByRole('dialog', { name: '发券', exact: true });
      await issue.getByLabel('领取人标识', { exact: true }).fill(`TEST-OPENID-${viewport.width}`);
      await issue.getByRole('button', { name: '确认发券', exact: true }).click();
      const detail = page.getByRole('dialog', { name: '券详情', exact: true });
      await detail.waitFor();
      assert.ok((await detail.textContent()).includes(cutoffLabel), 'Coupon must show earlier redemption cutoff');
      await detail.getByRole('img', { name: '优惠券核销条形码' }).waitFor();
      assert.ok(await detail.locator('.couponBarcode svg rect').count() > 10);
      await shot('barcode');
      await page.getByRole('button', { name: '关闭券详情' }).click();
      const campaign = (await service.dispatch('coupon-campaigns')).find(c => c.name.endsWith(`-${viewport.width}`));
      const row = (await service.dispatch('coupon-coupons', { campaignId: campaign.id })).items[0];
      const coupon = await service.dispatch('coupon-coupon', { id: row.id });
      await page.getByRole('tab', { name: '小程序接入', exact: true }).click();
      await page.getByRole('button', { name: '新建接入凭证', exact: true }).click();
      const key = page.getByRole('dialog', { name: '新建接入凭证', exact: true });
      await key.getByLabel('凭证名称').fill(`抽奖后台-${viewport.width}`);
      await key.getByLabel('授权活动').selectOption(campaign.id);
      await key.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByRole('dialog', { name: '接入凭证已生成', exact: true }).waitFor();
      assert.match(await page.getByLabel('抽奖后台接入密钥').inputValue(), /^ck_/);
      await page.getByRole('button', { name: '关闭接入凭证' }).click();
      await shot('integration');
      await page.getByRole('button', { name: '收银', exact: true }).click();
      await page.getByRole('button', { name: /^售卖品 联动测试商品/ }).click();
      const barcode = page.getByPlaceholder('商品 / 优惠券条码', { exact: true });
      await barcode.fill(coupon.code); await barcode.press('Enter');
      const remove = page.getByRole('button', { name: `移除优惠券${coupon.name}`, exact: true });
      await remove.waitFor();
      await page.getByRole('dialog', { name: '券状态处理' }).waitFor({ state: 'hidden' });
      assert.equal((await service.dispatch('coupon-coupon', { id: coupon.id })).state, 'RESERVED');
      await remove.click();
      await remove.waitFor({ state: 'hidden' });
      assert.equal((await service.dispatch('coupon-coupon', { id: coupon.id })).state, 'AVAILABLE');
      await barcode.fill(coupon.code); await barcode.press('Enter'); await remove.waitFor();
      await page.getByRole('dialog', { name: '券状态处理' }).waitFor({ state: 'hidden' });
      await shot('cart');
      await page.getByRole('button', { name: '收钱吧收款', exact: true }).click();
      await page.getByRole('checkbox', { name: '我确认本笔为测试收款，可能真实扣款', exact: true }).check();
      await page.getByRole('button', { name: '发起收款', exact: true }).click();
      const paycode = page.getByRole('textbox', { name: '顾客付款码', exact: true });
      await paycode.waitFor(); await page.keyboard.type('130000000000000000'); await page.keyboard.press('Enter');
      await page.getByRole('dialog', { name: '收钱吧收款', exact: true }).waitFor({ state: 'hidden' });
      assert.equal((await service.dispatch('coupon-coupon', { id: coupon.id })).state, 'REDEEMED');
      let ledger = await page.evaluate(() => JSON.parse(localStorage.getItem('stall_cashier_ledger_v2')));
      assert.equal(ledger.orders[0].total, 5); assert.equal(ledger.products[0].stock, 9);
      await page.getByRole('button', { name: /^售卖品 联动测试商品/ }).click();
      await barcode.fill(coupon.code); await barcode.press('Enter');
      await page.getByText('券已使用、已过期或被其他订单占用', { exact: true }).waitFor();
      assert.equal(await remove.count(), 0);
      const c0 = await service.dispatch('coupon-create-campaign', { name: `全额立减-${viewport.width}`, amountCents: 1000, minimumCents: 0, quota: 2, startsAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), requestId: crypto.randomUUID() });
      const zero = await service.dispatch('coupon-issue', { campaignId: c0.id, owner: 'zero-test', awardId: crypto.randomUUID(), requestId: crypto.randomUUID() });
      await barcode.fill(zero.code); await barcode.press('Enter');
      await page.getByRole('button', { name: `移除优惠券${zero.name}`, exact: true }).waitFor();
      await page.getByRole('dialog', { name: '券状态处理' }).waitFor({ state: 'hidden' });
      const before = purchases;
      await page.getByRole('button', { name: '零元结算', exact: true }).click();
      await page.getByRole('button', { name: '确认零元结算', exact: true }).click();
      await page.getByRole('button', { name: '确认零元结算', exact: true }).waitFor({ state: 'hidden' });
      await page.getByRole('dialog', { name: '券状态处理' }).waitFor({ state: 'hidden' });
      assert.equal(purchases, before);
      ledger = await page.evaluate(() => JSON.parse(localStorage.getItem('stall_cashier_ledger_v2')));
      assert.equal(ledger.orders.length, 2); assert.equal(ledger.products[0].stock, 8);
      assert.equal((await service.dispatch('coupon-coupon', { id: zero.id })).state, 'REDEEMED');
      const crashCoupon = await service.dispatch('coupon-issue', { campaignId: c0.id, owner: 'crash-test', awardId: crypto.randomUUID(), requestId: crypto.randomUUID() });
      const crashLine = await service.dispatch('coupon-reserve', { code: crashCoupon.code, checkoutId: crypto.randomUUID(), eligibleCents: 1000, requestId: crypto.randomUUID() });
      const crashDraft = { id: crypto.randomUUID(), orderNo: `POS-RECOVERY-${viewport.width}`, createdAt: new Date().toISOString(), method: '零元结算', ...priceOrder([{ ...ledger.products[0], qty: 1 }, crashLine]) };
      await service.dispatch('coupon-zero', { draft: crashDraft });
      await page.reload();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('stall_cashier_ledger_v2')).orders.length === 3);
      await page.getByRole('dialog', { name: '券状态处理' }).waitFor({ state: 'hidden' });
      await page.reload();
      await page.getByRole('button', { name: '券管理', exact: true }).waitFor();
      ledger = await page.evaluate(() => JSON.parse(localStorage.getItem('stall_cashier_ledger_v2')));
      assert.equal(ledger.orders.length, 3); assert.equal(ledger.products[0].stock, 7);
      await page.getByRole('button', { name: '券管理', exact: true }).click();
      await page.getByRole('tab', { name: '发放记录', exact: true }).click();
      await page.getByText('正在读取券数据', { exact: true }).waitFor({ state: 'hidden' });
      await shot('records');
      await context.close();
    }
    assert.deepEqual(errors, []); console.log(JSON.stringify({ ok: true, viewports: 3, purchases, realNetwork: false, errors }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); service.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
