async (page) => {
  const errors = [];
  const calls = [];
  let purchases = 0;
  let record;
  let acknowledged = false;
  let config = { ready: true, mode: 'test', appid: 'MOCK_APP', brand_code: 'MOCK_BRAND', store_sn: 'MOCK_STORE',
    workstation_sn: '0', operator: 'QA', gateway: 'https://vapi.shouqianba.com', notify_url: '',
    merchantPublicKey: 'MOCK PUBLIC KEY', platformPublicKey: 'MOCK PLATFORM PUBLIC KEY', keyFingerprint: '1234567890abcdef'.repeat(4) };
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => { window.confirm = () => Boolean(window.qaAcceptDialog); });
  await page.route('**/api/sqb/*', async (route) => {
    const action = route.request().url().split('/').pop();
    const payload = route.request().postDataJSON();
    calls.push(action);
    let data;
    if (action === 'config') data = config;
    else if (action === 'pending') data = record && !acknowledged ? [record] : [];
    else if (action === 'save-config') data = config = { ...config, ...payload, connectionCheck: null };
    else if (action === 'import-credentials') {
      if (payload.bundle && payload.password !== 'qa-migration-password') {
        await route.fulfill({ json: { ok: false, error: '配置包密码错误或文件已损坏' } }); return;
      }
      if (!payload.bundle && payload.privateKey.trim() !== 'MOCK KEY FOR UI TEST ONLY') throw new Error('Unexpected fixture');
      data = config = { ...config, ...(payload.config || {}), ready: true, connectionCheck: null };
    } else if (action === 'check-connection') {
      data = config = { ...config, connectionCheck: { verified: true, checkedAt: new Date().toISOString(), terminalIp: '8.8.4.4', message: '签名查单及响应验签通过，未发起收款；支付权限仍需实测' } };
    } else if (action === 'export-credentials') data = { format: 'stall-sqb-credentials', version: 1, data: 'MOCK_ENCRYPTED_DATA' };
    else if (action === 'start') {
      if (payload.confirmTestPayment !== true) throw new Error('Missing test consent');
      purchases++;
      record = { id: payload.draft.id, draft: payload.draft, amount: Math.round(payload.draft.total * 100), mode: 'test',
        identity: { check_sn: payload.draft.orderNo }, state: 'pending', orderSn: 'MOCK_ORDER', tenders: [], updatedAt: new Date().toISOString() };
      data = record;
    } else if (action === 'query') data = record;
    else if (action === 'acknowledge') { acknowledged = true; data = { ok: true }; }
    else if (action === 'claim-payment-notification') data = null;
    else throw new Error(`Unexpected API: ${action}`);
    await route.fulfill({ json: { ok: true, data } });
  });
  await page.goto('http://localhost:5173/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole('button', { name: '商品', exact: true }).click();
  await page.getByRole('button', { name: '收钱吧设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '收钱吧设置' });
  const check = settings.getByRole('button', { name: '联网检测（不扣款）', exact: true });
  await check.click();
  await settings.getByText(/已通过签名查单和验签/).waitFor();
  await settings.getByLabel('收银员', { exact: true }).fill('QA2');
  if (!await check.isDisabled()) throw new Error('Dirty configuration allowed connectivity check');
  await settings.getByRole('button', { name: '保存配置', exact: true }).click();
  await settings.getByText('配置已保存，请运行联网检测（不扣款）', { exact: true }).waitFor();
  await settings.getByLabel('签名私钥文件', { exact: true }).setInputFiles('tests/fixtures/mock-key.txt');
  await settings.getByRole('button', { name: '保存配置', exact: true }).click();
  if (calls.includes('import-credentials')) throw new Error('Dismissed key replacement was submitted');
  await page.evaluate(() => { window.qaAcceptDialog = true; });
  await settings.getByRole('button', { name: '保存配置', exact: true }).click();
  await settings.getByText('已配置签名私钥', { exact: true }).waitFor();
  if (calls.filter(action => action === 'import-credentials').length !== 1) throw new Error('Key import not exactly once');
  await check.click();
  await settings.getByText(/已通过签名查单和验签/).waitFor();
  await page.screenshot({ path: 'output/playwright/config-desktop.png' });
  const saveBounds = await settings.getByRole('button', { name: '保存配置', exact: true }).boundingBox();
  if (!saveBounds || saveBounds.y + saveBounds.height > 768) throw new Error('Save outside desktop viewport');
  const password = settings.getByLabel('配置包密码', { exact: true });
  const repeated = settings.getByLabel('导出时再次输入密码', { exact: true });
  const exportButton = settings.getByRole('button', { name: '导出加密配置', exact: true });
  await password.fill('qa-migration-password');
  await repeated.fill('does-not-match');
  if (!await exportButton.isDisabled()) throw new Error('Password mismatch allowed export');
  await repeated.fill('qa-migration-password');
  const downloaded = page.waitForEvent('download');
  await exportButton.click();
  await (await downloaded).saveAs('output/playwright/mock-encrypted-config.json');
  await settings.getByText('加密配置包已导出，密码请另行保管', { exact: true }).waitFor();
  if (await password.inputValue() || await repeated.inputValue()) throw new Error('Password retained after export');
  const file = 'tests/fixtures/mock.sqb.json';
  await password.fill('incorrect-password');
  await settings.getByLabel('加密配置文件', { exact: true }).setInputFiles(file);
  await settings.getByText('配置包密码错误或文件已损坏', { exact: true }).waitFor();
  if (await settings.getByLabel('收银员', { exact: true }).inputValue() !== 'QA2') throw new Error('Failed import changed form');
  await password.fill('qa-migration-password');
  await settings.getByLabel('加密配置文件', { exact: true }).setInputFiles(file);
  await settings.getByText('加密配置包已导入，请运行联网检测', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'output/playwright/config-mobile.png' });
  const mobileSave = await settings.getByRole('button', { name: '保存配置', exact: true }).boundingBox();
  if (!mobileSave || mobileSave.y + mobileSave.height > 844 || mobileSave.x + mobileSave.width > 390) throw new Error('Save outside mobile viewport');
  if (await settings.evaluate(el => el.scrollWidth > el.clientWidth)) throw new Error('Settings overflow');
  await settings.getByRole('button', { name: '关闭收钱吧设置' }).click();
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole('button', { name: '收银', exact: true }).click();
  await page.getByRole('button', { name: /^售卖品 示例饮料/ }).click();
  await page.getByRole('button', { name: '收钱吧收款', exact: true }).click();
  const payment = page.getByRole('dialog', { name: '收钱吧收款', exact: true });
  const code = payment.getByLabel('顾客付款码', { exact: true });
  await code.fill('130000000000000000');
  await code.press('Enter');
  if (purchases !== 0 || !await payment.getByRole('button', { name: '发起收款', exact: true }).isDisabled()) throw new Error('Test payment missing consent gate');
  await page.screenshot({ path: 'output/playwright/test-payment-consent.png' });
  await payment.getByRole('checkbox').check();
  await code.press('Enter');
  await payment.getByText('等待顾客付款 / 正在核实', { exact: true }).waitFor();
  if (!await payment.getByRole('button', { name: '关闭收钱吧收款' }).isDisabled()) throw new Error('Unknown payment can be discarded');
  await page.reload();
  await payment.waitFor();
  record = { ...record, state: 'paid', tenders: [{ tenderSn: 'MOCK_TENDER', amount: record.amount, payStatus: 3, internalTransactionSn: 'MOCK_TEST_SERIAL' }] };
  await payment.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '流水', exact: true }).click();
  await page.getByText(/测试商户/).waitFor();
  const ledger = await page.evaluate(() => JSON.parse(localStorage.getItem('stall_cashier_ledger_v2')));
  if (ledger.orders.length !== 1 || ledger.orders[0].payment.mode !== 'test' || purchases !== 1) throw new Error('Test receipt/deduplication failed');
  if (errors.length) throw new Error(errors.join('; '));
  await page.evaluate(() => { window.qaConfigPassed = true; });
  console.log('PASS: mock import/confirmation, dirty config, connectivity status, encrypted transfer/password handling, desktop/mobile layout, explicit test consent, pending recovery, one test-labelled receipt. All payment API traffic was intercepted.');
}
