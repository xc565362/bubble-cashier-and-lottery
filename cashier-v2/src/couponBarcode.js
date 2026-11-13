import JsBarcode from './vendor/jsbarcode.js';

export const isShortCouponCode = code => typeof code === 'string' && /^LJC1_[0-9A-F]{32}$/.test(code);
export const isAwardBarcode = code => isShortCouponCode(code) || typeof code === 'string' && /^[0-9A-F]{16}$/.test(code);
// The unprefixed legacy prize format must not take over an existing catalog barcode.
export const shouldReserveAward = (code,products=[]) => typeof code === 'string' && (code.startsWith('LJC1_') || /^[0-9A-Fa-f]{16}$/.test(code) && !products.some(product=>product.barcode===code));

export function couponBarcodeForDisplay(code, cssWidth, pixelRatio = 1) {
  if (!Number.isFinite(cssWidth) || cssWidth <= 0 || !Number.isFinite(pixelRatio) || pixelRatio <= 0) throw new Error('条形码尺寸无效');
  return couponBarcodeLayout(code, Math.floor(cssWidth * pixelRatio), Math.max(24, Math.floor(100 * pixelRatio)));
}

// Integer device-pixel bars with at least ten modules of quiet space on each side.
// Adapted from the bubble-lottery barcode layout; the token is never normalized.
export function couponBarcodeLayout(code, width = 924, height = 160) {
  if (!isAwardBarcode(code)) throw new Error('请输入完整的购物券码或实物奖品码');
  if (!Number.isFinite(width) || !Number.isFinite(height) || height < 24) throw new Error('条形码尺寸无效');
  const data = {};
  JsBarcode(data, code, { format: 'CODE128B', displayValue: false });
  const bits = data.encodings.map(item => item.data).join('');
  const moduleWidth = Math.floor(width / (bits.length + 20));
  if (moduleWidth < 1) throw new Error('条形码宽度不足，请使用复制券码');
  const pixels = Math.floor(width), top = 8, bottom = Math.floor(height) - 8;
  const offset = Math.floor((pixels - bits.length * moduleWidth) / 2);
  const bars = [];
  for (let i = 0; i < bits.length;) {
    if (bits[i] !== '1') { i++; continue; }
    const start = i;
    while (bits[i] === '1') i++;
    bars.push({ x: offset + start * moduleWidth, y: top, width: (i - start) * moduleWidth, height: bottom - top });
  }
  return { width: pixels, height: Math.floor(height), moduleWidth, bars };
}
