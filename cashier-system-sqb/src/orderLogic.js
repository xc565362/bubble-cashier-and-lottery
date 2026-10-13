export const isCompleted = (order) => !['已取消', '待收款'].includes(order.status);
export const isCoupon = (item) => item.productType === 'coupon';
export const isExternalAward = (item) => !!item.externalCoupon;
export const isExternalPhysical = (item) => item.externalCoupon?.kind === 'physical';
export const basketLineKey = (item) => item.lineKey
  || (item.source === 'promo' && item.promoRuleId ? `promo-gift:${item.promoRuleId}:${item.id}`
    : item.productType === 'gift' ? `gift:${item.id}` : item.id);

export function paymentSerials(order) {
  return [...new Set((order.payment?.tenders || []).filter((item) => Number(item.payStatus) === 3)
    .map((item) => String(item.internalTransactionSn || '').trim()).filter(Boolean))];
}

export function orderSerial(order) {
  return order.payment?.provider === 'sqb' ? paymentSerials(order).join(' / ') : order.orderNo || order.id;
}

const cents = (value) => {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0) throw new Error('金额必须是有效的非负数');
  const result = Math.round(number * 100);
  if (!Number.isSafeInteger(result)) throw new Error('金额超过安全范围');
  return result;
};

export function priceOrder(items, zero = false) {
  if (!items.length) throw new Error('订单至少需要一个商品');
  if (items.filter(isExternalAward).length > 1) throw new Error('每单只能使用一份抽奖奖品');
  if (items.some(isExternalPhysical) && items.some(isCoupon)) throw new Error('实物奖品不能与其他优惠券叠加');
  if (zero && items.some(isExternalAward)) throw new Error('抽奖奖品请使用专用零元结算流程');
  if (items.filter(isCoupon).length > 1) throw new Error('每笔订单最多使用一张优惠券，请先移除原券');
  const lines = items.map((item) => {
    if (isExternalPhysical(item) && (item.qty !== 1 || item.price !== 0 || item.discount !== 0 || item.productType !== 'gift' || !item.externalCoupon.couponId || item.lineKey !== `lottery-gift:${item.externalCoupon.couponId}`)) throw new Error('抽奖赠品固定为一件免费商品，请重新扫码');
    const qty = Number(item.qty);
    if (!Number.isSafeInteger(qty) || qty <= 0) throw new Error(`${item.name} 数量必须是正整数`);
    if (isCoupon(item)) {
      if (qty !== 1) throw new Error('每笔订单最多使用一张优惠券');
      const face = cents(item.couponAmount);
      if (face <= 0) throw new Error('优惠券抵扣金额必须大于 0');
      return { ...item, qty: 1, price: 0, discount: 0, couponAmount: face / 100, couponDeduction: 0, lineTotal: 0 };
    }
    const unit = zero || item.productType === 'gift' ? 0 : cents(item.price);
    const discount = zero ? 0 : Math.min(cents(item.discount), unit * qty);
    return { ...item, qty, price: unit / 100, discount: discount / 100, lineTotal: (unit * qty - discount) / 100 };
  });
  const subtotal = lines.reduce((sum, item) => sum + cents(item.price) * item.qty, 0);
  const itemDiscount = lines.reduce((sum, item) => sum + cents(item.discount), 0);
  const coupon = lines.find(isCoupon);
  const meetsMinimum = !coupon?.externalCoupon || subtotal - itemDiscount >= coupon.minimumCents;
  const couponDiscount = !zero && coupon && meetsMinimum ? Math.min(cents(coupon.couponAmount), subtotal - itemDiscount) : 0;
  if (coupon) { coupon.couponDeduction = couponDiscount / 100; coupon.lineTotal = couponDiscount ? -couponDiscount / 100 : 0; }
  const discount = itemDiscount + couponDiscount;
  if (![subtotal, discount, subtotal - discount].every(Number.isSafeInteger)) throw new Error('订单金额超过安全范围');
  return { items: lines, subtotal: subtotal / 100, discount: discount / 100, couponDiscount: couponDiscount / 100, total: (subtotal - discount) / 100 };
}

