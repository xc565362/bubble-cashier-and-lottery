(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./config'), require('./memory-store'), require('./service'));
  else root.LotteryDemo = factory(root.LotteryConfig, root.LotteryMemory, root.LotteryService);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (config, memory, service) {
  function createDemo(read, write) {
    const store = new memory.MemoryStore(read() || {}, write);
    const campaign = {...config.campaign, enabled:false, startsAt:null, endsAt:null, redeemEndsAt:Date.now()+30*86400000};
    const call = service.createService({
      store, prizes:config.prizes,
      campaign,
      couponPolicy:{merchantId:'demo-only',storeIds:['demo-only'],minimumGoodsAmountCents:0},
      now:()=>Date.now(), randomIndex:limit=>Math.floor(Math.random()*limit),
      makeCode:()=>Array.from({length:16},()=>Math.floor(Math.random()*16).toString(16)).join('').toUpperCase(),
      // 仅浏览器/开发演示使用 Math.random；正式云函数使用 crypto.randomBytes。
      makeCouponCode:()=> 'LJC1_'+Array.from({length:32},()=>Math.floor(Math.random()*16).toString(16)).join('').toUpperCase(),
      entryId: id => `${config.campaign.id}-${id}`, adminIds:['demo-staff']
    });
    let initializing;
    return async (action, payload) => {
      // Native pages share this instance; all calls must await the same initialization.
      if (!initializing) initializing = call('initializePool',{},'demo-staff').then(
        () => { campaign.enabled=true; },
        error => { initializing=null;throw error; }
      );
      await initializing;
      return call(action, payload, ['lookup','redeem','identity'].includes(action) ? 'demo-staff' : 'demo-visitor');
    };
  }
  // A browser tab must read the latest persisted data after acquiring the shared lock.
  // Otherwise an older tab's status refresh could overwrite a completed redemption.
  function createSession(read,write,withLock){
    return (action,payload)=>withLock(()=>createDemo(read,write)(action,payload));
  }
  return { createDemo, createSession };
});
