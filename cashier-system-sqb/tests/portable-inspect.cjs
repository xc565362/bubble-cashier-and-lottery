const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

async function main() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const profile = path.resolve(process.argv[2] || '');
  if (path.dirname(profile) !== path.resolve(os.tmpdir()) || !path.basename(profile).startsWith('cashier-qa-')) throw new Error('Only an isolated smoke-test profile is allowed');
  const [port] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${Number(port)}`);
  try {
    const page = browser.contexts()[0].pages()[0];
    await page.getByRole('heading', { name: '摆摊收银台', exact: true }).waitFor();
    assert.ok(page.url().startsWith('file:///'));
    const state = await page.evaluate(async () => ({ status: await window.sqb.call('restore-status'),
      preview: await window.sqb.call('preview-adjustment', { parentId: 'smoke-original', request: { id: 'portable-refund', type: 'return', returns: [{ lineId: 'smoke-original:0', qty: 1, restockQty: 1 }] } }) }));
    assert.equal(state.status.ok, true);
    assert.equal(state.preview.data.plan.refundCents, 1000);
    await page.screenshot({ path: 'output/playwright/windows-portable-0.6.0.png' });
    console.log(JSON.stringify({ portable: 'passed', ui: 'nonblank', refundPreviewIPC: 'passed', profile, realMoneyOperations: 0 }));
  } finally {
    const session = await browser.newBrowserCDPSession();
    await session.send('Browser.close').catch(() => {});
    await browser.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
