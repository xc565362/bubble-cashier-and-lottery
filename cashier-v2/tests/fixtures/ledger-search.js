import { priceOrder } from '../../src/orderLogic.js';
import { adjustmentPlan } from '../../src/afterSales.js';

export function searchOrders(day = '2026-09-28', refundDay = '2026-09-29') {
  const item = { id: 'cap', name: '户外棒球帽（砾石灰）', sku: 'BB250005', barcode: '001Abc-005', group: '帽子', productType: 'sale', price: 100, qty: 1, discount: 0, stock: 10 };
  const gift = { id: 'gift', name: '测试赠品', sku: 'GIFT01', barcode: 'GIFT-001', productType: 'gift', price: 0, qty: 1, stock: 5 };
  const coupon = { id: 'coupon', name: '5元立减券', barcode: 'LJC1_TEST123', productType: 'coupon', price: 0, qty: 1, couponAmount: 5 };
  const order = { id: 'search-original', orderNo: 'POS-SEARCH-001', method: '收钱吧', createdAt: `${day}T09:00:00+08:00`, paidAt: `${day}T09:00:30+08:00`,
    status: '已收款', ...priceOrder([item, gift, coupon]), payment: { provider: 'sqb', mode: 'test', orderSn: 'SQB-SEARCH-001', tenders: [
      { tenderSn: 'TENDER-ORIGINAL', internalTransactionSn: 'SERIAL-ORIGINAL', channelSn: 'WX-ORIGINAL', subTenderType: 301, payStatus: 3,
        amount: 9500, paidAmount: 9500, collectedAmount: 9500, payTime: `${day}T09:00:30+08:00` }
    ] } };
  const plan = adjustmentPlan(order, { id: 'return-search', type: 'return', reason: '尺码不合适', returns: [{ lineId: `${order.id}:0`, qty: 1, restockQty: 1 }] });
  order.afterSales = [{ id: plan.id, plan, completedAt: `${refundDay}T10:00:00+08:00`, orderSn: 'SQB-REFUND-001', tenders: [
    { tenderSn: 'TENDER-REFUND', internalTransactionSn: 'SERIAL-REFUND', channelSn: 'WX-REFUND', subTenderType: 301, payStatus: 5,
      amount: -9500, paidAmount: -9500, collectedAmount: -9500, payTime: `${refundDay}T10:00:00+08:00` }
  ] }];
  order.updatedAt = order.afterSales[0].completedAt;
  const second = { id: 'search-other', orderNo: 'POS-SEARCH-002', createdAt: `${day}T11:00:00+08:00`, method: '收款码', status: '已收款',
    ...priceOrder([{ ...item, id: 'bag', name: '运动腰包', sku: 'BB240011', barcode: '001Abc-011', group: '腰包', price: 120 }]) };
  const physical = { id: 'search-physical', orderNo: 'POS-PRIZE', createdAt: `${day}T12:00:00+08:00`, method: '零元结算', status: '已收款', physicalFulfilled: true,
    ...priceOrder([{ ...gift, name: '超大编织袋', discount: 0, lineKey: 'lottery-gift:AWARD-TEST-001', externalCoupon: { kind: 'physical', couponId: 'AWARD-TEST-001' } }]) };
  const cancelled = { id: 'search-cancelled', orderNo: 'POS-CANCELLED', createdAt: `${day}T13:00:00+08:00`, method: '收款码', status: '已取消',
    ...priceOrder([{ ...item, name: '取消订单测试商品' }]), total: 0 };
  return [order, second, physical, cancelled];
}
