async (page) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let submitted;
  let purchases = 0;
  let acknowledged = false;
  let claimed = false;
  let state = 'pending';
  await page.route('**/api/sqb/*', async (route) => {
    const action = route.request().url().split('?')[0].split('/').pop();
    let data;
    if (action === 'config') data = { ready: true, mode: 'production' };
    if (action === 'pending') data = submitted && !acknowledged ? [{ ...submitted, state }] : [];
    if (action === 'start') {
      purchases++;
      const { draft } = route.request().postDataJSON();
      if (draft.total !== 17) throw new Error('Coupon was not applied to payment request');
      submitted = { id: draft.id, draft, amount: 1700, identity: { check_sn: draft.orderNo }, state, orderSn: 'SQB_UI_ORDER',
        tenders: [{ tenderSn: 'TENDER', payStatus: 3, amount: 1700, internalTransactionSn: '000012345678901234567890', channel: '微信', channelSn: 'WX_TEST' }], updatedAt: new Date().toISOString() };
      data = submitted;
    }
    if (action === 'query') data = { ...submitted, state };
    if (action === 'acknowledge') { acknowledged = true; data = { ok: true }; }
    if (action === 'claim-payment-notification') {
      if (state !== 'paid') throw new Error('Notification requested before payment confirmation');
      data = claimed ? null : { id: submitted.id, title: '收款成功', body: '收款成功，收款 17.00 元\n收钱吧流水号 000012345678901234567890' };
      claimed = true;
    }
    await route.fulfill({ json: { ok: true, data } });
  });
  await page.addInitScript(() => {
    class MockNotification {
      static permission = 'granted';
      static requestPermission() { return Promise.resolve('granted'); }
      constructor(title, options) {
        const notices = JSON.parse(sessionStorage.getItem('qa-notices') || '[]');
        notices.push({ title, ...options });
        sessionStorage.setItem('qa-notices', JSON.stringify(notices));
      }
    }
    window.Notification = MockNotification;
    Object.defineProperty(navigator.serviceWorker, 'getRegistration', { configurable: true, value: async () => null });
  });
  await page.goto('http://localhost:5173/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole('button', { name: '商品', exact: true }).click();
  await page.locator('input[type=file][accept=".csv,.xlsx,.xls"]').setInputFiles('tests/fixtures/coupon-import.csv');
  await page.getByRole('button', { name: /^字母条码测试商品售卖品/ }).waitFor();
  await page.getByRole('button', { name: '新商品', exact: true }).click();
  await page.getByLabel('产品名称', { exact: true }).fill('三元优惠券');
  await page.getByLabel('条码', { exact: true }).fill('6900000000003');
  await page.getByRole('combobox', { name: '商品类型', exact: true }).selectOption('coupon');
  await page.getByLabel('抵扣金额', { exact: true }).fill('3');
  await page.screenshot({ path: 'output/playwright/coupon-editor-desktop.png' });
  const save = page.getByRole('button', { name: '保存商品', exact: true });
  const bounds = await save.boundingBox();
  if (!bounds || bounds.y + bounds.height > 768) throw new Error('Save button outside desktop viewport');
  await save.click();
  await page.getByRole('button', { name: '收银', exact: true }).click();
  const scan = async (code) => {
    const field = page.getByRole('textbox', { name: '商品或优惠券条码' });
    await field.fill(code); await field.press('Enter');
  };
  await scan('00123');
  await page.getByRole('complementary').getByText('前导零条码商品', { exact: true }).waitFor();
  await page.getByRole('button', { name: '减少数量', exact: true }).click();
  await scan('7');
  await page.getByRole('complementary').getByText('短条码商品', { exact: true }).waitFor();
  await page.getByRole('button', { name: '减少数量', exact: true }).click();
  await page.getByRole('button', { name: '全部', exact: true }).focus();
  await page.keyboard.type('ABC-001/xy+9', { delay: 5 });
  await page.keyboard.press('Enter');
  await page.getByRole('complementary').getByText('字母条码测试商品', { exact: true }).waitFor();
  await scan('6900000000003');
  await page.getByText('实收 ¥17.00', { exact: true }).waitFor();
  await scan('6900000000003');
  await page.getByText('每笔订单最多使用一张优惠券，请先移除原券', { exact: true }).waitFor();
  await scan('COUPON-100');
  if (await page.locator('.couponLine').count() !== 1) throw new Error('Multiple coupon lines');
  await page.getByText('实收 ¥17.00', { exact: true }).waitFor();
  await page.screenshot({ path: 'output/playwright/coupon-cart-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'output/playwright/coupon-cart-mobile.png', fullPage: true });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Mobile horizontal overflow');
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole('button', { name: '收钱吧收款', exact: true }).click();
  const input = page.getByRole('textbox', { name: '顾客付款码', exact: true });
  await input.fill('130000000000000000'); await input.press('Enter');
  await page.getByText('等待顾客付款 / 正在核实', { exact: true }).waitFor();
  if (await page.evaluate(() => sessionStorage.getItem('qa-notices'))) throw new Error('Premature success notification');
  if (!await page.getByRole('button', { name: '关闭收钱吧收款' }).isDisabled()) throw new Error('Pending payment can close');
  await page.reload();
  await page.getByRole('dialog', { name: '收钱吧收款', exact: true }).waitFor();
  state = 'paid';
  await page.getByRole('dialog', { name: '收钱吧收款', exact: true }).waitFor({ state: 'hidden' });
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('qa-notices') || '[]').length === 1);
  await page.getByRole('button', { name: '流水', exact: true }).click();
  await page.getByText('流水号 000012345678901234567890 · 已收款', { exact: true }).waitFor();
  await page.screenshot({ path: 'output/playwright/coupon-paid-desktop.png' });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出流水', exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs('output/playwright/coupon-ledger.csv');
  await page.reload();
  const verified = await page.evaluate(() => {
    const ledger = JSON.parse(localStorage.getItem('stall_cashier_ledger_v2'));
    return { ledger, notices: JSON.parse(sessionStorage.getItem('qa-notices') || '[]') };
  });
  if (verified.notices.length !== 1 || purchases !== 1) throw new Error('Repeated payment or notification');
  if (verified.ledger.orders[0].total !== 17) throw new Error('Wrong order amount');
  if (verified.ledger.products.find(p => p.barcode === 'ABC-001/xy+9').stock !== 7) throw new Error('Wrong merchandise stock');
  if (verified.ledger.products.find(p => p.barcode === '6900000000003').stock !== 0) throw new Error('Coupon deducted from stock');
  await scan('ABC-001/xy+9');
  await scan('COUPON-100');
  await page.getByText('实收 ¥0.00', { exact: true }).waitFor();
  await page.getByRole('button', { name: '零元结算', exact: true }).click();
  await page.getByRole('button', { name: '确认零元结算', exact: true }).click();
  const zero = await page.evaluate(() => JSON.parse(localStorage.getItem('stall_cashier_ledger_v2')).orders[0]);
  if (zero.total !== 0 || zero.couponDiscount !== 20 || zero.method !== '零元结算' || purchases !== 1) throw new Error('Zero coupon settlement lost discount or charged gateway');
  await scan('6900000000003');
  if (!await page.getByRole('button', { name: '零元结算', exact: true }).isDisabled()) throw new Error('Coupon-only checkout is enabled');
  await page.locator('.couponLine').getByRole('button').click();
  await page.getByRole('button', { name: '商品', exact: true }).click();
  await page.getByRole('button', { name: /^三元优惠券优惠券/ }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'output/playwright/coupon-editor-mobile.png' });
  const mobileSave = await page.getByRole('button', { name: '保存商品', exact: true }).boundingBox();
  if (!mobileSave || mobileSave.y + mobileSave.height > 844 || mobileSave.x < 0 || mobileSave.x + mobileSave.width > 390) throw new Error('Save outside mobile screen');
  if (errors.length) throw new Error(errors.join('; '));
  console.log('PASS: CSV import, coupon editor, arbitrary/HID/leading-zero/short barcodes, one-coupon limit, exact deduction, pending recovery, one mocked notification, SQB serial, unchanged coupon stock, zero-total checkout, desktop/mobile layouts. No real payment was sent.');
}
