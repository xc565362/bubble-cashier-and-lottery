const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { verifyNavigation } = require('./ui-navigation-qa.cjs');

async function main() {
  const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const executablePath = process.argv[2];
  if (!executablePath || !fs.existsSync(executablePath)) throw new Error('Pass the packaged executable path');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cashier-navigation-desktop-'));
  const output = path.resolve('output/playwright/navigation-' + require('../package.json').version);
  fs.mkdirSync(output, { recursive: true });
  let app;
  try {
    app = await _electron.launch({ executablePath, args: [`--user-data-dir=${profile}`] });
    const state = await app.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.webContents.setBackgroundThrottling(false);
      window.hide();
      return { packaged: app.isPackaged, version: app.getVersion(), profile: app.getPath('userData') };
    });
    assert.equal(path.resolve(state.profile), path.resolve(profile), 'Only use the isolated test profile');
    assert.equal(state.packaged, true);
    assert.equal(state.version, require('../package.json').version);
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('heading', { name: '摆摊收银台', exact: true }).waitFor();
    await page.locator('.modalBackdrop').waitFor({ state: 'hidden' });
    assert.ok(page.url().startsWith('file:///'));
    const config = await page.evaluate(() => window.sqb.call('config'));
    assert.equal(config.data.ready, false, 'No real merchant credentials in the test profile');
    let cases = 0;
    for (const size of [{ width: 1024, height: 600 }, { width: 390, height: 360 }, { width: 1280, height: 720 }, { width: 860, height: 600 }]) {
      await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setContentSize(value.width, value.height), size);
      for (const tab of ['收银', '商品', '流水', '赠品', '券管理', '抽奖']) {
        await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: tab, exact: true }).click();
        if (tab === '券管理') await page.locator('.couponLoading').waitFor({ state: 'hidden' });
        if (tab === '抽奖') {
          await page.getByText('抽奖管理尚未连接', { exact: true }).waitFor();
          const connection = await page.evaluate(() => window.sqb.call('lottery-config'));
          assert.equal(connection.data.configured, false);
        }
        await verifyNavigation(page, `desktop-${size.width}-${tab}-top`);
        await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
        await verifyNavigation(page, `desktop-${size.width}-${tab}-bottom`);
        cases++;
      }
    }
    assert.deepEqual(errors, []);
    const report = { ...state, cases, navigation: 'passed', screenshots: 'browser-only; hidden Electron capture unavailable', realPayments: 0, pageErrors: errors };
    fs.writeFileSync(path.join(output, 'windows-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    await app?.close();
    if (path.dirname(profile) !== path.resolve(os.tmpdir()) || !path.basename(profile).startsWith('cashier-navigation-desktop-')) throw new Error('Unsafe test directory cleanup');
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
