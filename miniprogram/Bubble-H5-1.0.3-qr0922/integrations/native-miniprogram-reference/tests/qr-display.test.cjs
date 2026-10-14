const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const cashierRequire = createRequire(path.resolve(root, '../../cashier-system-sqb/package.json'));
const { MultiFormatReader, RGBLuminanceSource, HybridBinarizer, BinaryBitmap, DecodeHintType, BarcodeFormat } = cashierRequire('@zxing/library');
const cashCode = 'LJC1_0123456789ABCDEF0123456789ABCDEF';
const physicalCode = 'A0123456789BCDEF';

class PixelCanvas {
  constructor() { this._width = 0; this._height = 0; this.rectangles = []; }
  get width() { return this._width; }
  set width(value) { this._width = value; this.reset(); }
  get height() { return this._height; }
  set height(value) { this._height = value; this.reset(); }
  reset() { this.pixels = new Uint8ClampedArray(this._width * this._height); this.rectangles = []; }
  getContext() {
    const canvas = this;
    return { fillStyle: '#000', fillRect(x, y, width, height) {
      const color = this.fillStyle === '#fff' ? 255 : 0;
      canvas.rectangles.push({ x, y, width, height, color });
      for (let row = y; row < y + height; row++) canvas.pixels.fill(color, row * canvas.width + x, row * canvas.width + x + width);
    } };
  }
}

function component(code, width = 210, ratio = 3) {
  const file = path.join(root, 'miniprogram/components/qr-code/qr-code.js');
  let definition;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: createRequire(file), Component: value => { definition = value; },
    wx: { getWindowInfo: () => ({ pixelRatio: ratio }) },
  }, { filename: file });
  const canvas = new PixelCanvas();
  const pending = [];
  const instance = {
    data: { ...definition.data, code }, ...definition.methods,
    setData(value) { Object.assign(this.data, value); },
    createSelectorQuery() {
      return { select() { return this; }, fields() { return this; }, exec(callback) { pending.push(callback); } };
    },
  };
  const flush = () => { while (pending.length) pending.shift()([{ node: canvas, width, height: width }]); };
  definition.lifetimes.ready.call(instance);
  flush();
  return { instance, definition, canvas, flush };
}

function decode(canvas) {
  return new MultiFormatReader().decode(
    new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(canvas.pixels, canvas.width, canvas.height))),
    new Map([[DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]]]),
  ).getText();
}

for (const code of [cashCode, physicalCode, cashCode.toLowerCase()]) {
  test(`QR preserves original ${code.length}-character token, including case`, () => {
    const { canvas, instance } = component(code);
    assert.equal(instance.data.error, '');
    assert.equal(decode(canvas), code);
    assert.ok(!decode(canvas).startsWith('bubble:'));
  });
}

test('QR decodes across phone sizes and pixel ratios, with integer cells and quiet margins', () => {
  for (const width of [179.2, 210, 240.8, 280]) for (const ratio of [1, 1.5, 2, 3]) {
    const { canvas } = component(cashCode, width, ratio);
    assert.equal(decode(canvas), cashCode);
    const black = canvas.rectangles.filter(rectangle => rectangle.color === 0);
    assert.ok(black.length > 0);
    for (const rectangle of black) {
      for (const value of [rectangle.x, rectangle.y, rectangle.width, rectangle.height]) assert.ok(Number.isInteger(value));
      assert.ok(rectangle.x >= rectangle.width * 4 && rectangle.y >= rectangle.height * 4);
      assert.ok(canvas.width - rectangle.x - rectangle.width >= rectangle.width * 4);
      assert.ok(canvas.height - rectangle.y - rectangle.height >= rectangle.height * 4);
    }
  }
});

test('clearing or invalidating a token clears the old QR before displaying an error', () => {
  const state = component(cashCode);
  for (const code of ['', 'bubble:' + cashCode, 'https://example.invalid/', 'incomplete']) {
    state.instance.data.code = code;
    state.instance.paint(); state.flush();
    assert.ok(state.canvas.pixels.every(value => value === 255));
    assert.equal(Boolean(state.instance.data.error), Boolean(code));
  }
});

test('deferred drawing uses the latest code and detached components do not draw', () => {
  const state = component(cashCode);
  state.instance.paint();
  state.instance.data.code = physicalCode;
  state.instance.paint(); state.flush();
  assert.equal(decode(state.canvas), physicalCode);
  const previous = state.canvas.pixels.slice();
  state.instance.paint();
  state.definition.lifetimes.detached.call(state.instance);
  state.instance.data.code = cashCode;
  state.flush();
  assert.deepEqual(state.canvas.pixels, previous);
});

test('missing canvas and canvas errors have a visible fallback', () => {
  const state = component(cashCode);
  state.instance.createSelectorQuery = () => ({ select() { return this; }, fields() { return this; }, exec(callback) { callback([]); } });
  state.instance.paint();
  assert.notEqual(state.instance.data.error, '');
  state.instance.setData({ error: '' });
  state.instance.onCanvasError();
  assert.notEqual(state.instance.data.error, '');
});

