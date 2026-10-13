const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createService } = require('../payments/service.cjs');
const { paymentMiddleware } = require('../payments/http.cjs');

async function main() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lottery-ui-'));
  const service = createService({ directory, fetchFn: async () => { throw new Error('No external network permitted in UI QA'); } });
  const middleware = paymentMiddleware(service), root = path.resolve('dist');
  const server = http.createServer((req, res) => middleware(req, res, () => {
    const file = path.resolve(root, `.${req.url === '/' ? '/index.html' : req.url.split('?')[0]}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [], catalog = [['cap','BB250005','户外棒球帽（砾石灰）'],['bucket','BB250003','户外渔夫帽（晨雾蓝）'],['waist','BB240011','轻量化运动腰包（海雾蓝）'],['tote','BB260057','超大编织袋']]
    .map(([id,sku,name]) => ({ id,sku,name,barcode:sku,price:100,originalPrice:100,stock:2,productType:'sale',group:'抽奖商品' }));
  const otherBag = {id:'other-bag',sku:'BB112233',barcode:'BB112233',name:'超大号购物袋',price:0,originalPrice:0,stock:100,productType:'gift',group:'抽奖商品'};
  const call = (action, payload = {}) => service.dispatch(`coupon-${action}`, { requestId: crypto.randomUUID(), ...payload });
  fs.mkdirSync('output/playwright/lottery-0.7.5', { recursive: true });
  try {
    for (const viewport of [{ width:1280,height:800 }, { width:390,height:844 }, { width:1024,height:600 }]) {
      const context = await browser.newContext({ viewport, serviceWorkers:'block' });
      await context.addInitScript(products => localStorage.setItem('stall_cashier_ledger_v2', localStorage.getItem('stall_cashier_ledger_v2') || JSON.stringify({ products,orders:[],heldCarts:[] })), [...catalog,otherBag]);
      await context.route('**/*', route => route.request().url().startsWith(url) ? route.continue() : route.abort());
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      const shot = async name => {
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Horizontal overflow');
        const nav = await page.locator('.bottomNav').boundingBox();
        assert.ok(Math.abs(nav.y + nav.height - viewport.height) < 1, 'Bottom navigation moved');
        await page.screenshot({ path:`output/playwright/lottery-0.7.5/${viewport.width}-${name}.png` });
      };
      await page.goto(url);
      await page.getByRole('button', { name:'券管理',exact:true }).click();
      await page.getByText('正在读取券数据', { exact:true }).waitFor({ state:'hidden' });
      await page.getByRole('tab', { name:'实物商品绑定',exact:true }).click();
      await page.getByRole('button', { name:'确认四种奖品商品绑定',exact:true }).click();
      await page.getByText('已绑定：户外棒球帽（砾石灰）', { exact:true }).waitFor();
      await page.getByText('已绑定：超大编织袋', { exact:true }).waitFor();
      await page.getByText('正在读取券数据', { exact:true }).waitFor({ state:'hidden' });
      await shot('bindings');
      await page.getByRole('button', { name:'收银',exact:true }).click();
      for (const [index, product] of catalog.entries()) {
        const campaign = await call('create-campaign', { name:product.name,kind:'physical',physical:{ prizeId:product.id,quantity:1 },amountCents:0,minimumCents:0,quota:10,
          startsAt:new Date(Date.now()-10000).toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString() });
        const coupon = await call('issue', { campaignId:campaign.id,owner:'qa',awardId:crypto.randomUUID(),trustedCode:(viewport.width * 10 + index).toString(16).padStart(16,'0').toUpperCase() });
        if (index === 0) await page.getByRole('button', { name:/^售卖品 户外棒球帽/ }).click();
        const scan = page.getByPlaceholder('商品 / 优惠券条码', { exact:true });
        await scan.fill(coupon.code); await scan.press('Enter');
        await page.getByText('抽奖赠品 · 免费', { exact:true }).waitFor();
        await page.getByRole('dialog', { name:'券状态处理' }).waitFor({ state:'hidden' });
        const gift = page.locator('.cartItem').filter({ hasText:'抽奖赠品 · 免费' });
        assert.ok(await gift.getByRole('button', { name:'增加数量',exact:true }).isDisabled());
        assert.ok(await gift.locator('input').isDisabled());
        if (index === 0) {
          const paid = page.locator('.cartItem').filter({ hasNotText:'抽奖赠品 · 免费' });
          assert.ok(await paid.getByRole('button', { name:'增加数量',exact:true }).isDisabled(), 'Sale and award must share stock');
          await shot('mixed-cart');
          await paid.getByRole('button', { name:'减少数量',exact:true }).click();
        }
        await page.getByRole('button', { name:'零元结算',exact:true }).click();
        if (index === 0) await shot('zero-confirm');
        await page.getByRole('button', { name:'确认零元结算',exact:true }).click();
        await page.getByRole('button', { name:'确认零元结算',exact:true }).waitFor({ state:'hidden' });
        await page.getByRole('dialog', { name:'券状态处理' }).waitFor({ state:'hidden' });
        assert.equal((await call('coupon', { id:coupon.id })).state,'REDEEMED');
        const ledger = await page.evaluate(() => JSON.parse(localStorage.getItem('stall_cashier_ledger_v2')));
        assert.equal(ledger.orders.length,index+1);
        assert.equal(ledger.products.find(p => p.id === product.id).stock,1);
        assert.equal(ledger.products.find(p => p.id === product.id).price,100);
        assert.equal(ledger.orders[0].physicalFulfilled,true);
        await scan.fill(coupon.code); await scan.press('Enter');
        await page.getByText('券已使用、已过期或被其他订单占用', { exact:true }).waitFor();
        assert.equal(await page.locator('.cartItem').count(),0);
      }
      await page.reload();
      await page.getByRole('button', { name:'流水',exact:true }).click();
      await shot('orders');
      const ledger = await page.evaluate(() => JSON.parse(localStorage.getItem('stall_cashier_ledger_v2')));
      assert.equal(ledger.orders.length,4); assert.ok(ledger.products.filter(p => p.id !== otherBag.id).every(p => p.stock === 1));
      assert.equal(ledger.products.find(p => p.id === otherBag.id).stock,100);
      await context.close();
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok:true,viewports:3,physicalRedemptions:12,realNetwork:false,errors }));
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); service.close(); fs.rmSync(directory,{ recursive:true,force:true }); }
}
main().catch(error => { console.error(error); process.exitCode=1; });
