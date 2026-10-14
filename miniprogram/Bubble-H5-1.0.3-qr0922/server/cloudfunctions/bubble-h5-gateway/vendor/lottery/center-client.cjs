const crypto=require('node:crypto');
function createCenterClient({baseUrl,centerId,environment,campaignId,token,fetchFn=fetch,allowLocalTest=false,physical=false}) {
  const origin=new URL(baseUrl);
  if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'||
    !(origin.protocol==='https:' || allowLocalTest&&environment==='development'&&origin.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(origin.hostname)))throw new Error('券中心必须使用 HTTPS 根地址');
  if(!centerId||!campaignId||typeof token!=='string'||token.length<32||(!allowLocalTest&&environment!=='production')||!['development','production'].includes(environment))throw new Error('券中心配置不完整');
  let verified=false;
  async function request(route,input) {
    const response=await fetchFn(new URL(route,origin),{method:input?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:input?JSON.stringify(input):undefined,redirect:'error',signal:AbortSignal.timeout(12000)});
    const result=await response.json();
    if(!response.ok||result.ok!==true)throw Object.assign(new Error('券中心暂不可用'),{code:result.code});
    return result.data;
  }
  async function verify(){
    if(verified)return;
    const info=await request('/v1/info');
    if(info.service!=='stall-coupon-center'||info.version!==1||info.role!=='lottery'||info.centerId!==centerId||info.environment!==environment)throw Object.assign(new Error('券中心身份不匹配'),{code:'CENTER_MISMATCH'});
    if(physical && !info.capabilities?.includes('physical-prize-v1'))throw Object.assign(new Error('券中心尚未支持实物核销'),{code:'CENTER_MISMATCH'});
    verified=true;
  }
  return {origin:origin.origin,async issue(owner,awardId,trustedCode){await verify();return request('/v1/coupons/issue',{campaignId,owner,awardId,...(physical?{trustedCode}:{}),requestId:'award:'+crypto.createHash('sha256').update(JSON.stringify([campaignId,owner,awardId])).digest('hex')});},
    async detail(owner,id){await verify();return request('/v1/coupons/detail',{owner,id});}};
}
module.exports={createCenterClient};
