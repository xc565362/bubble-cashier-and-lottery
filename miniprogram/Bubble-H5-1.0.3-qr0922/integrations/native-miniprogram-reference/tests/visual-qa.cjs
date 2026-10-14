const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const runtime = 'C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const { chromium } = require(path.join(runtime, 'playwright'));
const cashierRequire = createRequire(path.resolve(root, '../../cashier-system-sqb/package.json'));
const { MultiFormatReader, RGBLuminanceSource, HybridBinarizer, BinaryBitmap, DecodeHintType, BarcodeFormat } = cashierRequire('@zxing/library');
const read = relative => fs.readFileSync(path.join(root, 'miniprogram', relative), 'utf8');
const components = {};
for (const name of ['brand-header', 'prize-art', 'bottom-nav', 'barcode', 'qr-code']) {
  components[name] = { wxml: read(`components/${name}/${name}.wxml`), css: read(`components/${name}/${name}.wxss`), js: read(`components/${name}/${name}.js`) };
}
const bundle = {
  wxml: read('pages/prize/prize.wxml'), page: read('pages/prize/prize.js'), view: read('utils/view.js'),
  css: read('app.wxss') + read('pages/prize/prize.wxss'), components,
  qrcode: read('lib/qrcode.js'), jsbarcode: read('lib/jsbarcode.js'), barcode: read('lib/barcode.js'),
  assets: Object.fromEntries(fs.readdirSync(path.join(root, 'miniprogram/assets')).map(name => [name, 'data:image/svg+xml;base64,' + Buffer.from(read('assets/' + name)).toString('base64')])),
};

