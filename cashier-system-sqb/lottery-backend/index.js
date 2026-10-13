const cloud=require('wx-server-sdk');
const crypto=require('node:crypto');
const {createCloudStore}=require('./store');
const {createService}=require('./service');
const {createCenterLottery}=require('./center-lottery.cjs');
const {createPhysicalCenter}=require('./physical-center.cjs');
const {campaign,prizes}=require('./config');
const {createActivityCode}=require('./activity-code');
cloud.init({env:cloud.DYNAMIC_CURRENT_ENV});
const store=createCloudStore(cloud.database());
const adminIds=(process.env.LOTTERY_ADMIN_OPENIDS||'').split(',').map(value=>value.trim()).filter(Boolean);
const activityCode=createActivityCode({cloud,store,campaign,adminIds});
let couponPolicy;
try { couponPolicy=JSON.parse(process.env.COUPON_POLICY_JSON || 'null'); } catch { couponPolicy=null; }
let centerConfig;
try { centerConfig=JSON.parse(process.env.CASHIER_CENTER_JSON || 'null'); } catch { centerConfig=null; }
let service;
let catalogCenterConfig;
try{catalogCenterConfig=JSON.parse(process.env.LOTTERY_MANAGEMENT_CENTER_JSON||'null');}catch{catalogCenterConfig=null;}
let physicalConfig,physicalConfigInvalid=false;
try{physicalConfig=JSON.parse(process.env.PHYSICAL_CENTER_JSON||'null');}catch{physicalConfigInvalid=true;}
const serviceOptions={
  store,campaign,prizes,couponPolicy,catalogCenterConfig,physicalConfig,
  now:()=>Date.now(),randomTicket:()=>crypto.randomInt(100),randomIndex:limit=>crypto.randomInt(limit),
  makeCode:()=>crypto.randomBytes(8).toString('hex').toUpperCase(),
  makeCouponCode:()=> 'LJC1_'+crypto.randomBytes(16).toString('hex').toUpperCase(),
  entryId:openId=>crypto.createHash('sha256').update(`${campaign.id}:${openId}`).digest('hex').slice(0,32),
  adminIds
};
exports.main=async (event={})=>{
  if (event.httpMethod) {
    let config;
    try { config = JSON.parse(process.env.LOTTERY_MANAGEMENT_CENTER_JSON || 'null'); } catch { config = null; }
    return require('./management-http.cjs').createManagementHttp({ store, campaign, prizes, key: process.env.LOTTERY_MANAGEMENT_KEY, centerConfig: config })(event);
  }
  try{
    const identity=cloud.getWXContext();
    if(event.action!=='activityCode'&&!service){
      try { if(physicalConfigInvalid)throw new Error('Invalid physical center config'); const base=createCenterLottery({...serviceOptions,createService,centerConfig});service=createPhysicalCenter({...serviceOptions,base,physicalConfig}); }
      catch { throw Object.assign(new Error('购物券中心尚未接通，请联系活动管理员'),{code:'INVALID_CONFIG'}); }
    }
    // 不读取 event.openId / payload.openId 等客户端身份字段。
    const data=event.action==='activityCode'?await activityCode(identity.OPENID):await service(event.action,event.payload||{},identity.OPENID);
    return {ok:true,data};
  }catch(error){
    if(error.code&&['UNAUTHENTICATED','FORBIDDEN','INVALID_CODE','NOT_FOUND','PAUSED','NOT_STARTED','ENDED','EXPIRED','RETRY','INVALID_ACTION','INVALID_CONFIG','INVALID_RANDOM','CODE_NOT_READY','CHECKOUT_REQUIRED','POS_REQUIRED','POS_NOT_READY','COUPON_UNAVAILABLE','SOLD_OUT','POOL_ACTIVE','POOL_NOT_READY','POOL_CORRUPT','POOL_CONFIG_MISMATCH','FIXED_STOCK_EMPTY'].includes(error.code))return {ok:false,code:error.code,message:error.message};
    console.error('lottery infrastructure error', {code:error.errCode||error.code||'unknown'});
    return {ok:false,code:'SERVICE_UNAVAILABLE',message:'活动服务暂不可用，请重试或联系现场工作人员'};
  }
};
