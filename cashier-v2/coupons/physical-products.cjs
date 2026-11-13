const selectors = Object.freeze({cap: {code:'BB250005',name:'户外棒球帽（砾石灰）'}, bucket:{code:'BB250003',name:'户外渔夫帽（晨雾蓝）'}, waist:{code:'BB240011',name:'轻量化运动腰包（海雾蓝）'}, tote:{code:'BB260057',name:'超大编织袋'}});
const {productSnapshot} = require('./catalog-contract.cjs');
function resolveCatalogProduct(reference, products) {
  const source = productSnapshot(reference);
  if (!Array.isArray(products) || !products.length) throw new Error('请先读取当前电脑的商品目录，再扫描实物奖品');
  const codes = [...new Set([source.sku, source.barcode].filter(Boolean))];
  const matches = products.filter(product => product && codes.some(code => [product.sku, product.barcode].some(value => String(value || '').trim() === code)));
  const ids = new Set(matches.map(product => product.id));
  if (!matches.length) throw new Error(`未找到${source.name}对应商品，请核对当前电脑的货品编码或条码`);
  if (ids.size !== 1 || matches.some(product => JSON.stringify(product) !== JSON.stringify(matches[0]))) throw new Error('奖品编码匹配到多个或相互冲突的商品，请先核对商品目录');
  const product = matches[0];
  if (typeof product.id !== 'string' || !product.id || typeof product.name !== 'string' || !product.name.trim() || !['sale', 'gift', undefined].includes(product.productType)) throw new Error('绑定商品类型或名称不正确');
  if (!Number.isFinite(Number(product.stock)) || Number(product.stock) < 1) throw new Error(`${product.name}库存不足`);
  if (!Number.isFinite(Number(product.price)) || Number(product.price) < 0) throw new Error('商品售价不正确');
  return structuredClone(product);
}
function resolvePhysicalProduct(prizeId, products) {
  const selector = selectors[prizeId];
  if (!selector || !Array.isArray(products)) throw new Error('实物奖品商品绑定不正确');
  const matches = products.filter(p => selector.code ? [p.sku,p.barcode].some(v => String(v || '').trim() === selector.code) : (selector.names || [selector.name]).includes(String(p.name || '').trim()));
  const ids = new Set(matches.map(p => p.id));
  if (!ids.size) throw new Error(`未找到${selector.name}对应商品，请先在商品管理中维护`);
  if (ids.size !== 1 || matches.some(p => JSON.stringify(p) !== JSON.stringify(matches[0]))) throw new Error(`${selector.name}匹配到多个商品，请核对编码或名称`);
  const product = matches[0];
  if (typeof product.id !== 'string' || !product.id || !['sale','gift',undefined].includes(product.productType)) throw new Error('绑定商品类型不正确');
  if (!Number.isFinite(Number(product.stock)) || Number(product.stock) < 1) throw new Error(`${selector.name}库存不足`);
  if (!Number.isFinite(Number(product.price)) || Number(product.price) < 0) throw new Error('商品售价不正确');
  return structuredClone(product);
}
function validatePhysicalLine(line, binding) {
  const entitlement = line?.externalCoupon;
  if (!binding?.product || entitlement?.kind !== 'physical' || entitlement.prizeId !== binding.prizeId || !entitlement.couponId) throw new Error('实物奖品绑定或券信息不正确，请重新扫码');
  const product = binding.product;
  if (line.id !== product.id || (line.sku || '') !== (product.sku || '') || (line.barcode || '') !== (product.barcode || '') || line.name !== product.name ||
      line.qty !== 1 || line.price !== 0 || line.discount !== 0 || line.productType !== 'gift' || line.lineKey !== `lottery-gift:${entitlement.couponId}`) throw new Error('实物奖品商品、数量或金额已被修改，请重新扫码');
}
module.exports = {selectors,resolvePhysicalProduct,resolveCatalogProduct,validatePhysicalLine};
