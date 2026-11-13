import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {resolvePhysicalProduct,validatePhysicalLine}=require('../coupons/physical-products.cjs');
const cap={id:'actual-cap',name:'户外棒球帽（砾石灰）',sku:'BB250005',barcode:'BB250005',price:169,stock:2,productType:'sale'};
test('known codes match exact sku or barcode and same product matches are deduplicated',()=>{
  assert.equal(resolvePhysicalProduct('cap',[cap]).id,'actual-cap');
  assert.equal(resolvePhysicalProduct('bucket',[{...cap,id:'bucket',sku:'',barcode:'BB250003'}]).id,'bucket');
  assert.equal(resolvePhysicalProduct('waist',[{...cap,id:'waist',sku:'BB240011',barcode:''}]).id,'waist');
  assert.equal(resolvePhysicalProduct('tote',[{...cap,id:'tote',name:'超大编织袋',sku:'BB260057',barcode:'6973990851614'}]).id,'tote');
  assert.equal(cap.price,169);assert.equal(cap.productType,'sale');
});
test('missing ambiguous out-of-stock and invalid catalog products are rejected',()=>{
  assert.throws(()=>resolvePhysicalProduct('cap',[]),/未找到/);
  assert.throws(()=>resolvePhysicalProduct('cap',[cap,{...cap,id:'other'}]),/多个/);
  assert.throws(()=>resolvePhysicalProduct('tote',[{...cap,name:'超大编织袋',sku:'BB260057'},{...cap,id:'other',name:'超大编织袋',sku:'BB260057'}]),/多个/);
  assert.throws(()=>resolvePhysicalProduct('cap',[{...cap,stock:0}]),/库存/);
  assert.throws(()=>resolvePhysicalProduct('cap',[{...cap,productType:'coupon'}]),/商品类型/);
  assert.throws(()=>resolvePhysicalProduct('cap',[{...cap,sku:'xxBB250005',barcode:''}]),/未找到/);
});
test('shopping bag requires the confirmed code instead of a matching name',()=>{
  for(const name of ['超大号购物袋','超大编织袋']){
    const product={...cap,id:'bag',name,sku:'',barcode:''};
    assert.throws(()=>resolvePhysicalProduct('tote',[product]),/未找到/);
  }
  assert.throws(()=>resolvePhysicalProduct('tote',[{...cap,name:'礼品袋',sku:'BBLZ0037',barcode:'BBLZ0037'}]),/未找到/);
  assert.equal(resolvePhysicalProduct('tote',[{...cap,id:'barcode-bag',sku:'',barcode:'BB260057'}]).id,'barcode-bag');
});
test('confirmed bag code distinguishes two real bags without changing either inventory',()=>{
  const products=[{...cap,id:'bag-new',name:'超大号购物袋',sku:'BB112233',barcode:'BB112233',stock:100},{...cap,id:'bag-old',name:'超大编织袋',sku:'BB260057',barcode:'6973990851614',stock:100}];
  const original=structuredClone(products);
  assert.equal(resolvePhysicalProduct('tote',products).id,'bag-old');
  assert.deepEqual(products,original);
  assert.throws(()=>resolvePhysicalProduct('tote',[products[0]]),/未找到/);
});
test('physical line validation locks product identity, quantity and zero price',()=>{
  const binding={prizeId:'cap',product:cap};
  const line={...cap,qty:1,price:0,discount:0,productType:'gift',lineKey:'lottery-gift:coupon',externalCoupon:{kind:'physical',prizeId:'cap',couponId:'coupon'}};
  validatePhysicalLine(line,binding);
  for(const changed of [{id:'other'},{qty:2},{price:1},{discount:1},{productType:'sale'},{sku:'other'},{lineKey:'ordinary'}])assert.throws(()=>validatePhysicalLine({...line,...changed},binding));
});