// Return the original allocation before validating the entire replacement basket.
function validatePhysicalCatalog(item,product) {
  if(isExternalPhysical(item) && ['name','sku','barcode'].some(field=>String(item[field]??'').trim()!==String(product[field]??'').trim()))throw new Error('奖品商品资料与原绑定不一致，请移除兑奖商品后重新核对绑定');
}
export function reconcileStock(products, before = [], after = []) {
  const next = products.map((product) => ({ ...product }));
  if (after.length && after.every(isCoupon)) throw new Error('优惠券不能单独结账，请添加商品');
  for (const item of before) {
    if (isCoupon(item)) continue;
    let product = next.find((entry) => entry.id === item.id);
    if (!product) {
      if (isExternalPhysical(item)) throw new Error('奖品对应商品已删除，请先恢复原商品资料后再入库');
      const { qty, discount, lineTotal, source, promoRuleId, lineKey, catalogProduct, ...snapshot } = item;
      product = { ...snapshot, ...(source === 'promo' && catalogProduct ? catalogProduct : {}), stock: 0 };
      next.push(product);
    }
    validatePhysicalCatalog(item,product);
    product.stock = Number(product.stock || 0) + Number(item.qty);
  }
  for (const item of after) {
    if (isCoupon(item) && item.externalCoupon?.couponId && item.externalCoupon?.reservationId) continue;
    const product = next.find((entry) => entry.id === item.id);
    if (!product) throw new Error(`${item.name} 已删除，请移除或重新选择商品`);
    validatePhysicalCatalog(item,product);
    if (isCoupon(item) !== isCoupon(product)) throw new Error(`${item.name} 商品类型已变更，请重新选择`);
    if (isCoupon(item)) continue;
    if (!Number.isSafeInteger(Number(item.qty)) || Number(item.qty) <= 0) throw new Error('商品数量必须是正整数');
    if (!Number.isFinite(Number(product.stock)) || Number(product.stock) < Number(item.qty)) {
      throw new Error(`${item.name} 库存不足，请调整商品数量`);
    }
    product.stock = Number(product.stock) - Number(item.qty);
  }
  return next;
}

export function completeOrder(ledger, draft, now = new Date().toISOString()) {
  if (ledger.orders.some((order) => order.id === draft.id)) throw new Error('这笔订单已经处理，请勿重复确认');
  const priced = priceOrder(draft.items, draft.method === '0元出库');
  const order = { ...draft, ...priced, status: '已收款', createdAt: now, paidAt: now };
  return { ...ledger, products: reconcileStock(ledger.products, [], priced.items), orders: [order, ...ledger.orders] };
}

export function completeSqbOrder(ledger, record) {
  if (record.state !== 'paid' || !record.orderSn) throw new Error('收钱吧尚未确认付款成功');
  const existing = ledger.orders.find((order) => order.id === record.id);
  if (existing) {
    if (existing.payment?.orderSn !== record.orderSn) throw new Error('支付结果与已存订单不一致，请核对');
    return { ...ledger, pendingPayment: null };
  }
  const draft = ledger.pendingPayment?.draft;
  if (!draft || draft.id !== record.id || draft.orderNo !== record.identity.check_sn || Math.round(priceOrder(draft.items).total * 100) !== record.amount) throw new Error('支付结果与待收款订单不匹配');
  const payment = { provider: 'sqb', mode: record.mode || 'unknown', orderSn: record.orderSn, amount: record.amount, tenders: record.tenders, verifiedAt: record.updatedAt };
  const times = (record.tenders || []).map((item) => item.payTime).filter((value) => value && Number.isFinite(Date.parse(value)));
  const paidAt = times.sort((a, b) => Date.parse(b) - Date.parse(a))[0] || record.completedAt || record.updatedAt;
  const next = completeOrder(ledger, { ...draft, method: '收钱吧', payment }, paidAt);
  return { ...next, pendingPayment: null };
}

