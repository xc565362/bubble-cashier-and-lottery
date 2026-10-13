'use strict';
const crypto = require('node:crypto');
const problem = () => Object.assign(new Error('收银券中心尚未配置或连接失败'), {code:'CENTER_UNAVAILABLE',status:503,gatewayFault:true});
function createScarfCenter({config,fetchFn=fetch,allowLocalTest=false,now=Date.now}) {
  let origin;
  try { origin=new URL(config?.baseUrl); } catch { throw problem(); }
  const environment=config.environment||'production';
  if(origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||!config.centerId||!/^[A-Za-z0-9_.-]{32,300}$/.test(config.adminToken||'')||!['production','development'].includes(environment)||(!allowLocalTest&&environment!=='production')||!(origin.protocol==='https:'||(allowLocalTest&&environment==='development'&&origin.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(origin.hostname)))) throw problem();
  const identity={centerId:config.centerId,environment};
  let verifiedUntil=0,verification;
  async function request(route,body) {
    try {
      const response=await fetchFn(new URL(route,origin),{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+config.adminToken,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
      const result=await response.json();
      if(!response.ok||result.ok!==true) throw problem();
      return result.data;
    } catch { verifiedUntil=0;throw problem(); }
  }
  async function verify() {
    if(now()<verifiedUntil)return identity;
    if(verification)return verification;
    verification=(async()=>{try{const info=await request('/v1/info');
      if(info.service!=='stall-coupon-center'||info.version!==1||info.centerId!==identity.centerId||info.environment!==environment||info.role!=='admin'||!info.capabilities?.includes('lottery-catalog-v1')) throw problem();
      verifiedUntil=now()+60000;return identity;
    }finally{verification=null;}})();return verification;
  }
  const requestId=value=>'scarf-'+crypto.createHash('sha256').update(value).digest('hex');
  return {...identity,verify,
    async provision({campaign,prize,total,requestId:operation,reason}) {
      await verify();
      const result=await request('/v1/campaigns/lottery-provision',{requestId:requestId('prepare:'+operation+':'+prize.id),campaignId:campaign.id,prize:{...prize,kind:'physical',amount:0},quota:total,startsAt:new Date(campaign.startsAt).toISOString(),expiresAt:new Date(campaign.redeemEndsAt).toISOString(),redemptionEndsAt:new Date(campaign.redeemEndsAt).toISOString()});
      const c=result?.campaign;
      if(!c?.id||c.kind!=='physical'||c.physical?.prizeId!==prize.id||c.lotteryCatalog?.campaignId!==campaign.id||['sku','barcode'].some(k=>(c.physical.product?.[k]||'')!==(prize.product[k]||''))) throw problem();
      if(c.quota<Math.max(1,total)) await request('/v1/campaigns/quota',{id:c.id,quota:Math.max(1,total),reason,requestId:requestId('quota:'+operation+':'+prize.id)});
      return {...identity,campaignId:c.id};
    },
    async issue({campaignId,owner,awardId,code}) {
      await verify();
      return request('/v1/lottery/issue',{requestId:requestId('issue:'+campaignId+':'+awardId),campaignId,owner,awardId,code});
    },
    async detail({campaignId,owner,id}) { await verify(); return request('/v1/lottery/coupons/detail',{campaignId,owner,id}); },
    async redeemed(campaignIds) {
      await verify(); let count=0;
      for(const id of new Set(campaignIds)) {const page=await request('/v1/coupons?campaignId='+encodeURIComponent(id)+'&state=REDEEMED'); if(!Number.isSafeInteger(page.total)||page.total<0)throw problem();count+=page.total;}
      return count;
    }
  };
}
module.exports={createScarfCenter};