function prizePage() {
  const file = path.join(root, 'miniprogram/pages/prize/prize.js');
  let definition;
  let nextState;
  const calls = [];
  const copied = [];
  const api = { isDemo: true, async call(action) { calls.push(action); if (nextState instanceof Error) throw nextState; return nextState; } };
  const actualView = require(path.join(root, 'miniprogram/utils/view.js'));
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: name => name.endsWith('/api') ? api : actualView,
    Page: value => { definition = value; }, setTimeout: () => 1, clearTimeout() {},
    wx: { setClipboardData: value => copied.push(value.data), stopPullDownRefresh() {} },
  }, { filename: file });
  const page = { ...definition, data: { ...definition.data }, setData(value) { Object.assign(this.data, value); } };
  const state = (status = 'pending', checkoutCoupon = true, code = checkoutCoupon ? cashCode : physicalCode) => ({
    entry: { status, checkoutCoupon, code, prize: { kind: checkoutCoupon ? 'cash' : 'physical', name: 'Test award' }, createdAt: 1, expiresAt: 2 },
    campaign: { venue: 'Test venue', cashTerms: 'Test terms' },
  });
  return { page, calls, copied, state, next(value) { nextState = value; } };
}

test('prize page defaults to QR and polling preserves the selected barcode mode', async () => {
  const setup = prizePage(); setup.next(setup.state());
  await setup.page.onShow();
  assert.equal(setup.page.data.codeMode, 'qr');
  setup.page.changeCodeMode({ currentTarget: { dataset: { mode: 'barcode' } } });
  await setup.page.load(true);
  assert.equal(setup.page.data.codeMode, 'barcode');
  setup.page.changeCodeMode({ currentTarget: { dataset: { mode: 'url' } } });
  assert.equal(setup.page.data.codeMode, 'barcode');
  setup.page.onHide(); await setup.page.onShow();
  assert.equal(setup.page.data.codeMode, 'qr');
  assert.ok(setup.calls.every(action => action === 'state'));
});

test('only pending awards can switch modes or copy their unchanged token', async () => {
  const setup = prizePage(); setup.next(setup.state()); await setup.page.onShow();
  setup.page.copy(); assert.deepEqual(setup.copied, [cashCode]);
  for (const status of ['using', 'redeemed', 'voided', 'expired', 'unavailable', 'issuing', 'not_started']) {
    setup.next(setup.state(status)); await setup.page.load(true);
    setup.page.changeCodeMode({ currentTarget: { dataset: { mode: 'barcode' } } }); setup.page.copy();
    assert.equal(setup.page.data.codeMode, 'qr'); assert.equal(setup.copied.length, 1);
  }
  const wxml = fs.readFileSync(path.join(root, 'miniprogram/pages/prize/prize.wxml'), 'utf8');
  const pending = wxml.split('<block wx:if="{{entry.status===\'pending\'}}">')[1].split('</block>')[0];
  assert.ok(pending.includes('<qr-code') && pending.includes('<barcode'));
  assert.equal((wxml.match(/<qr-code/g) || []).length, 1);
  assert.equal((wxml.match(/<barcode/g) || []).length, 1);
});

test('network failure hides cash and physical codes and allows later recovery', async () => {
  for (const cash of [true, false]) {
    const setup = prizePage(); setup.next(setup.state('pending', cash)); await setup.page.onShow();
    setup.next(new Error('Offline')); await setup.page.load(true);
    assert.equal(setup.page.data.entry.status, 'unavailable');
    assert.equal(setup.page.data.entry.code, ''); assert.equal(setup.page.data.entry.formattedCode, '');
    setup.next(setup.state('pending', cash)); await setup.page.load(true);
    assert.equal(setup.page.data.entry.code, cash ? cashCode : physicalCode);
  }
});

test('display formatting supports unavailable physical awards without a token', () => {
  const view = require(path.join(root, 'miniprogram/utils/view.js'));
  for (const code of [undefined, '', null]) assert.equal(view.entry({ status: 'unavailable', code }).formattedCode, '');
});

test('delivery remains frontend-only and retains the original production identity', () => {
  const project = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json')));
  const settings = require(path.join(root, 'miniprogram/settings.js'));
  assert.equal(project.appid, 'wx3cfec968f30fb6c1');
  assert.equal(project.miniprogramRoot, 'miniprogram/');
  assert.equal(project.cloudfunctionRoot, undefined);
  assert.equal(fs.existsSync(path.join(root, 'cloudfunctions')), false);
  assert.equal(settings.mode, 'cloud');
  assert.equal(settings.cloudEnv, 'bubble-lottery-500-d8cd9c6a45992');
});

test('the decoded QR is recognized by the existing cashier coupon route', async () => {
  const { shouldReserveAward, isShortCouponCode } = await import(pathToFileURL(path.resolve(root, '../../cashier-system-sqb/src/couponBarcode.js')));
  const token = decode(component(cashCode).canvas);
  assert.equal(isShortCouponCode(token), true);
  assert.equal(shouldReserveAward(token, []), true);
  assert.equal(shouldReserveAward('bubble:' + token, []), false);
});