// Render the actual WXML/WXSS with isolated wx API stubs, not a second design implementation.
// This checks browser layout and canvas pixels; it does not replace WeChat device acceptance.
function fixture(bundle) {
  const parseModule = (source, dependencies = {}) => {
    const module = { exports: {} };
    new Function('module', 'exports', 'require', source)(module, module.exports, name => {
      if (!(name in dependencies)) throw new Error('Unexpected dependency: ' + name);
      return dependencies[name];
    });
    return module.exports;
  };
  const qrcode = parseModule(bundle.qrcode);
  const jsbarcode = parseModule(bundle.jsbarcode);
  const barcode = parseModule(bundle.barcode, { './jsbarcode': jsbarcode });
  const view = parseModule(bundle.view);
  const definitions = {};
  const wx = { getWindowInfo: () => ({ pixelRatio: window.devicePixelRatio }), setClipboardData: value => { window.copied = value.data; }, stopPullDownRefresh() {}, redirectTo() {} };
  for (const [name, component] of Object.entries(bundle.components)) {
    new Function('Component', 'require', 'wx', component.js)(definition => { definitions[name] = definition; }, name => {
      if (name === '../../lib/qrcode') return qrcode;
      if (name === '../../lib/barcode') return barcode;
      if (name === '../../utils/api') return { isDemo: true };
      throw new Error('Unexpected component dependency: ' + name);
    }, wx);
  }
  const expression = (text, data) => new Function('data', 'with(data){return (' + text + ')}')(data);
  const interpolate = (text, data) => text.replace(/{{([\s\S]*?)}}/g, (_, code) => String(expression(code, data) ?? ''));
  const attributes = (element, data) => Object.fromEntries(Array.from(element.attributes).map(attribute => [attribute.name, interpolate(attribute.value, data)]));
  let mounted = [];
  function render(source, data, owner, destination) {
    const xml = new DOMParser().parseFromString('<root xmlns:wx="urn:wx">' + source.replace(/\bwx:else(?=[\s>])/g, 'wx:else=""').replace(/\buser-select(?=[\s>])/g, 'user-select="true"') + '</root>', 'text/xml');
    if (xml.querySelector('parsererror')) throw new Error(xml.querySelector('parsererror').textContent);
    function children(parent, target) {
      let matched = false;
      for (const item of parent.childNodes) {
        if (item.nodeType === Node.TEXT_NODE) { target.append(document.createTextNode(interpolate(item.textContent, data))); continue; }
        if (item.nodeType !== Node.ELEMENT_NODE) continue;
        const raw = Object.fromEntries(Array.from(item.attributes).map(attribute => [attribute.name, attribute.value]));
        const condition = value => Boolean(expression(value.slice(2, -2), data));
        if ('wx:if' in raw) { matched = condition(raw['wx:if']); if (!matched) continue; }
        else if ('wx:elif' in raw) { if (matched) continue; matched = condition(raw['wx:elif']); if (!matched) continue; }
        else if ('wx:else' in raw) { if (matched) continue; matched = true; }
        else matched = false;
        if (item.nodeName === 'block') { children(item, target); continue; }
        const tag = ({ view: 'div', text: 'span', image: 'img' })[item.nodeName] || item.nodeName;
        const element = document.createElement(tag);
        const attrs = attributes(item, data);
        for (const [key, value] of Object.entries(attrs)) {
          if (key.startsWith('wx:') || key.startsWith('bind')) continue;
          element.setAttribute(key, key === 'src' && value.startsWith('/assets/') ? bundle.assets[value.slice(8)] : value);
        }
        if (raw.bindtap) element.addEventListener('click', () => owner[raw.bindtap]?.({ currentTarget: { dataset: { ...element.dataset } } }));
        target.append(element);
        if (definitions[item.nodeName]) {
          const definition = definitions[item.nodeName];
          const properties = {};
          for (const key of Object.keys(definition.properties || {})) {
            properties[key] = raw[key]?.startsWith('{{') ? expression(raw[key].slice(2, -2), data) : attrs[key];
          }
          const instance = {
            data: { ...definition.data, ...properties }, ...definition.methods,
            setData(value) {
              Object.assign(this.data, value);
              const error = element.querySelector('.qr-error');
              if (error) error.remove();
              if (this.data.error) { const error = document.createElement('div'); error.className = 'qr-error'; error.textContent = this.data.error; (element.querySelector('.qr-wrap') || element).append(error); }
            },
            createSelectorQuery() {
              let selector;
              return { select(value) { selector = value; return this; }, fields() { return this; }, exec(callback) {
                requestAnimationFrame(() => { const node = element.querySelector(selector); callback(node ? [{ node, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }] : []); });
              } };
            },
          };
          render(bundle.components[item.nodeName].wxml, instance.data, instance, element);
          mounted.push({ instance, definition });
        } else children(item, element);
      }
    }
    children(xml.documentElement, destination);
  }
  const code = 'LJC1_0123456789ABCDEF0123456789ABCDEF';
  window.qaState = {
    entry: { status: 'pending', code, checkoutCoupon: true, prize: { kind: 'cash', amount: 5, name: '5元立减金' }, createdAt: Date.now(), expiresAt: Date.now() + 86400000 },
    campaign: { venue: 'Bubble 活动展位', cashTerms: '每单限用一张，不可兑现。' },
  };
  const api = { isDemo: true, call: async action => { if (action !== 'state') throw new Error('Only state is allowed'); return window.qaState; } };
  let page;
  new Function('Page', 'require', 'wx', 'setTimeout', 'clearTimeout', bundle.page)(definition => {
    page = { ...definition, data: { ...definition.data }, setData(value) {
      Object.assign(this.data, value);
      for (const { instance, definition } of mounted) definition.lifetimes?.detached?.call(instance);
      mounted = [];
      const target = document.querySelector('main'); target.replaceChildren();
      render(bundle.wxml, this.data, this, target);
      for (const { instance, definition } of mounted) definition.lifetimes?.ready?.call(instance);
    } };
  }, name => name.endsWith('/api') ? api : view, wx, () => 1, () => {});
  window.fixturePage = page;
  window.fixtureStatus = async (status, physical = false) => {
    window.qaState.entry = { ...window.qaState.entry, status, checkoutCoupon: !physical,
      code: physical ? 'A0123456789BCDEF' : code,
      prize: physical ? { kind: 'physical', icon: 'cap', name: '户外棒球帽' } : { kind: 'cash', amount: 5, name: '5元立减金' },
    };
    await page.load(true);
  };
  page.onShow();
}

