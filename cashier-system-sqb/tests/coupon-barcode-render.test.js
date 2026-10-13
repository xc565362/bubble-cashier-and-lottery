import test from 'node:test';
import {couponBarcodeLayout as physicalLayout} from '../src/couponBarcode.js';
test('physical legacy prize code renders without changing its sixteen characters',()=>{ const drawing=physicalLayout('AABBCCDDEEFF0011',600,120); if(!drawing.bars.length)throw new Error('Missing physical barcode'); });
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
const require = createRequire(import.meta.url);
const zxingRequire = createRequire(require.resolve('@zxing/browser'));
const { Code128Reader, BitArray } = zxingRequire('@zxing/library');
let barcode;
try { barcode = await import('../src/couponBarcode.js'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

test('complete short voucher secrets decode independently at phone pixel widths', () => {
  assert.equal(typeof barcode?.couponBarcodeLayout, 'function', 'coupon barcode renderer missing');
  for (const width of [624, 750, 900]) {
    for (let i = 0; i < 12; i++) {
      const code = `LJC1_${crypto.randomBytes(16).toString('hex').toUpperCase()}`;
      const drawing = barcode.couponBarcodeLayout(code, width, 160);
      const row = new BitArray(drawing.width);
      for (const bar of drawing.bars) for (let x = bar.x; x < bar.x + bar.width; x++) row.set(x);
      assert.equal(new Code128Reader().decodeRow(0, row).getText(), code);
      assert.ok(drawing.bars[0].x >= 10 * drawing.moduleWidth);
      const last = drawing.bars.at(-1);
      assert.ok(drawing.width - last.x - last.width >= 10 * drawing.moduleWidth);
    }
  }
});

test('legacy signed QR tokens are selected for QR fallback and malformed codes do not render bars', () => {
  assert.equal(typeof barcode?.isShortCouponCode, 'function', 'coupon barcode selector missing');
  assert.equal(barcode.isShortCouponCode('LJC1_' + 'A'.repeat(32)), true);
  assert.equal(barcode.isShortCouponCode('LJC1_' + 'a'.repeat(32) + '_' + 'b'.repeat(24)), false);
  for (const code of ['', null, 'LJC1_' + 'A'.repeat(31), '<svg onload=bad>', 'LJC1_' + 'a'.repeat(32)]) {
    assert.equal(barcode.isShortCouponCode(code), false);
    assert.throws(() => barcode.couponBarcodeLayout(code, 624, 160));
  }
  assert.throws(() => barcode.couponBarcodeLayout('LJC1_' + 'A'.repeat(32), 300, 160), /宽度/);
});

test('responsive sizing renders complete bars at the actual display pixel width', () => {
  const code = 'LJC1_0123456789ABCDEF0123456789ABCDEF';
  assert.equal(typeof barcode?.couponBarcodeForDisplay, 'function');
  for (const width of [568, 624, 686, 750]) {
    const drawing = barcode.couponBarcodeForDisplay(code, width / 2, 2);
    assert.equal(drawing.width, width);
    const row = new BitArray(width);
    for (let x = 0; x < width; x++) {
      const sourceX = (x + 0.5) * drawing.width / width;
      if (drawing.bars.some(bar => sourceX >= bar.x && sourceX < bar.x + bar.width)) row.set(x);
    }
    assert.equal(new Code128Reader().decodeRow(0, row).getText(), code);
  }
  assert.throws(() => barcode.couponBarcodeForDisplay(code, 300, 1), /宽度/);
});
test('known sixteen-character product barcodes keep ordinary product routing',()=>{
  assert.equal(typeof barcode.shouldReserveAward,'function');
  const products=[{id:'normal',barcode:'1234567890123456'},{id:'hex',barcode:'AABBCCDDEEFF0011'}];
  assert.equal(barcode.shouldReserveAward('1234567890123456',products),false);
  assert.equal(barcode.shouldReserveAward('AABBCCDDEEFF0011',products),false);
  assert.equal(barcode.shouldReserveAward('AABBCCDDEEFF0022',products),true);
  assert.equal(barcode.shouldReserveAward('BB250005',products),false);
  assert.equal(barcode.shouldReserveAward('LJC1_'+'A'.repeat(32),products),true);
});
