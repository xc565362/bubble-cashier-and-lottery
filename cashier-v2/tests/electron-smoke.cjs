const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

async function main() {
  const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const executablePath = process.argv[2];
  if (!executablePath || !fs.existsSync(executablePath)) throw new Error('Pass the packaged executable path');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cashier-qa-'));
  const identity = { brand_code: '0', store_sn: 'mock', workstation_sn: '0', check_sn: 'SMOKE-ORIGINAL' };
  const root = { id: 'smoke-original', state: 'paid', acknowledged: true, mode: 'test', amount: 1000, identity, orderSn: 'MOCK-SQB',
    draft: { id: 'smoke-original', orderNo: identity.check_sn, items: [{ id: 'mock-p', name: 'Mock', price: 10, qty: 1, productType: 'sale' }], total: 10 },
    tenders: [{ tenderSn: 'MOCK-T', amount: 1000, payStatus: 3 }] };
  fs.mkdirSync(path.join(profile, 'sqb'));
  fs.writeFileSync(path.join(profile, 'sqb', 'config.json'), JSON.stringify({ ...identity, mode: 'test' }));
  fs.writeFileSync(path.join(profile, 'sqb', 'payments.json'), JSON.stringify({ [root.id]: root }));
  const app = await _electron.launch({ executablePath, args: [`--user-data-dir=${profile}`] });
  try {
    const state = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), profile: app.getPath('userData') }));
    assert.equal(path.resolve(state.profile), path.resolve(profile), 'Smoke test must never use the real data directory');
    assert.equal(state.packaged, true);
    assert.equal(state.version, require('../package.json').version);
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.getByRole('heading', { name: '摆摊收银台', exact: true }).waitFor();
    assert.ok(page.url().startsWith('file:///'));
    const config = await page.evaluate(() => window.sqb.call('config'));
    assert.equal(config.ok, true);
    assert.equal(config.data.ready, false);
    await page.getByRole('button', { name: /^售卖品 示例饮料/ }).click();
    await page.locator('.toast').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '收钱吧收款', exact: true }).click();
    const consent = page.getByRole('checkbox', { name: '我确认本笔为测试收款，可能真实扣款', exact: true });
    assert.equal(await consent.isChecked(), false);
    await consent.check();
    assert.equal(await consent.isChecked(), true);
    assert.equal(await consent.evaluate(el => el.closest('label').querySelector('.confirmationState').textContent), '已确认');
    assert.equal(await consent.evaluate(el => getComputedStyle(el.nextElementSibling).opacity), '1');
    const checkBounds = await consent.boundingBox();
    assert.equal(checkBounds.width, 24); assert.equal(checkBounds.height, 24);
    assert.equal(await page.getByRole('textbox', { name: '顾客付款码', exact: true }).count(), 0);
    await page.screenshot({ path: `output/playwright/windows-confirmation-${state.version}.png` });
    await page.getByRole('button', { name: '关闭收钱吧收款' }).click();
    await page.getByRole('button', { name: '减少数量', exact: true }).click();
    const restoreStatus = await page.evaluate(() => window.sqb.call('restore-status'));
    assert.equal(restoreStatus.ok, true); assert.equal(restoreStatus.data, null);
    const preview = await page.evaluate(() => window.sqb.call('preview-adjustment', { parentId: 'smoke-original', request: { id: 'smoke-refund', type: 'return', returns: [{ lineId: 'smoke-original:0', qty: 1, restockQty: 1 }] } }));
    assert.equal(preview.ok, true, 'Packaged backend must be able to import shared refund logic');
    assert.equal(preview.data.plan.refundCents, 1000);
    const rejected = await page.evaluate(() => window.sqb.call('claim-payment-notification', { id: 'unknown' }));
    assert.equal(rejected.ok, false);
    await page.getByRole('button', { name: '商品', exact: true }).click();
    await page.locator('input[type=file][accept=".csv,.xlsx,.xls"]').setInputFiles(path.resolve('tests/fixtures/coupon-import.csv'));
    await page.getByRole('button', { name: /^字母条码测试商品售卖品/ }).waitFor();
    await page.getByRole('button', { name: '收银', exact: true }).click();
    const scan = page.getByRole('textbox', { name: '商品或优惠券条码' });
    await scan.fill('ABC-001/xy+9'); await scan.press('Enter');
    await scan.fill('COUPON-100'); await scan.press('Enter');
    await page.getByText('实收 ¥0.00', { exact: true }).waitFor();
    await page.screenshot({ path: 'output/playwright/windows-packaged-coupon.png' });
    await page.getByRole('button', { name: '零元结算', exact: true }).click();
    await page.getByRole('button', { name: '确认零元结算', exact: true }).click();
    const order = await page.evaluate(() => JSON.parse(localStorage.getItem('stall_cashier_ledger_v2')).orders[0]);
    assert.equal(order.total, 0); assert.equal(order.couponDiscount, 20);
    const center = await page.evaluate(async () => {
      const campaign = await window.sqb.call('coupon-create-campaign', { requestId: crypto.randomUUID(), name: '桌面券中心验证', amountCents: 500, minimumCents: 0, quota: 3,
        startsAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() });
      if (!campaign.ok) return campaign;
      return window.sqb.call('coupon-issue', { requestId: crypto.randomUUID(), campaignId: campaign.data.id, owner: 'SMOKE', awardId: 'SMOKE-AWARD' });
    });
    assert.equal(center.ok, true, 'Packaged Electron must load built-in SQLite and coupon backend');
    assert.match(center.data.code, /^LJC1_/);
    await page.getByRole('button', { name: '券管理', exact: true }).click();
    await page.getByRole('heading', { name: '桌面券中心验证', exact: true }).waitFor();
    const physical = await page.evaluate(async () => {
      const products = [['cap','BB250005','户外棒球帽（砾石灰）'],['bucket','BB250003','户外渔夫帽（晨雾蓝）'],['waist','BB240011','轻量化运动腰包（海雾蓝）'],['tote','BB260057','超大编织袋']]
        .map(([id,sku,name]) => ({ id,sku,name,barcode:sku,productType:'sale',price:100,stock:2 }));
      const result = await window.sqb.call('coupon-bind-physical-products', { products });
      if (!result.ok) return result;
      return window.sqb.call('coupon-physical-bindings');
    });
    assert.equal(physical.ok, true, 'Packaged desktop exposes physical product binding');
    assert.equal(Object.keys(physical.data.prizes).length, 4);
    const fulfilment = await page.evaluate(() => window.sqb.call('coupon-fulfilment', { orderId:'unknown-physical-order' }));
    assert.equal(fulfilment.ok, true); assert.equal(fulfilment.data.redeemed, false);
    await page.getByRole('tab', { name:'实物商品绑定',exact:true }).click();
    await page.getByRole('tabpanel', { name:'实物商品绑定',exact:true }).waitFor();
    await page.screenshot({ path: `output/playwright/windows-coupon-center-${state.version}.png` });
    await page.evaluate(() => localStorage.setItem('stall_cashier_ledger_v2', JSON.stringify({
      products: [{ id: 'dual-smoke', name: '桌面可售可赠', barcode: 'DUAL-SMOKE', sku: 'DUAL-SMOKE', productType: 'gift', price: 0, stock: 4 }],
      orders: [], heldCarts: [], promoRules: [{ id: 'dual-rule', enabled: true, mode: 'all', mainProductIds: ['dual-smoke'], stackable: true,
        gifts: [{ productId: 'dual-smoke', qty: 1 }], startAt: '', endAt: '' }]
    })));
    await page.reload();
    await page.getByRole('heading', { name: '摆摊收银台', exact: true }).waitFor();
    await page.getByRole('button', { name: '商品', exact: true }).click();
    await page.locator('.inventoryRow').getByRole('button').first().click();
    await page.getByLabel(/^商品类型/).selectOption('sale');
    assert.equal(await page.getByRole('checkbox', { name: '可参与买赠', exact: true }).isChecked(), true);
    await page.getByLabel('售价', { exact: true }).fill('20');
    await page.getByRole('button', { name: '保存商品', exact: true }).click();
    await page.getByRole('button', { name: '收银', exact: true }).click();
    await page.getByRole('textbox', { name: '商品或优惠券条码' }).fill('DUAL-SMOKE');
    await page.getByRole('textbox', { name: '商品或优惠券条码' }).press('Enter');
    assert.equal(await page.locator('.cartItem').count(), 2);
    assert.match(await page.locator('.cartTotals strong').innerText(), /20\.00/);
    assert.match(await page.locator('.cartItem').filter({ hasText: '活动赠送 · 免费' }).innerText(), /¥0\.00/);
    await page.screenshot({ path: `output/playwright/windows-sale-gift-${state.version}.png` });
    const { searchOrders } = await import('./fixtures/ledger-search.js');
    await page.evaluate(orders => {
      const ledger = JSON.parse(localStorage.getItem('stall_cashier_ledger_v2'));
      localStorage.setItem('stall_cashier_ledger_v2', JSON.stringify({ ...ledger, orders }));
    }, searchOrders());
    await page.reload();
    await page.getByRole('heading', { name: '摆摊收银台', exact: true }).waitFor();
    await page.getByRole('navigation').getByRole('button', { name: '流水', exact: true }).click();
    await page.getByRole('button', { name: '全部日期', exact: true }).click();
    await page.getByRole('combobox', { name: '查询字段', exact: true }).selectOption('货品编码');
    await page.getByLabel('查询内容', { exact: true }).fill('BB240011');
    await page.getByRole('button', { name: '查询', exact: true }).click();
    assert.equal(await page.locator('.orderRow').count(), 1);
    assert.match(await page.locator('.orderRow').innerText(), /运动腰包/);
    assert.match(await page.locator('.orderSummary').innerText(), /120\.00/);
    await page.screenshot({ path: `output/playwright/windows-ledger-search-${state.version}.png` });
    await page.evaluate(record => {
      const ledger = JSON.parse(localStorage.getItem('stall_cashier_ledger_v2'));
      localStorage.setItem('stall_cashier_ledger_v2', JSON.stringify({ ...ledger, pendingPayment: {
        draft: { ...record.draft, orderNo: record.identity.check_sn }, started: true, record,
      } }));
    }, root);
    await page.reload();
    await page.getByRole('button', { name: '关闭弹窗，保留待核对', exact: true }).click();
    await page.getByRole('button', { name: '查看待核对收款', exact: true }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: '查看待核对收款', exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog', { name: '收钱吧收款', exact: true }).count(), 0);
    await page.getByRole('navigation').getByRole('button', { name: '流水', exact: true }).click();
    await page.getByRole('heading', { name: '收款流水', exact: true }).waitFor();
    await page.screenshot({ path: `output/playwright/windows-payment-review-${state.version}.png` });
    const shown = await app.evaluate(async ({ Notification }) => {
      if (!Notification.isSupported()) return false;
      return new Promise((resolve) => {
        const notification = new Notification({ id: 'cashier-qa', title: '收银系统通知测试', body: '测试消息，未发生真实收款。' });
        const timer = setTimeout(() => resolve(false), 5000);
        notification.once('show', () => { clearTimeout(timer); resolve(true); });
        notification.once('failed', () => { clearTimeout(timer); resolve(false); });
        notification.show();
      });
    });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ...state, productionUI: 'passed', confirmationUI: 'passed', ipc: 'passed', packagedRefundLogic: 'passed', couponCheckout: 'passed', couponCenterSQLite: 'passed', physicalIPC: 'passed', saleAndGift: 'passed', ledgerSearch: 'passed', paymentReview: 'passed', nativeTestNotificationShown: shown, realPayments: 0 }));
  } finally {
    await app.close();
    const resolved = path.resolve(profile);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('cashier-qa-')) throw new Error('Unsafe profile cleanup');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
