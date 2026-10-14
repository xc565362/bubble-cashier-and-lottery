'use strict';
const collections={
  entries:'lottery_entries', codes:'lottery_codes', pools:'lottery_pools', coupons:'lottery_coupons',
  couponReservations:'lottery_coupon_reservations', couponRequests:'lottery_coupon_requests',
  couponCheckouts:'lottery_coupon_checkouts', couponOrders:'lottery_coupon_orders',
  couponPayments:'lottery_coupon_payments', gatewayNonces:'lottery_gateway_nonces', gatewayRates:'lottery_gateway_rates'
};
function createCloudStore(db){
  function collectionName(name){if(!collections[name])throw new Error('Unknown collection');return collections[name];}
  return {readEntries:require('./draw-records.cjs').createCloudRecordsReader(db,collections.entries),transaction(callback){
    return db.runTransaction(async native=>callback({
      async get(collection,id){
        let result;
        try{result=await native.collection(collectionName(collection)).doc(id).get();}
        catch(error){
          const message=String(error.errMsg||error.message||'');
          if(/document(?:\s|\S)*?(?:does not exist|not exist|not found)/i.test(message))return null;
          throw error;
        }
        const data=Array.isArray(result.data)?result.data[0]:result.data;
        return data&&Object.keys(data).length?data:null;
      },
      async set(collection,id,value){
        const {_id,...data}=value;
        await native.collection(collectionName(collection)).doc(id).set({data});
      }
    }));
  }};
}
module.exports={createCloudStore,collections};
