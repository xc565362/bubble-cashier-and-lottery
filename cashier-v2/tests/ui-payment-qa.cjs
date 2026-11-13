async (page) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.unroute('**/api/sqb/*');
  await page.goto('http://localhost:5173/');
  await page.getByRole('button', { name: /^售卖品 示例饮料/ }).click();
  let submitted;
  let purchases = 0;
  let state = 'pending';
  await page.route('**/api/sqb/*', async (route) => {
    const action = route.request().url().split('?')[0].split('/').pop();
    let data;
    if (action === 'config') data = { ready: true, mode: 'production' };
    if (action === 'pending') data = submitted ? [submitted] : [];
    if (action === 'start') {
      purchases++;
      const { draft } = route.request().postDataJSON();
      submitted = { id: draft.id, draft, amount: Math.round(draft.total * 100), identity: { check_sn: draft.orderNo }, state, orderSn: 'SQB_UI_MOCK', tenders: [], updatedAt: new Date().toISOString() };
      data = submitted;
    }
    if (action === 'query') data = { ...submitted, state };
    if (action === 'acknowledge') data = { ok: true };
    await route.fulfill({ json: { ok: true, data } });
  });
  await page.getByRole('button', { name: '收钱吧收款', exact: true }).click();
  await page.getByRole('checkbox', { name: '我确认本笔金额，将向顾客真实收款', exact: true }).check();
  await page.getByRole('button', { name: '发起收款', exact: true }).click();
  const input = page.getByRole('textbox', { name: '顾客付款码', exact: true });
  await input.waitFor();
  if (!await input.evaluate(el => document.activeElement === el)) throw new Error('Scanner input not focused');
  await page.keyboard.type('130000000000000000');
  await page.keyboard.press('Enter');
  await page.getByText('等待顾客付款 / 正在核实', { exact: true }).waitFor();
  if (!await page.getByRole('button', { name: '关闭收钱吧收款' }).isDisabled()) throw new Error('Pending payment can be discarded');
  await page.reload();
  await page.getByRole('dialog', { name: '收钱吧收款', exact: true }).waitFor();
  state = 'paid';
  await page.getByRole('dialog', { name: '收钱吧收款', exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '流水', exact: true }).click();
  await page.getByText(/收钱吧轻POS订单号 SQB_UI_MOCK/).waitFor();
  if (purchases !== 1) throw new Error('Duplicate payment initiation');
  if (errors.length) throw new Error(errors.join('; '));
  await page.screenshot({ path: 'output/playwright/sqb-paid-desktop.png' });
  await page.getByRole('button', { name: '商品', exact: true }).click();
  await page.getByRole('button', { name: '收钱吧设置', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'output/playwright/sqb-settings-mobile.png' });
  const bounds = await page.getByRole('button', { name: '保存配置', exact: true }).boundingBox();
  if (!bounds || bounds.y + bounds.height > 844 || bounds.x < 0 || bounds.x + bounds.width > 390) throw new Error('Save button outside mobile viewport');
  console.log('Mock payment UI passed: pending lock, reload recovery, paid order, one purchase, mobile save visible. No real payment was sent.');
}
