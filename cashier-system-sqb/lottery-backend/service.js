(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./domain'));
  else root.LotteryService = factory(root.LotteryDomain);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (domain) {
  const { fault, selectPrize, normalizeCode, publicEntry, assertDrawing, redemptionDeadline } = domain;
  const validScope = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value;
  function createService({ store, prizes, campaign, couponPolicy, cashCenter, now, randomTicket, randomIndex, makeCode, makeCouponCode, entryId, adminIds }) {
    const poolId = campaign.id + ':stock', markerId = campaign.id + ':init';
    const management = campaign.inventory ? require('./pool-management.cjs').createPoolManagement({ store, campaign, prizes, now }) : null;
    function inventoryConfig(settings) {
      const inventory = settings ? management.inventory(settings) : campaign.inventory;
      if (inventory == null) return null; // Explicit unbounded legacy/test configurations only.
      const quantities = inventory.quantities, ids = (settings?.catalog||prizes).map(prize=>prize.id).sort();
      if (!validScope(campaign.id) || inventory.version !== 1 || !Number.isSafeInteger(inventory.total) || inventory.total <= 0 ||
          !quantities || Array.isArray(quantities) || new Set(ids).size !== ids.length ||
          JSON.stringify(Object.keys(quantities).sort()) !== JSON.stringify(ids) ||
          ids.some(id=>!Number.isSafeInteger(quantities[id]) || quantities[id] < 0) ||
          ids.reduce((sum,id)=>sum+quantities[id],0) !== inventory.total) throw fault('INVALID_CONFIG','奖池名额配置错误，请联系活动管理员');
      return { ...inventory, signature:JSON.stringify([inventory.version,inventory.total,ids.map(id=>[id,quantities[id]])]) };
    }
    async function readPool(tx, config, allowMissing = false) {
      const marker = await tx.get('pools',markerId), stock = await tx.get('pools',poolId);
      if (!marker && !stock) {
        if (allowMissing) return null;
        throw fault('POOL_NOT_READY','奖池尚未初始化，请联系活动管理员');
      }
      if (!marker || !stock || marker.campaignId !== campaign.id || stock.campaignId !== campaign.id || marker.version !== 1 || stock.version !== 1 ||
          typeof marker.signature !== 'string' || marker.signature !== stock.signature || !Number.isSafeInteger(marker.initializedAt) ||
          marker.initializedAt !== stock.initializedAt) throw fault('POOL_CORRUPT','奖池状态异常，已暂停新抽奖，请联系活动管理员');
      if (marker.signature !== config.signature) throw fault('POOL_CONFIG_MISMATCH','奖池配置与已初始化名额不一致，不能重置或补充名额');
      const ids = Object.keys(config.quantities).sort();
      if (!Number.isSafeInteger(stock.remaining) || stock.remaining < 0 || stock.remaining > config.total ||
          !Number.isSafeInteger(stock.allocated) || stock.allocated < 0 || stock.allocated + stock.remaining !== config.total ||
          !stock.quantities || Array.isArray(stock.quantities) || JSON.stringify(Object.keys(stock.quantities).sort()) !== JSON.stringify(ids) ||
          ids.some(id=>!Number.isSafeInteger(stock.quantities[id]) || stock.quantities[id] < 0 || stock.quantities[id] > config.quantities[id]) ||
          ids.reduce((sum,id)=>sum+stock.quantities[id],0) !== stock.remaining) throw fault('POOL_CORRUPT','奖池状态异常，已暂停新抽奖，请联系活动管理员');
      return stock;
    }
    async function allocate(tx, settings) {
      const config = inventoryConfig(settings);
      if (!config) return selectPrize(prizes,randomTicket());
      const stock = await readPool(tx,config);
      if (!stock.remaining) throw fault('SOLD_OUT','本次活动名额已发完，已中奖奖品仍可在有效期内使用');
      management?.assertFixedAvailable(settings, stock);
      if (typeof randomIndex !== 'function') throw fault('INVALID_CONFIG','奖池随机数配置错误');
      const fixed = settings?.mode === 'fixed';
      const limit = fixed ? 10000 : stock.remaining;
      let ticket = randomIndex(limit);
      if (!Number.isSafeInteger(ticket) || ticket < 0 || ticket >= limit) throw fault('INVALID_RANDOM','抽奖随机数异常');
      let selected;
      for (const prize of settings?.catalog||prizes) {
        const weight = fixed ? settings.weightsBps[prize.id] : stock.quantities[prize.id];
        if (ticket < weight) { selected = prize; break; }
        ticket -= weight;
      }
      const quantities = {...stock.quantities,[selected.id]:stock.quantities[selected.id]-1};
      await tx.set('pools',poolId,{...stock,quantities,remaining:stock.remaining-1,allocated:stock.allocated+1});
      return {...selected};
    }
    async function assertCouponConfig(currentPrizes=prizes,tx) {
      if(cashCenter)await cashCenter.assertReady(currentPrizes,tx);
      if (campaign.cashFulfilment !== 'checkout_coupon' || !currentPrizes.some(prize=>prize.kind==='cash')) return;
      if (cashCenter) return;
      if (!couponPolicy || !validScope(couponPolicy.merchantId) ||
          !Array.isArray(couponPolicy.storeIds) || !couponPolicy.storeIds.length || couponPolicy.storeIds.some(id=>!validScope(id)) ||
          !Number.isSafeInteger(couponPolicy.minimumGoodsAmountCents) || couponPolicy.minimumGoodsAmountCents < 0 ||
          currentPrizes.some(prize=>prize.kind==='cash' && (!Number.isSafeInteger(prize.amount*100) || prize.amount<=0)) ||
          !Number.isSafeInteger(campaign.redeemEndsAt) || campaign.redeemEndsAt <= now() || typeof makeCouponCode !== 'function') {
        throw fault('INVALID_CONFIG', '购物券尚未配置收银门店，请联系活动管理员');
      }
    }
    async function view(tx, entry) {
      return publicEntry(entry, now(), campaign, entry && entry.couponId ? await tx.get('coupons', entry.code) : null);
    }
    return async function call(action, payload = {}, openId) {
      if (!openId) throw fault('UNAUTHENTICATED', '请在微信中打开活动');
      const isAdmin = adminIds.includes(openId);
      const id = entryId(openId);
      if (action === 'initializePool') {
        if (!isAdmin) throw fault('FORBIDDEN','当前微信账号没有奖池管理权限');
        if (campaign.enabled !== false) throw fault('POOL_ACTIVE','请先暂停活动，再初始化奖池');
        const config = inventoryConfig();
        if (!config) throw fault('INVALID_CONFIG','此活动没有固定名额奖池');
        return store.transaction(async tx=>{
          if (management && (await management.readSettings(tx)).revision > 0) throw fault('POOL_ACTIVE', '奖池已启用管理，禁止重新初始化');
          const existing = await readPool(tx,config,true);
          if (existing) return {alreadyInitialized:true,total:config.total,remaining:existing.remaining};
          const marker = {campaignId:campaign.id,version:1,signature:config.signature,initializedAt:now()};
          await tx.set('pools',markerId,marker);
          await tx.set('pools',poolId,{...marker,quantities:{...config.quantities},remaining:config.total,allocated:0});
          return {alreadyInitialized:false,total:config.total,remaining:config.total};
        });
      }
      if (action === 'state') {
        return store.transaction(async tx => {
          let drawError = null, inventory = null,stock=null;
          let settings = null;
          try {
            settings = management ? await management.readSettings(tx) : null;
            try { assertDrawing(settings ? {...campaign, enabled: settings.enabled} : campaign, now()); await assertCouponConfig(settings?.catalog||prizes,tx); } catch (error) { drawError = error.message; }
            const config = inventoryConfig(settings);
            if (config) {
              inventory = {total:config.total,remaining:null};
              stock = await readPool(tx,config);inventory.remaining=stock.remaining;
              if (!stock.remaining) drawError = '本次活动名额已发完，已中奖奖品仍可在有效期内使用';
              try { management?.assertFixedAvailable(settings, stock); } catch (error) { drawError = error.message; }
            }
          } catch (error) {
            if (!['INVALID_CONFIG','POOL_NOT_READY','POOL_CORRUPT','POOL_CONFIG_MISMATCH'].includes(error.code)) throw error;
            drawError = error.message;
          }
          const publicCampaign = {...campaign, redeemEndsAt:redemptionDeadline(campaign), ...(settings ? {enabled:settings.enabled,drawMode:settings.mode} : {}),inventory:inventory?{version:1,total:inventory.total}:null};
          const publicPrizes = (settings?.catalog||prizes).filter(p=>!p.retired).map(prize=>{
            const {centerCampaignId,product,...visible}=prize;
            if(!settings)return {...visible,...(campaign.inventory?{quantity:(campaign.inventory.quantities||{})[prize.id]}:{})};
            const effective=drawError||!stock?.remaining?0:settings.mode==='fixed'?settings.weightsBps[prize.id]/100:stock.quantities[prize.id]/stock.remaining*100;
            return {...visible,quantity:settings.quantities[prize.id],remaining:stock?.quantities[prize.id]??null,probability:effective,effectiveProbability:effective,configuredProbability:settings.weightsBps[prize.id]/100};
          });
          return { campaign:publicCampaign, prizes:publicPrizes, inventory, catalogRevision:settings?.revision??0, isAdmin, drawError, entry: await view(tx, await tx.get('entries', id)) };
        });
      }
      if (action === 'identity') return { openId, isAdmin };
      if (action === 'draw') {
        return store.transaction(async tx => {
          const existing = await tx.get('entries', id);
          if (existing) return view(tx, existing);
          const settings = management ? await management.readSettings(tx) : null;
          assertDrawing(settings ? {...campaign, enabled:settings.enabled} : campaign, now());
          // Validate the entire campaign before sampling: misconfiguration must not bias awards toward physical prizes.
          await assertCouponConfig(settings?.catalog||prizes,tx);
          const prize = await allocate(tx, settings);
          const checkoutCoupon = prize.kind === 'cash' && campaign.cashFulfilment === 'checkout_coupon';
          if (checkoutCoupon && cashCenter) {
            // Persist the trusted winner before contacting another service. Retries reuse this award.
            const entry = { campaignId:campaign.id, prize, code:'', status:'pending', createdAt:now(), redeemedAt:null,
              cashCenter:await cashCenter.bind({prize,id,openId,campaign,tx}) };
            await tx.set('entries',id,entry);
            return view(tx,entry);
          }
          let code;
          for (let attempt = 0; attempt < 5; attempt++) {
            const candidate = normalizeCode(checkoutCoupon ? makeCouponCode() : makeCode());
            if (checkoutCoupon && !/^LJC1_[0-9A-F]{32}$/.test(candidate)) throw fault('INVALID_CONFIG', '购物券码生成配置错误');
            if (!(await tx.get('codes', candidate)) && (!checkoutCoupon || !(await tx.get('coupons', candidate)))) { code = candidate; break; }
          }
          if (!code) throw fault('RETRY', '系统繁忙，请重试');
          const entry = { campaignId: campaign.id, prize, code, status:'pending', createdAt:now(), redeemedAt:null };
          if (checkoutCoupon) {
            entry.couponId = id;
            await tx.set('coupons', code, {
              couponId:id, entryId:id, campaignId:campaign.id, code, merchantId:couponPolicy.merchantId,
              storeIds:[...couponPolicy.storeIds], faceValueCents:prize.amount*100, expiresAt:campaign.redeemEndsAt,
              status:'AVAILABLE', reservationId:null, reservedUntil:null, createdAt:entry.createdAt,
              rules:{minimumGoodsAmountCents:couponPolicy.minimumGoodsAmountCents}
            });
          }
          await tx.set('entries', id, entry);
          await tx.set('codes', code, { entryId:id, campaignId:campaign.id });
          return view(tx, entry);
        });
      }
      if (action === 'lookup' || action === 'redeem') {
        if (!isAdmin) throw fault('FORBIDDEN', '当前微信账号没有核销权限');
        const code = normalizeCode(payload.code);
        return store.transaction(async tx => {
          const reference = await tx.get('codes', code);
          if (!reference && cashCenter && code.startsWith('LJC1_')) throw fault('CHECKOUT_REQUIRED', '购物抵扣券须在收银系统付款成功后核销');
          if (!reference || reference.campaignId !== campaign.id) throw fault('NOT_FOUND', '未找到此活动的核销码，请核对');
          const entry = await tx.get('entries', reference.entryId);
          if (!entry || entry.code !== code) throw fault('NOT_FOUND', '未找到中奖记录');
          if (action === 'lookup') return view(tx, entry);
          if (entry.couponId) throw fault('CHECKOUT_REQUIRED', '购物抵扣券须在收银系统付款成功后核销，不能在此直接发放');
          if (entry.status === 'redeemed') return { ...await view(tx, entry), alreadyRedeemed:true };
          if (redemptionDeadline(campaign) && now() >= redemptionDeadline(campaign)) throw fault('EXPIRED', '该奖品已超过核销期限');
          const redeemed = { ...entry, status:'redeemed', redeemedAt:now(), redeemedBy:openId };
          await tx.set('entries', reference.entryId, redeemed);
          return { ...await view(tx, redeemed), alreadyRedeemed:false };
        });
      }
      throw fault('INVALID_ACTION', '不支持的操作');
    };
  }
  return { createService };
});
