import { basketLineKey, isCoupon, isExternalAward } from './orderLogic.js';

export const giftEligibility = value => ['true', '1', 'yes', '是', '可赠送', '可参与买赠'].includes(String(value ?? '').trim().toLowerCase());
export const canBePromoGift = product => product.productType === 'gift' || (product.productType === 'sale' && giftEligibility(product.giftEligible));

export function promoGiftLine(product, ruleId) {
  if (!canBePromoGift(product) || !ruleId) throw new Error('请先将商品设为赠品，或启用可参与买赠');
  return { ...product, productType: 'gift', price: 0, discount: 0, source: 'promo', promoRuleId: ruleId,
    lineKey: `promo-gift:${ruleId}:${product.id}`,
    catalogProduct: { productType: product.productType, price: product.price, giftEligible: canBePromoGift(product) } };
}

export function addLineToCart(current, product, qty = 1, meta = {}) {
  if (isCoupon(product)) {
    if (current.some(item => isCoupon(item) || isExternalAward(item))) return { next: current, added: false, reason: 'coupon-limit' };
    if (!Number.isFinite(Number(product.couponAmount)) || Number(product.couponAmount) <= 0) return { next: current, added: false, reason: 'coupon-invalid' };
    return { next: [...current, { ...product, price: 0, discount: 0, qty: 1, source: 'coupon' }], added: true, addedQty: 1 };
  }
  const key = basketLineKey(product);
  const stock = Number(product.stock || 0) - current.filter(item => item.id === product.id && basketLineKey(item) !== key).reduce((sum, item) => sum + Number(item.qty), 0);
  if (stock <= 0) return { next: current, added: false, reason: 'no-stock' };
  const existing = current.find(item => basketLineKey(item) === key);
  const wanted = Number(qty);
  if (!Number.isSafeInteger(wanted) || wanted <= 0) return { next: current, added: false, reason: 'invalid-qty' };
  const addedQty = Math.min(wanted, stock - Number(existing?.qty || 0));
  if (addedQty <= 0) return { next: current, added: false, reason: 'limit' };
  const nextQty = Number(existing?.qty || 0) + addedQty;
  const line = { ...existing, ...product, qty: nextQty,
    discount: product.productType === 'gift' ? 0 : Math.max(0, Math.min(Number(existing?.discount || 0), Number(product.price) * nextQty)),
    source: existing?.source || meta.source || product.source || product.productType,
    promoRuleId: existing?.promoRuleId || meta.promoRuleId || product.promoRuleId || '' };
  return { next: existing ? current.map(item => basketLineKey(item) === key ? line : item) : [...current, line], added: true, addedQty };
}
