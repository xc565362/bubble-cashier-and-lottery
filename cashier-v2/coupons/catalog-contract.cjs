'use strict';
const invalid = message => Object.assign(new Error(message), {code: 'INVALID_INPUT', status: 400});
const legacyPrizeIds = new Set(['cap', 'bucket', 'waist', 'tote']);
function safePrizeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)) throw invalid('奖项编号须为 1 至 80 位字母、数字、下划线或连字符');
  return value;
}
function field(value, name, optional = false) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) throw invalid(`${name}不正确`);
  return value.trim();
}
function productSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('实物奖品缺少对应商品');
  const result = {id: field(value.id, '商品编号'), name: field(value.name, '商品名称'), sku: field(value.sku, '货品编码', true), barcode: field(value.barcode, '商品条码', true)};
  if (!result.sku && !result.barcode) throw invalid('实物商品至少需要唯一的货品编码或条码，不能只使用本机商品编号');
  return result;
}
function physicalSnapshot(value) {
  if (!value || value.quantity !== 1) throw invalid('实物奖品必须是指定商品一件');
  const prizeId = safePrizeId(value.prizeId);
  if (value.product != null) return {prizeId, quantity: 1, product: productSnapshot(value.product)};
  if (!legacyPrizeIds.has(prizeId)) throw invalid('新增实物奖项必须绑定有唯一货品编码或条码的商品');
  return {prizeId, quantity: 1};
}
module.exports = {safePrizeId, productSnapshot, physicalSnapshot};
