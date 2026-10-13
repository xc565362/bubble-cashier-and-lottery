import { completeSqbOrder, priceOrder } from './orderLogic.js';

export function completeBrowserPayment(ledger, record) {
  if (record.state === 'paid' && record.acknowledged && !ledger.orders.some(order => order.id === record.id)) {
    throw new Error('支付后台已确认过这笔收款，但当前浏览器没有对应订单。请回到原收银浏览器核对经营数据，不能在这里重复入账。');
  }
  try {
    return completeSqbOrder(ledger, record);
  } catch (error) {
    if (record.state !== 'paid') throw error;
    const missing = (ledger.pendingPayment?.draft.items || []).filter(item => !item.externalCoupon && !ledger.products.some(product => product.id === item.id));
    if (missing.length) throw new Error(`收款已确认，但当前浏览器的经营数据无法保存这笔订单：缺少原订单商品「${missing.map(item => item.name).join('、')}」。请回到原收银浏览器核对，勿重新添加商品或重复收款。`);
    throw new Error(`收款已确认，但当前浏览器的经营数据无法保存这笔订单：${error.message}。请核对原收银浏览器的商品和流水，勿重复收款。`);
  }
}

export function paymentReviewMessage(ledger, record) {
  try { completeBrowserPayment(ledger, record); }
  catch (error) { return error.message; }
  return '收款已确认，本浏览器的订单尚待核对保存。关闭弹窗不会取消付款，核对前不能继续收银。';
}

// Retain the original pending task and verified result; never acknowledge or change stock here.
export function retainPaymentReview(ledger, record, message, dismissed = false) {
  const pending = ledger.pendingPayment;
  const draft = pending?.draft;
  if (record?.state !== 'paid' || !record.orderSn || !draft || draft.id !== record.id
    || draft.orderNo !== record.identity?.check_sn || Math.round(priceOrder(draft.items).total * 100) !== record.amount) {
    throw new Error('待核对收款与当前订单不一致，请保留记录并联系维护人员');
  }
  return { ...ledger, pendingPayment: { ...pending, record,
    review: { message, dismissed: Boolean(dismissed) } } };
}

export const shouldOpenPayment = pending => Boolean(pending?.draft && !pending.review?.dismissed);
