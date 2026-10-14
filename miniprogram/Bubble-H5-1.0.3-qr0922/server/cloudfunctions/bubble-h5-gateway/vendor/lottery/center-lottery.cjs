const crypto=require('node:crypto');
const {createCenterClient}=require('./center-client.cjs');
const {redemptionDeadline}=require('./domain.js');
function createCenterLottery(options){
  const {createService,store,prizes,campaign,centerConfig,now,entryId}=options;
  if(!centerConfig||!centerConfig.prizes)throw new Error('尚未配置券中心');
  const clients={};
  let catalogClient=null;
  if(options.catalogCenterConfig)catalogClient=require('./catalog-center.cjs').createCatalogCenter({config:options.catalogCenterConfig,fetchFn:options.fetchFn,allowLocalTest:options.allowLocalTest});
  for(const prize of prizes.filter(p=>p.kind==='cash')){
    const mapping=centerConfig.prizes[prize.id];
    if(!mapping||!Number.isSafeInteger(mapping.minimumCents)||mapping.minimumCents<0||!Number.isSafeInteger(prize.amount*100)||prize.amount<=0)throw new Error('购物券映射不完整');
    clients[prize.id]=createCenterClient({...centerConfig,...mapping,fetchFn:options.fetchFn,allowLocalTest:options.allowLocalTest});
  }
  const cashCenter={assertReady(currentPrizes=prizes){if(currentPrizes.some(p=>p.centerCampaignId)&&!catalogClient)throw Object.assign(new Error('新奖品券中心尚未配置'),{code:'INVALID_CONFIG'});if(currentPrizes.some(p=>p.centerCampaignId&&p.kind==='physical'&&!p.retired)&&options.physicalConfig?.stage!=='active')throw Object.assign(new Error('新实物奖品必须先接通收银核销中心'),{code:'INVALID_CONFIG'});if(!Number.isSafeInteger(redemptionDeadline(campaign))||redemptionDeadline(campaign)<=now())throw Object.assign(new Error('购物券已超过使用期限'),{code:'EXPIRED'});},bind({prize,id,openId}){
    if(prize.centerCampaignId){if(!catalogClient)throw Object.assign(new Error('新奖品券中心尚未配置'),{code:'INVALID_CONFIG'});return {managed:true,origin:catalogClient.origin,centerId:catalogClient.centerId,environment:catalogClient.environment,prizeId:prize.id,campaignId:prize.centerCampaignId,owner:crypto.createHash('sha256').update('bubble-owner:'+openId).digest('hex'),awardId:id,amountCents:Math.round(prize.amount*100),minimumCents:prize.minimumCents||0,startsAt:campaign.startsAt,expiresAt:campaign.redeemEndsAt};}
    const mapping=centerConfig.prizes[prize.id];
    return {origin:clients[prize.id].origin,centerId:centerConfig.centerId,environment:centerConfig.environment,prizeId:prize.id,
      campaignId:mapping.campaignId,owner:crypto.createHash('sha256').update('bubble-owner:'+openId).digest('hex'),awardId:id,
      amountCents:Math.round(prize.amount*100),minimumCents:mapping.minimumCents,startsAt:campaign.startsAt,expiresAt:campaign.redeemEndsAt};
  }};
  const base=createService({...options,cashCenter});
  function receipt(entry,status,code='',redeemedAt=null){return {prize:require('./catalog.cjs').publicPrize(entry.prize),code,createdAt:entry.createdAt,status,checkoutCoupon:true,
    expiresAt:Math.min(entry.cashCenter.expiresAt,redemptionDeadline(campaign)),minimumGoodsAmountCents:entry.cashCenter.minimumCents,redeemedAt:redeemedAt||entry.redeemedAt||null};}
  async function resolve(id){
    const entry=await store.transaction(tx=>tx.get('entries',id));
    if(!entry)return null;
    if(!entry.cashCenter){
      if(entry.couponId)return {prize:require('./catalog.cjs').publicPrize(entry.prize),code:'',createdAt:entry.createdAt,status:'unavailable',checkoutCoupon:true,redeemedAt:null,expiresAt:campaign.redeemEndsAt,minimumGoodsAmountCents:null};
      return null;
    }
    if(entry.status==='redeemed')return receipt(entry,'redeemed');
    const binding=entry.cashCenter,client=binding.managed?catalogClient:clients[binding.prizeId],mapping=binding.managed?{campaignId:entry.prize.centerCampaignId}:centerConfig.prizes[binding.prizeId];
    let mismatch=false;
    try{
      if(!client||client.origin!==binding.origin||(binding.managed?client.centerId:centerConfig.centerId)!==binding.centerId||(binding.managed?client.environment:centerConfig.environment)!==binding.environment||mapping.campaignId!==binding.campaignId){mismatch=true;throw new Error('binding changed');}
      const c=binding.managed?(entry.centerCouponId?await client.detail(binding.campaignId,binding.owner,entry.centerCouponId):await client.issue(binding.campaignId,binding.owner,binding.awardId)):(entry.centerCouponId?await client.detail(binding.owner,entry.centerCouponId):await client.issue(binding.owner,binding.awardId));
      if(!c||!c.id||c.owner!==binding.owner||c.awardId!==binding.awardId||c.campaignId!==binding.campaignId||c.issuer!=='campaign:'+binding.campaignId||c.environment!==binding.environment||
        c.amountCents!==binding.amountCents||c.minimumCents!==binding.minimumCents||Date.parse(c.startsAt)!==binding.startsAt||Date.parse(c.expiresAt)!==binding.expiresAt||entry.centerCouponId&&entry.centerCouponId!==c.id){mismatch=true;throw new Error('coupon mismatch');}
      let status,code='',redeemedAt=null;
      if(c.state==='REDEEMED'){status='redeemed';redeemedAt=Date.parse(c.redeemedAt);if(!Number.isFinite(redeemedAt)){mismatch=true;throw new Error('invalid receipt');}}
      else if(c.state==='PAYMENT_PENDING')status='using';
      else if(c.state==='VOID')status='voided';
      else if(c.state==='EXPIRED'||now()>=Math.min(binding.expiresAt,redemptionDeadline(campaign)))status='expired';
      else if(c.state==='RESERVED')status='using';
      else if(c.state==='AVAILABLE'){
        if(now()<binding.startsAt)status='not_started';
        else if(/^LJC1_[0-9A-F]{32}$/.test(c.code)){status='pending';code=c.code;}
        else {mismatch=true;throw new Error('invalid barcode');}
      }else {mismatch=true;throw new Error('unknown state');}
      return await store.transaction(async tx=>{
        const current=await tx.get('entries',id);
        if(current.status==='redeemed')return receipt(current,'redeemed');
        if(current.centerCouponId&&current.centerCouponId!==c.id)throw new Error('coupon changed');
        await tx.set('entries',id,{...current,centerCouponId:c.id,...(status==='redeemed'?{status,redeemedAt}: {})});
        return receipt(current,status,code,redeemedAt);
      });
    }catch(error){return receipt(entry,error.code==='INACTIVE'&&now()>=Math.min(binding.expiresAt,redemptionDeadline(campaign))?'expired':mismatch||error.code==='CENTER_MISMATCH'||entry.centerCouponId?'unavailable':'issuing');}
  }
  return async(action,payload,openId)=>{
    const result=await base(action,payload,openId);
    if(action!=='draw'&&action!=='state')return result;
    const entry=await resolve(entryId(openId));
    return action==='state'?{...result,entry:entry||result.entry}:entry||result;
  };
}
module.exports={createCenterLottery};