export function reviseOrder(ledger, id, items, cancel = false, now = new Date().toISOString()) {
  const original = ledger.orders.find((order) => order.id === id);
  if (!original || original.status === '已取消') throw new Error('订单不存在或已取消');
  if (original.payment?.provider === 'sqb') throw new Error('收钱吧订单请使用原路退换货，不能直接修改原收款');
  if (!cancel && original.items.some(item => item.externalCoupon)) throw new Error('中奖券零元订单不能直接改价，请取消原订单后重新开单；已核销券不会自动退回');
  if (!cancel && original.status === '待收款') throw new Error('请先处理旧版待收款订单');
  const priced = cancel ? { subtotal: 0, discount: 0, couponDiscount: 0, total: 0 } : priceOrder(items, original.method === '0元出库');
  const nextProducts = reconcileStock(ledger.products, original.items, cancel ? [] : priced.items);
  const { revisions, ...snapshot } = original;
  const order = {
    ...original, ...priced, status: cancel ? '已取消' : '已收款', updatedAt: now,
    revisions: [...(revisions || []), { action: cancel ? '取消订单' : '编辑换货', at: now, previous: snapshot }],
  };
  return { ...ledger, products: nextProducts, orders: ledger.orders.map((entry) => entry.id === id ? order : entry) };
}

export function suspendBasket(ledger, basket) {
  if (basket.items.some(item => item.externalCoupon)) throw new Error('请先移除中奖券再挂单，取单后可重新扫码');
  if (!basket.items.length) throw new Error('购物车还是空的');
  return { ...ledger, heldCarts: [basket, ...(ledger.heldCarts || [])] };
}

export function retrieveBasket(ledger, id, currentBasket) {
  if (currentBasket?.items.some(item => item.externalCoupon)) throw new Error('请先移除当前购物车的中奖券再取单');
  const basket = (ledger.heldCarts || []).find((entry) => entry.id === id);
  if (!basket) throw new Error('挂单不存在或已取出');
  const heldCarts = ledger.heldCarts.filter((entry) => entry.id !== id);
  if (currentBasket?.items.length) heldCarts.unshift(currentBasket);
  return { ledger: { ...ledger, heldCarts }, basket: {
    ...basket,
    items: basket.items.map((item) => ({ ...item, stock: ledger.products.find((product) => product.id === item.id)?.stock || 0 })),
  } };
}

export function orderExportRows(orders) {
  const header = ['流水号', '子订单号', '下单时间', '最后修改时间', '状态', '收款方式', '产品名称', '条码', '货品编码', '商品分组', '商品类型', '单价', '数量', '商品金额', '优惠金额', '实收金额', '有效销售数量', '本地订单号', '收钱吧轻POS订单号', '收钱吧流水号', '支付渠道', '支付源单号', '优惠券面额', '实物奖品发放数量', '关联奖品权益ID'];
  return [header, ...orders.flatMap((order) => order.items.map((item, index) => {
    const active = isCompleted(order);
    const coupon = isCoupon(item);
    const subtotal = coupon ? 0 : cents(item.price) * Number(item.qty);
    const discount = coupon ? cents(item.couponDeduction) : Math.min(cents(item.discount), subtotal);
    const localNo = order.orderNo || order.id;
    const tenders = (order.payment?.tenders || []).filter((entry) => Number(entry.payStatus) === 3);
    return [orderSerial(order), `${localNo}-${String(index + 1).padStart(3, '0')}`, order.createdAt, order.updatedAt || '', order.status || '已收款', order.method,
      item.name, item.barcode, item.sku, item.group, coupon ? '优惠券' : item.productType === 'gift' ? '赠品' : '售卖品', coupon ? 0 : item.price, item.qty,
      active ? subtotal / 100 : 0, active ? discount / 100 : 0, active ? (subtotal - discount) / 100 : 0, active && !coupon && item.productType !== 'gift' && !isExternalPhysical(item) ? item.qty : 0,
      localNo, order.payment?.orderSn || '', paymentSerials(order).join(' / '), tenders.map((entry) => entry.channel).filter(Boolean).join(' / '), tenders.map((entry) => entry.channelSn).filter(Boolean).join(' / '), coupon ? item.couponAmount : '', active && isExternalPhysical(item) ? item.qty : 0,item.externalCoupon?.couponId || ''];
  }))];
}
