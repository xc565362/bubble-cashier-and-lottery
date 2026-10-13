const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createService } = require('../payments/service.cjs');
const { paymentMiddleware } = require('../payments/http.cjs');
const { createService: createDraw } = require('../lottery-backend/service.js');
const { createManagementHttp } = require('../lottery-backend/management-http.cjs');
const baseline = require('../lottery-backend/config.js');

async function main() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const output = path.resolve('output/playwright/lottery-management-0.7.6'); fs.mkdirSync(output, { recursive: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lottery-management-ui-'));
  const campaign = { ...structuredClone(baseline.campaign), enabled: false, startsAt: Date.now() - 1000, endsAt: Date.now() + 86400000, redeemEndsAt: Date.now() + 86400000, redemptionEndsAt: undefined };
  const prizes = baseline.prizes;
  let tables = new Map(), queue = Promise.resolve();
  const store = { transaction(fn) { const job = queue.then(async () => { const copy = structuredClone(tables); const result = await fn({ get: async (table, id) => structuredClone(copy.get(table + ':' + id)), set: async (table, id, value) => copy.set(table + ':' + id, structuredClone(value)) }); tables = copy; return result; }); queue = job.catch(() => {}); return job; } };
  const draw = createDraw({ store, campaign, prizes, now: Date.now, entryId: id => id, adminIds: ['admin'] });
  await draw('initializePool', {}, 'admin'); campaign.enabled = true;
  const key = crypto.randomBytes(32).toString('hex');
  const centerConfig = { baseUrl: 'https://coupon-fixture.invalid', centerId: 'qa-center', adminToken: crypto.randomBytes(32).toString('hex'), prizes: Object.fromEntries(prizes.map(p => [p.id, p.id])) };
  const campaigns = prizes.map(p => ({ id: p.id, kind: p.kind, amountCents: p.amount ? p.amount * 100 : 0, physical: p.kind === 'physical' ? { prizeId: p.id, quantity: 1 } : undefined,
    startsAt: new Date(campaign.startsAt).toISOString(), expiresAt: new Date(campaign.redeemEndsAt).toISOString(), quota: campaign.inventory.quantities[p.id], issued: 0, enabled: true }));
  const handler = createManagementHttp({ store, campaign, prizes, key, centerConfig, fetchFn: async (url, options) => {
    assert.equal(new URL(url).origin, centerConfig.baseUrl);
    assert.equal(options.headers.Authorization, 'Bearer ' + centerConfig.adminToken);
    const route = new URL(url).pathname;
    let data;
    if (route === '/v1/info') data = { service: 'stall-coupon-center', centerId: centerConfig.centerId, environment: 'production', role: 'admin', capabilities: ['quota-increase-v1'] };
    else if (route === '/v1/campaigns') data = campaigns;
    else if (route === '/v1/coupons') data = { total: 0, items: [] };
    else if (route === '/v1/campaigns/quota') { const input = JSON.parse(options.body); data = campaigns.find(c => c.id === input.id); assert.ok(input.quota >= data.quota); data.quota = input.quota; }
    else throw new Error('Unexpected network route');
    return Response.json({ ok: true, data });
  } });
  let offline = false, writes = 0;
  const service = createService({ directory, fetchFn: async (url, options) => {
    assert.equal(url, 'https://management-fixture.invalid/lottery');
    if (offline) throw new Error('隔离测试：断网');
    if (JSON.parse(options.body).action !== 'snapshot') writes++;
    const result = await handler({ httpMethod: 'POST', headers: options.headers, body: options.body });
    return new Response(result.body, { status: result.statusCode, headers: result.headers });
  } });
  await service.dispatch('lottery-connect', { url: 'https://management-fixture.invalid/lottery', campaignId: campaign.id, key });
  const middleware = paymentMiddleware(service), root = path.resolve('dist');
  const server = http.createServer((req, res) => middleware(req, res, () => {
    const file = path.resolve(root, '.' + (req.url === '/' ? '/index.html' : req.url.split('?')[0]));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [], results = [];
  try {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 1024, height: 600 }, { width: 390, height: 844 }, { width: 320, height: 720 }]) {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      await context.route('**/*', route => route.request().url().startsWith(url) ? route.continue() : route.abort());
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      const loaded = async () => {
        await page.getByRole('button', { name: '刷新抽奖配置' }).waitFor();
        await page.waitForFunction(() => !document.querySelector('[aria-label="刷新抽奖配置"]')?.disabled);
      };
      const shot = async name => {
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Page horizontal overflow');
        const nav = await page.locator('.bottomNav').boundingBox(); assert.ok(Math.abs(nav.y + nav.height - viewport.height) < 1, 'Navigation not fixed');
        const labelsFit = await page.locator('.bottomNav button').evaluateAll(nodes => nodes.every(n => n.scrollWidth <= n.clientWidth)); assert.ok(labelsFit, 'Nav text clipped');
        await page.screenshot({ path: path.join(output, `${viewport.width}-${name}.png`) });
      };
      await page.goto(url); await page.getByRole('button', { name: '抽奖', exact: true }).click(); await loaded();
      if (viewport.width === 1280) {
        assert.ok(await page.getByRole('button', { name: '固定概率', exact: true }).isDisabled());
        assert.ok(await page.getByRole('button', { name: '暂停新抽奖', exact: true }).isDisabled());
        await page.getByLabel('调整原因', { exact: true }).fill('暂停后调整测试'); await page.locator('.lotteryConfirm input').check();
        await page.getByRole('button', { name: '暂停新抽奖', exact: true }).click(); await loaded();
        await page.getByRole('button', { name: '固定概率', exact: true }).click();
        await page.getByLabel('棒球帽固定概率', { exact: true }).fill('1.25');
        await page.getByLabel('调整原因', { exact: true }).fill('测试固定概率'); await page.locator('.lotteryConfirm input').check();
        assert.ok(await page.getByRole('button', { name: '保存配置', exact: true }).isDisabled());
        await page.getByLabel('5元立减金固定概率', { exact: true }).fill('20.75');
        assert.ok(!await page.locator('.lotteryConfirm input').isChecked()); await page.locator('.lotteryConfirm input').check();
        await page.getByRole('button', { name: '保存配置', exact: true }).click(); await loaded();
        await page.getByText('配置已保存，活动仍暂停', { exact: true }).waitFor();
        await page.getByRole('button', { name: '增加棒球帽券发放上限', exact: true }).click();
        const modal = page.getByRole('dialog', { name: '补充券发放上限' });
        await modal.getByLabel('新上限', { exact: true }).fill('12'); await modal.getByLabel('原因', { exact: true }).fill('增加两份测试'); await modal.getByRole('button', { name: '确认补充' }).click(); await modal.waitFor({ state: 'hidden' }); await loaded();
        await page.getByLabel('棒球帽总名额', { exact: true }).fill('12'); await page.getByLabel('调整原因', { exact: true }).fill('对应新增两份测试'); await page.locator('.lotteryConfirm input').check(); await page.getByRole('button', { name: '保存配置', exact: true }).click(); await loaded();
        await page.getByLabel('调整原因', { exact: true }).fill('恢复测试'); await page.locator('.lotteryConfirm input').check(); await page.getByRole('button', { name: '恢复新抽奖', exact: true }).click(); await loaded();
        assert.equal((await service.dispatch('lottery-snapshot')).prizes.find(p => p.id === 'cap').quota, 12);
        offline = true; await page.getByRole('button', { name: '刷新抽奖配置' }).click(); await loaded(); await page.getByRole('alert').waitFor(); offline = false;
        await page.getByRole('button', { name: '刷新抽奖配置' }).click(); await loaded();
        await page.getByRole('alert').waitFor({ state: 'hidden' });
        await page.getByText('允许新抽奖', { exact: true }).waitFor();
      }
      await page.locator('.lotteryManager').scrollIntoViewIfNeeded(); await shot('overview');
      await page.getByRole('button', { name: '云端连接', exact: true }).click(); await shot('connection');
      assert.equal(await page.locator('input[name="key"]').inputValue(), '');
      await page.getByRole('button', { name: '关闭抽奖连接' }).click();
      results.push({ ...viewport, passed: true }); await context.close();
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ results, errors, writes, realNetwork: false, productionMutations: 0 }, null, 2));
    console.log(JSON.stringify({ passed: results.length, writes, realNetwork: false, errors }));
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); service.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
