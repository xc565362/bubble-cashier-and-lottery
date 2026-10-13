const crypto=require('node:crypto');
const {createCenterClient}=require('./center-client.cjs');
const {redemptionDeadline}=require('./domain.js');
const fault=(code,message)=>Object.assign(new Error(message),{code});
function createPhysicalCenter({base,store,campaign,prizes,physicalConfig:config,adminIds,entryId,now,fetchFn,allowLocalTest=false,catalogCenterConfig}) {
  if(!config)return base;
  if(!['migrating','active'].includes(config.stage)||!Number.isSafeInteger(config.handoffReadyAt))throw fault('INVALID_CONFIG','实物券中心切换配置不完整');
  const clients={};
  const catalogClient=catalogCenterConfig?require('./catalog-center.cjs').createCatalogCenter({config:catalogCenterConfig,fetchFn,allowLocalTest}):null;
  for(const prize of prizes.filter(p=>p.kind==='physical')){
    const mapping=config.prizes?.[prize.id];
    if(!mapping?.campaignId)throw fault('INVALID_CONFIG','实物奖品映射不完整');
    clients[prize.id]=createCenterClient({...config,...mapping,physical:true,fetchFn,allowLocalTest});
  }
  const publicReceipt=(e,status,redeemedAt=e.redeemedAt)=>({prize:require('./catalog.cjs').publicPrize(e.prize),code:e.code,createdAt:e.createdAt,status,checkoutCoupon:false,redeemedAt:redeemedAt||null,expiresAt:redemptionDeadline(campaign)});
  function binding(id,e){if(e.prize.centerCampaignId){if(!catalogClient)throw fault('INVALID_CONFIG','新实物奖品券中心尚未配置');return {managed:true,origin:catalogClient.origin,centerId:catalogClient.centerId,environment:catalogClient.environment,campaignId:e.prize.centerCampaignId,prizeId:e.prize.id,owner:crypto.createHash('sha256').update('bubble-physical-owner:'+id).digest('hex'),awardId:id,startsAt:campaign.startsAt,expiresAt:campaign.redeemEndsAt};}return {origin:clients[e.prize.id].origin,centerId:config.centerId,environment:config.environment,campaignId:config.prizes[e.prize.id].campaignId,prizeId:e.prize.id,
    owner:crypto.createHash('sha256').update('bubble-physical-owner:'+id).digest('hex'),awardId:id,startsAt:campaign.startsAt,expiresAt:campaign.redeemEndsAt};}
  async function resolve(id,migrate=false){
    let e=await store.transaction(tx=>tx.get('entries',id));
    if(!e || e.campaignId!==campaign.id)throw fault('NOT_FOUND','未找到当前活动中奖记录');
    if(e.prize?.kind!=='physical')return null;
    if(!(e.prize.centerCampaignId?catalogClient:clients[e.prize.id])||!/^[0-9A-F]{16}$/.test(e.code))throw fault('INVALID_CODE','原实物奖品信息不正确');
    if(e.status==='redeemed')return publicReceipt(e,'redeemed');
    if(e.status!=='pending')return publicReceipt(e,'unavailable');
    if(now()>=redemptionDeadline(campaign)&&!e.physicalCenter)return publicReceipt(e,'expired');
    if(now()<config.handoffReadyAt || config.stage!=='active'&&!migrate)return publicReceipt(e,'unavailable');
    let mismatch=false;
    try{
      const expected=binding(id,e);
      e=await store.transaction(async tx=>{
        const current=await tx.get('entries',id);
        if(!current||current.code!==e.code||current.campaignId!==campaign.id)throw Error('Changed entry');
        if(current.status==='redeemed')return current;
        if(current.physicalCenter&&Object.entries(expected).some(([key,value])=>current.physicalCenter[key]!==value)){mismatch=true;throw Error('Changed binding');}
        const next={...current,physicalCenter:expected,physicalMigration:{state:'issuing',updatedAt:now()}};
        await tx.set('entries',id,next);return next;
      });
      if(e.status==='redeemed')return publicReceipt(e,'redeemed');
      const b=e.physicalCenter,client=b.managed?catalogClient:clients[e.prize.id];
      const c=b.managed?(e.physicalCouponId?await client.detail(b.campaignId,b.owner,e.physicalCouponId):await client.issue(b.campaignId,b.owner,b.awardId,e.code)):(e.physicalCouponId?await client.detail(b.owner,e.physicalCouponId):await client.issue(b.owner,b.awardId,e.code));
      if(!c?.id||c.owner!==b.owner||c.awardId!==b.awardId||c.campaignId!==b.campaignId||c.issuer!=='campaign:'+b.campaignId||c.environment!==b.environment||c.kind!=='physical'||
        c.physical?.prizeId!==e.prize.id||c.physical.quantity!==1||e.prize.product&&['sku','barcode'].some(key=>(e.prize.product[key]||'')!==(c.physical.product?.[key]||''))||c.amountCents!==0||c.minimumCents!==0||Date.parse(c.startsAt)!==b.startsAt||Date.parse(c.expiresAt)!==b.expiresAt||e.physicalCouponId&&e.physicalCouponId!==c.id){mismatch=true;throw Error('Mismatched physical entitlement');}
      let status,redeemedAt=null;
      if(c.state==='REDEEMED'){status='redeemed';redeemedAt=Date.parse(c.redeemedAt);if(!Number.isFinite(redeemedAt)){mismatch=true;throw Error('Invalid redemption time');}}
      else if(c.state==='PAYMENT_PENDING')status='using';
      else if(c.state==='VOID')status='voided';
      else if(c.state==='EXPIRED'||now()>=redemptionDeadline(campaign))status='expired';
      else if(c.state==='RESERVED')status='using';
      else if(c.state==='AVAILABLE'&&c.code===e.code)status=now()<campaign.startsAt?'not_started':'pending';
      else{mismatch=true;throw Error('Invalid physical state or barcode');}
      return await store.transaction(async tx=>{
        const current=await tx.get('entries',id);
        if(current.status==='redeemed')return publicReceipt(current,'redeemed');
        if(current.code!==e.code||current.physicalCouponId&&current.physicalCouponId!==c.id)throw Error('Changed physical entitlement');
        const next={...current,physicalCouponId:c.id,physicalMigration:{state:'ready',updatedAt:now()},...(status==='redeemed'?{status,redeemedAt}:{})};
        await tx.set('entries',id,next);return publicReceipt(next,status,redeemedAt);
      });
    }catch(error){
      await store.transaction(async tx=>{const current=await tx.get('entries',id);if(current&&current.status!=='redeemed')await tx.set('entries',id,{...current,physicalMigration:{state:'retry',updatedAt:now()}});});
      return publicReceipt(e,error.code==='INACTIVE'&&now()>=redemptionDeadline(campaign)?'expired':mismatch||e.physicalCouponId||error.code==='CENTER_MISMATCH'?'unavailable':'issuing');
    }
  }
  return async(action,payload={},openId)=>{
    if(!openId)throw fault('UNAUTHENTICATED','请在微信中打开活动');
    if(action==='migratePhysical'){
      if(!adminIds.includes(openId))throw fault('FORBIDDEN','当前账号没有迁移权限');
      if(config.stage!=='migrating'||now()<config.handoffReadyAt)throw fault('POS_NOT_READY','请等待实物核销切换窗口完成');
      if(!Array.isArray(payload.entryIds)||payload.entryIds.length<1||payload.entryIds.length>20||payload.entryIds.some(id=>typeof id!=='string'||!id||id.length>120))throw fault('INVALID_CONFIG','每次提供 1 至 20 个原始中奖记录 ID');
      const entries=[];
      for(const id of [...new Set(payload.entryIds)]){try{const r=await resolve(id,true);entries.push({id,status:r?.status||'not_physical'});}catch(error){entries.push({id,status:'error',code:error.code||'SERVICE_UNAVAILABLE'});}}
      return {entries};
    }
    if(action==='lookup'||action==='redeem'){
      if(!adminIds.includes(openId))throw fault('FORBIDDEN','当前微信账号没有核销权限');
      const code=String(payload.code||'').trim().replace(/^bubble:/i,'').replace(/[\s-]/g,'').toUpperCase();
      const ref=await store.transaction(tx=>tx.get('codes',code));
      if(ref?.campaignId===campaign.id){
        const e=await store.transaction(tx=>tx.get('entries',ref.entryId));
        if(e?.code===code&&e.prize?.kind==='physical'){
          if(action==='redeem')throw fault('POS_REQUIRED','实物奖品请在收银系统扫码，免费入单并完成核销后发放');
          return resolve(ref.entryId);
        }
      }
    }
    const result=await base(action,payload,openId);
    if(!['state','draw'].includes(action))return result;
    const visible=action==='state'?result.entry:result;
    if(visible?.prize?.kind!=='physical')return result;
    const e=await resolve(entryId(openId));return action==='state'?{...result,entry:e}:e;
  };
}
module.exports={createPhysicalCenter};
