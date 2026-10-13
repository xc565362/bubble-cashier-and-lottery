'use strict';
// Run on an authorized server. Credentials are read from a local file and never printed.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const prizes=[['cap','棒球帽',10],['bucket','渔夫帽',15],['waist','腰包',50],['tote','超大号购物袋',100]];
async function setup({baseUrl,adminToken,out,enableRedemption=false,fetchFn=fetch,now=Date.now}){
 const base=new URL(baseUrl);if(base.protocol!=='https:'||base.pathname!=='/'||base.username||base.password||base.search||base.hash)throw Error('需要纯 HTTPS 券中心地址');
 const post=async(route,payload)=>{const r=await fetchFn(new URL('/v1/'+route,base),{method:payload?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(12000),headers:{Authorization:'Bearer '+adminToken,'Content-Type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{})});const j=await r.json();if(!r.ok||!j.ok)throw Error(j.code||'CENTER_FAILED');return j.data;};
 const info=await post('info');if(info.role!=='admin'||info.environment!=='production'||!info.capabilities?.includes('physical-prize-v1'))throw Error('正式券中心未升级或管理权限不符');
 let config=fs.existsSync(out)?JSON.parse(fs.readFileSync(out,'utf8')):null;
 if(config&&(config.centerId!==info.centerId||config.baseUrl!==base.origin))throw Error('已有配置指向其他券中心，停止');
 if(enableRedemption){
  if(!config||Object.keys(config.prizes||{}).length!==4)throw Error('需要已核对的四项实物配置');
  for(const [id]of prizes)await post('campaigns/status',{id:config.prizes[id].campaignId,enabled:true,redemptionEnabled:true,requestId:crypto.randomUUID()});
  return {enabled:true,centerId:info.centerId};
 }
 if(now()>=Date.parse('2026-09-28T00:00:00+08:00'))throw Error('活动已截止，不能创建');
 config ||= {baseUrl:base.origin,centerId:info.centerId,environment:'production',stage:'migrating',handoffReadyAt:now()+600000,prizes:{}};
 for(const [id,name,quota]of prizes){
  const campaign=await post('campaigns',{requestId:'bubble-20260921-physical-campaign-'+id,name:'Bubble 实物奖品 · '+name,kind:'physical',physical:{prizeId:id,quantity:1},amountCents:0,minimumCents:0,quota,startsAt:'2026-09-17T00:00:00+08:00',expiresAt:'2026-09-28T00:00:00+08:00',redemptionEnabled:false});
  const key=await post('keys',{requestId:'bubble-20260921-physical-issuer-'+id,name:'Bubble 实物发奖 '+id,role:'lottery',campaignId:campaign.id});
  if(config.prizes[id]&&config.prizes[id].campaignId!==campaign.id)throw Error('原实物活动不匹配');
  config.prizes[id]={campaignId:campaign.id,token:key.token};
 }
 fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true,mode:0o700});
 const tmp=out+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(tmp,out);
 return {prepared:true,redemptionEnabled:false,configFile:path.resolve(out),handoffReadyAt:config.handoffReadyAt};
}
if(require.main===module){
 const a=process.argv.slice(2),get=k=>a[a.indexOf(k)+1];
 if(!['--base-url','--admin-token-file','--out'].every(k=>a.includes(k)&&get(k)&&!get(k).startsWith('--'))){console.error('用法: node setup-physical-center.cjs --base-url https://券中心 --admin-token-file 管理密钥文件 --out 私密配置文件 [--enable-redemption]');process.exitCode=1;}
 else setup({baseUrl:get('--base-url'),adminToken:fs.readFileSync(get('--admin-token-file'),'utf8').trim(),out:get('--out'),enableRedemption:a.includes('--enable-redemption')}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error('实物部署未完成：'+String(e.message).slice(0,140));process.exitCode=1;});
}
module.exports={setup};
