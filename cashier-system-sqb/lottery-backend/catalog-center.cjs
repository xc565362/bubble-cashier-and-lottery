'use strict';
const crypto=require('node:crypto');
function createCatalogCenter({config,fetchFn=fetch,allowLocalTest=false,now=Date.now}){
  const invalid=()=>{throw Object.assign(new Error('新奖品券中心尚未配置或升级'),{code:'CATALOG_UNSUPPORTED'});};
  let origin;try{origin=new URL(config?.baseUrl||'');}catch{invalid();}
  if(origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||!(origin.protocol==='https:'||allowLocalTest&&config.environment==='development'&&origin.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(origin.hostname))||!config.centerId||!String(config.adminToken||'').match(/^[A-Za-z0-9_.-]{32,300}$/))invalid();
  const environment=config.environment||'production';if(!['production','development'].includes(environment)||!allowLocalTest&&environment!=='production')invalid();
  const centerId=config.centerId,adminToken=config.adminToken;
  let verifiedInfo=null,verifiedUntil=0,verification=null;
  const clearVerified=()=>{verifiedInfo=null;verifiedUntil=0;};
  async function request(route,body){try{const response=await fetchFn(new URL(route,origin),{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(12000),headers:{Authorization:'Bearer '+adminToken,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});let result;try{result=await response.json();}catch{invalid();}if(!response.ok||result.ok!==true)throw Object.assign(new Error('奖品券中心请求未完成，请核对连接和容量'),{code:result.code||'CENTER_UNAVAILABLE'});return result.data;}catch(error){clearVerified();throw error;}}
  async function verify(){
    if(verifiedInfo&&now()<verifiedUntil)return verifiedInfo;
    if(verification)return verification;
    verification=(async()=>{try{const info=await request('/v1/info');if(info.service!=='stall-coupon-center'||info.centerId!==centerId||info.environment!==environment||info.role!=='admin'||!info.capabilities?.includes('lottery-catalog-v1'))invalid();verifiedInfo=info;verifiedUntil=now()+60000;return info;}catch(error){clearVerified();throw error;}finally{verification=null;}})();
    return verification;
  }
  return {origin:origin.origin,centerId,environment,request,verify,
    async issue(campaignId,owner,awardId,code){await verify();return request('/v1/lottery/issue',{campaignId,owner,awardId,...(code?{code}:{}),requestId:'catalog-'+crypto.createHash('sha256').update(JSON.stringify([campaignId,owner,awardId])).digest('hex')});},
    async detail(campaignId,owner,id){await verify();return request('/v1/lottery/coupons/detail',{campaignId,owner,id});}};
}
module.exports={createCatalogCenter};