async function main() {
  const output = path.join(root, 'output/playwright'); fs.mkdirSync(output, { recursive: true });
  const css = bundle.css + Object.entries(components).map(([name, value]) => value.css.replace(/(^|})([^{}]+){/g, (_, end, selector) => end + selector.split(',').map(part => name + ' ' + part.trim()).join(',') + '{')).join('');
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Bubble 二维码版 · 隔离预览</title><style>body{margin:0}page,view,brand-header,prize-art,bottom-nav,qr-code,barcode{display:block}button{font-family:inherit;cursor:pointer;border:0}div,span,img{box-sizing:border-box}' +
    css.replace(/\bpage(?=[{\s])/g, 'body').replace(/(-?\d*\.?\d+)rpx/g, 'calc(var(--rpx) * $1)') + '</style><main></main><script>document.documentElement.style.setProperty("--rpx",innerWidth/750+"px");(' + fixture.toString() + ')(' + JSON.stringify(bundle).replace(/</g, '\\u003c') + ')</script></html>';
  fs.writeFileSync(path.join(output, 'preview.html'), html);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const report = { simulated: true, realWeChatRuntime: false, productionRequests: 0, viewports: [] };
  try {
    for (const [width, height, dpr] of [[320, 720, 2], [390, 844, 3], [430, 932, 3], [768, 1024, 2]]) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
      const page = await context.newPage(); const errors = [];
      page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
      await page.route('**/*', route => { report.productionRequests++; return route.abort(); });
      await page.setContent(html);
      await page.waitForSelector('qr-code canvas'); await page.waitForTimeout(100);
      assert.equal(await page.locator('.code-mode.active').textContent(), '二维码');
      const pixels = await page.locator('qr-code canvas').evaluate(canvas => ({ width: canvas.width, height: canvas.height, rgba: Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data) }));
      const gray = new Uint8ClampedArray(pixels.width * pixels.height);
      for (let index = 0; index < gray.length; index++) gray[index] = pixels.rgba[index * 4];
      const decoded = new MultiFormatReader().decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(gray, pixels.width, pixels.height))), new Map([[DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]]])).getText();
      assert.equal(decoded, 'LJC1_0123456789ABCDEF0123456789ABCDEF');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.locator('qr-code').evaluate(element => element.scrollIntoView({ block: 'center' }));
      const qrFrame = await page.locator('qr-code canvas').boundingBox();
      const navFrame = await page.locator('bottom-nav .nav').boundingBox();
      assert.ok(qrFrame.y >= 0 && qrFrame.y + qrFrame.height <= navFrame.y, `QR must remain fully above fixed navigation after scrolling: ${JSON.stringify({ width, qrFrame, navFrame })}`);
      await page.screenshot({ path: path.join(output, `scan-${width}-viewport.png`) });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: path.join(output, `prize-${width}-qr.png`), fullPage: true });
      await page.getByRole('button', { name: '条形码', exact: true }).click(); await page.waitForTimeout(100);
      assert.equal(await page.locator('qr-code').count(), 0);
      assert.equal(await page.locator('barcode canvas').count(), 1);
      await page.screenshot({ path: path.join(output, `prize-${width}-barcode.png`), fullPage: true });
      await page.getByRole('button', { name: '二维码', exact: true }).click(); await page.waitForTimeout(100);
      await page.locator('button.copy').click();
      assert.equal(await page.evaluate(() => window.copied), decoded);
      for (const status of ['using', 'redeemed', 'expired', 'voided', 'unavailable', 'issuing', 'not_started']) {
        await page.evaluate(status => window.fixtureStatus(status), status);
        assert.equal(await page.locator('qr-code, barcode, .code-modes, button.copy').count(), 0);
      }
      await page.screenshot({ path: path.join(output, `prize-${width}-unavailable.png`), fullPage: true });
      await page.evaluate(() => window.fixtureStatus('pending', true)); await page.waitForTimeout(100);
      assert.equal(await page.locator('qr-code canvas').count(), 1);
      assert.equal(await page.locator('prize-art img').evaluate(image => image.complete && image.naturalWidth > 0), true);
      await page.screenshot({ path: path.join(output, `prize-${width}-physical.png`), fullPage: true });
      assert.deepEqual(errors, []);
      report.viewports.push({ width, height, dpr, qrDecoded: true, switchAndCopyPassed: true, inactiveStatesHidden: true, physicalAssetRendered: true, errors });
      await context.close();
    }
  } finally { await browser.close(); }
  assert.equal(report.productionRequests, 0);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
