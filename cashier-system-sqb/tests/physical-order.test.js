import test from 'node:test';
import assert from 'node:assert/strict';
import * as order from '../src/orderLogic.js';
import {adjustmentPlan,remainingLines,applyAdjustment,financialExportRows} from '../src/afterSales.js';
const product={id:'cap-1',sku:'BB250005',barcode:'BB250005',name:'棒球帽',productType:'sale',price:100,stock:2};
const gift={...product,qty:1,price:0,discount:0,productType:'gift',lineKey:'lottery-gift:right-1',externalCoupon:{kind:'physical',couponId:'right-1',reservationId:'res-1',centerId:'center-1',prizeId:'cap'}};
test('same SKU gift and paid line have distinct basket identity and shared stock; gift counts only as fulfilment',()=>{
  assert.notEqual(order.basketLineKey(product),order.basketLineKey(gift));
  const draft={id:'order-1',orderNo:'ORDER1',method:'收钱吧',items:[{...product,qty:1},gift]};
  const paid=order.completeOrder({products:[product],orders:[]},draft);
  assert.equal(paid.orders[0].total,100);assert.equal(paid.products[0].stock,0);assert.equal(paid.products[0].price,100);
  const rows=order.orderExportRows(paid.orders);assert.equal(rows[2][16],0);assert.equal(rows[1][16],1);
  assert.equal(rows[2][rows[0].indexOf('实物奖品发放数量')],1);
  assert.equal(rows[2][rows[0].indexOf('关联奖品权益ID')],'right-1');
  assert.throws(()=>order.completeOrder(paid,draft));assert.throws(()=>order.completeOrder({products:[{...product,stock:1}],orders:[]},draft),/库存/);
});
test('gift integrity, one entitlement, and coupon stacking checked before pricing',()=>{
  for(const patch of [{qty:2},{price:100},{discount:1},{productType:'sale'},{lineKey:'bad'}]) assert.throws(()=>order.priceOrder([{...gift,...patch}]));
  assert.throws(()=>order.priceOrder([gift,{...gift}]),/一/);
  assert.throws(()=>order.priceOrder([gift,{id:'cash',productType:'coupon',couponAmount:5,qty:1}]),/叠加/);
  assert.throws(()=>order.priceOrder([gift],true),/零元/);
});
test('physical return has zero refund; deleted product cannot be recreated with free-sale data or reused in exchanges',()=>{
  const original=order.completeOrder({products:[product],orders:[]},{id:'o',items:[gift],method:'零元结算'}).orders[0];
  const line=remainingLines(original)[0];assert.equal(line.remainingCents,0);
  const plan=adjustmentPlan(original,{id:'return1',type:'return',returns:[{lineId:line.lineId,qty:1,restockQty:1}]});
  assert.equal(plan.refundCents,0);assert.equal(plan.deltaCents,0);
  assert.throws(()=>order.reconcileStock([], [gift], []),/商品/);
  assert.throws(()=>adjustmentPlan(original,{id:'exchange1',type:'exchange',returns:[{lineId:line.lineId,qty:1,restockQty:1}],newItems:[gift]}),/奖品|权益/);
});
test('changed current catalog identity rejects physical allocation and physical restocking',()=>{
  for(const patch of [{sku:'OTHER'},{barcode:'OTHER'},{name:'Another product'}]){
    assert.throws(()=>order.reconcileStock([{...product,...patch}],[],[gift]),/绑定|身份|资料/);
    assert.throws(()=>order.reconcileStock([{...product,...patch}],[gift],[]),/绑定|身份|资料/);
  }
  assert.equal(order.reconcileStock([{...product,price:120}],[],[gift])[0].stock,1);
});
test('financial export aligns all return columns and never counts returned prize as negative sales',()=>{
  for(const physical of [true,false]){
    const paid=order.completeOrder({products:[product],orders:[]},{id:'export',orderNo:'EXPORT',createdAt:'2026-09-21T00:00:00Z',items:[physical?gift:{...product,qty:1}],method:'零元结算'});
    const line=remainingLines(paid.orders[0])[0],plan=adjustmentPlan(paid.orders[0],{id:'return-export',type:'return',returns:[{lineId:line.lineId,qty:1,restockQty:1}]});
    const returned=applyAdjustment(paid,{id:plan.id,parentId:'export',plan,kind:physical?'zero':'refund',state:physical?'completed':'refunded',tenders:[],completedAt:'2026-09-21T01:00:00Z'});
    const rows=financialExportRows(returned.orders),header=rows[0],row=rows.at(-1);
    assert.ok(rows.every(r=>r.length===header.length));
    assert.equal(row[header.indexOf('记录类型')],'退回商品');
    assert.equal(row[header.indexOf('有效销售数量')],physical?0:-1);
    assert.equal(row[header.indexOf('实物奖品发放数量')],physical?-1:0);
    assert.equal(row[header.indexOf('关联奖品权益ID')],physical?'right-1':'');
    assert.equal(row[header.indexOf('实际入库数量')],1);
  }
});
