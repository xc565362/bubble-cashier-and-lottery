'use strict';
const crypto=require('node:crypto');
const {CAMPAIGN_ID,TOTAL_STOCK,COLLECTIONS,PRIZE,publicCampaign}=require('./service.cjs');
const MANAGEMENT_COLLECTION='bubble_scarf_management';
const fail=(code,message,status=400)=>{throw Object.assign(new Error(message),{code,status,gatewayFault:true});};
const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
const only=(value,keys)=>record(value)&&Object.keys(value).every(key=>keys.includes(key));
const stable=value=>Array.isArray(value)?value.map(stable):record(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const digest=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(stable(value))).digest('hex');
function text(value,label,max=100,optional=false){if(typeof value!=='string'||(!optional&&!value.trim())||value.length>max||/[\u0000-\u001f]/.test(value))fail('INVALID_REQUEST',label+'不正确');return value.trim();}
function rulesText(value){
  if(typeof value!=='string')fail('INVALID_REQUEST','活动说明须为文本');
  const lines=value.replace(/\r\n?/g,'\n'),normalized=lines.trim();
  if(normalized.length>5000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(lines))fail('INVALID_REQUEST','活动说明最多5000字，不能包含无效控制字符');
  return normalized;
}
function time(value){if(value==null||value==='')return null;const v=typeof value==='string'?Date.parse(value):value;if(!Number.isSafeInteger(v)||v<=0)fail('INVALID_TIME','活动时间不正确');return v;}
const validTimes=c=>Number.isSafeInteger(c.startsAt)&&Number.isSafeInteger(c.endsAt)&&Number.isSafeInteger(c.redeemEndsAt)&&c.startsAt>0&&c.startsAt<c.endsAt&&c.endsAt<=c.redeemEndsAt;
function createManagementService({store,center,key,now=Date.now}) {
  const records=require('./draw-records.cjs').createDrawRecords({readPage:store.readEntries,campaignId:CAMPAIGN_ID,mode:'scarf',key,center,now});
  async function read(tx){return {campaign:await tx.get(COLLECTIONS.campaigns,CAMPAIGN_ID),inventory:await tx.get(COLLECTIONS.inventory,CAMPAIGN_ID)};}
  const defaults=()=>({total:TOTAL_STOCK,remaining:TOTAL_STOCK,awarded:0,redeemed:0,legacyRedeemed:0});
  async function snapshot(input){
    const {campaign,inventory}=input||await store.transaction(read);
    let ready=false;let redeemed=inventory?.redeemed||0;
    const bound=campaign?.centerIdentity||campaign?.center;
    if(center)try{
      if(bound&&(bound.centerId!==center.centerId||bound.environment!==center.environment))throw new Error('Center identity mismatch');
      await center.verify();ready=true;
      const history=campaign?.centerHistory||[];
      if(history.length&&center.redeemed)redeemed=(inventory?.legacyRedeemed||0)+await center.redeemed(history);
    }catch{ready=false;}
    return {service:'bubble-scarf-management',version:1,capabilities:['rules-text-v1',...(typeof store.readEntries==='function'?['draw-records-v1']:[])],campaignId:CAMPAIGN_ID,revision:campaign?.revision||0,campaign:publicCampaign(campaign),prize:campaign?.prize||{...PRIZE,product:null},inventory:{total:inventory?.total??TOTAL_STOCK,remaining:inventory?.remaining??TOTAL_STOCK,awarded:inventory?.awarded||0,redeemed},fulfillment:{ready,centerId:center?.centerId||'',environment:center?.environment||''},audit:campaign?.audit||[]};
  }
  return async function management(action,payload={}){
    if(action==='records')return records(payload);
    if(action==='snapshot'){if(!only(payload,[]))fail('INVALID_REQUEST','请求参数无效');return snapshot();}
    if(action!=='update')fail('INVALID_ACTION','不支持此管理操作');
    if(!only(payload,['revision','requestId','operation','reason','campaign','prize','total'])||!Number.isSafeInteger(payload.revision)||payload.revision<0||typeof payload.requestId!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(payload.requestId)||!['pause','resume','configure'].includes(payload.operation))fail('INVALID_REQUEST','修改请求不正确');
    const reason=text(payload.reason,'修改原因',200),fingerprint=digest(payload),operationId='operation-'+digest(payload.requestId);
    const initial=await store.transaction(async tx=>{
      const prior=await tx.get(MANAGEMENT_COLLECTION,operationId);
      if(prior){if(prior.fingerprint!==fingerprint)fail('REQUEST_CONFLICT','此操作编号已用于其他修改',409);return {replayed:true};}
      const current=await read(tx);
      if((current.campaign?.revision||0)!==payload.revision)fail('REVISION_CONFLICT','活动已由其他终端修改，请刷新后重试',409);
      return current;
    });
    if(initial.replayed)return snapshot();
    const before=initial.campaign;
    const identity=before?.centerIdentity||before?.center;
    if(identity&&center&&(identity.centerId!==center.centerId||identity.environment!==center.environment))fail('CENTER_MISMATCH','请恢复原券中心连接，不能将活动换到其他券中心',409);
    const campaign={...publicCampaign(before),...before,rulesText:publicCampaign(before).rulesText,managed:true,revision:payload.revision+1,audit:[...(before?.audit||[])],centerHistory:[...(before?.centerHistory||[])]};
    if(identity)campaign.centerIdentity={centerId:identity.centerId,environment:identity.environment};
    const inventory=initial.inventory?{...initial.inventory}:defaults();
    if(!before?.managed)inventory.legacyRedeemed=inventory.redeemed;
    if(payload.operation==='configure'){
      if(before?.enabled)fail('PAUSE_REQUIRED','请先暂停活动再修改奖品和概率',409);
      if(!only(payload.campaign,['title','venue','startsAt','endsAt','redeemEndsAt','winProbabilityBps','rulesText'])||!only(payload.prize,['id','name','imageUrl','product']))fail('INVALID_REQUEST','奖品或活动内容不完整');
      const c=payload.campaign;
      if(Object.hasOwn(c,'rulesText'))campaign.rulesText=rulesText(c.rulesText);
      campaign.title=text(c.title,'活动名称',60);campaign.venue=text(c.venue,'活动地点',100);
      campaign.startsAt=time(c.startsAt);campaign.endsAt=time(c.endsAt);campaign.redeemEndsAt=time(c.redeemEndsAt);
      if(![campaign.startsAt,campaign.endsAt,campaign.redeemEndsAt].every(v=>v===null)&&!validTimes(campaign))fail('INVALID_TIME','请完整填写开始、结束与兑奖截止时间，并核对先后顺序');
      if(!Number.isSafeInteger(c.winProbabilityBps)||c.winProbabilityBps<0||c.winProbabilityBps>10000)fail('INVALID_PROBABILITY','中奖概率须为0至100%，最多两位小数');
      campaign.winProbabilityBps=c.winProbabilityBps;
      if(!Number.isSafeInteger(payload.total)||payload.total<inventory.awarded||payload.total>1000000)fail('INVALID_STOCK','总名额不能少于已经中奖的份数，最多1000000份');
      inventory.total=payload.total;inventory.remaining=payload.total-inventory.awarded;
      const p=payload.prize,product=p.product;
      if(!only(product,['id','name','sku','barcode']))fail('INVALID_PRODUCT','请选择收银系统中的实物商品');
      const normalized={id:text(product.id,'商品编号',120),name:text(product.name,'商品名称',120),sku:text(product.sku||'','SKU',100,true),barcode:text(product.barcode||'','条码',100,true)};
      if(!normalized.sku&&!normalized.barcode)fail('INVALID_PRODUCT','绑定商品至少需要SKU或条码');
      let imageUrl=text(p.imageUrl||'','图片地址',2000,true);
      if(imageUrl){let u;try{u=new URL(imageUrl);}catch{fail('INVALID_IMAGE','图片请使用HTTPS地址');}if(u.protocol!=='https:'||u.username||u.password)fail('INVALID_IMAGE','图片请使用HTTPS地址');imageUrl=u.href;}
      const name=text(p.name,'奖品名称',60);
      const changed=!before?.managed||!before?.prize||['sku','barcode'].some(k=>(before.prize.product?.[k]||'')!==normalized[k])||before.startsAt!==campaign.startsAt||before.redeemEndsAt!==campaign.redeemEndsAt;
      const id=changed?'scarf_'+digest(payload.requestId+':'+fingerprint).slice(0,24):before.prize.id;
      campaign.prize={id,name,imageUrl,product:normalized};campaign.enabled=false;
      if(changed)delete campaign.center;
      if(validTimes(campaign)&&center){
        campaign.center=await center.provision({campaign,prize:campaign.prize,total:inventory.total,requestId:payload.requestId,reason});
        if(campaign.center.centerId!==center.centerId||campaign.center.environment!==center.environment||!campaign.center.campaignId)fail('CENTER_MISMATCH','券中心返回身份不一致',503);
        campaign.centerIdentity={centerId:center.centerId,environment:center.environment};
        if(!campaign.centerHistory.includes(campaign.center.campaignId))campaign.centerHistory.push(campaign.center.campaignId);
      }
    }else{
      if(payload.campaign!==undefined||payload.prize!==undefined||payload.total!==undefined)fail('INVALID_REQUEST','暂停或恢复请求不能同时修改配置');
      campaign.enabled=payload.operation==='resume';
      if(campaign.enabled){
        if(!before?.managed||!validTimes(campaign)||!campaign.prize?.product||!center)fail('NOT_CONFIGURED','请先保存奖品、商品绑定、活动时间及券中心连接');
        if(campaign.endsAt<=now())fail('ENDED','活动时间已结束，请先修改时间');
        if(inventory.remaining<=0)fail('SOLD_OUT','剩余名额为零，请先增加名额');
        await center.verify();
        if(!campaign.center)campaign.center=await center.provision({campaign,prize:campaign.prize,total:inventory.total,requestId:payload.requestId,reason});
        if(campaign.center.centerId!==center.centerId||campaign.center.environment!==center.environment)fail('CENTER_MISMATCH','当前券中心与中奖记录不一致');
        campaign.centerIdentity={centerId:center.centerId,environment:center.environment};
        if(!campaign.centerHistory.includes(campaign.center.campaignId))campaign.centerHistory.push(campaign.center.campaignId);
      }
    }
    const beforeRules=publicCampaign(before).rulesText,afterRules=campaign.rulesText;
    // Keep the bounded audit small even when each revision has a long rules body.
    campaign.audit.push({at:now(),requestId:payload.requestId,operation:payload.operation,reason,revision:campaign.revision,rulesTextChanged:beforeRules!==afterRules,before:{enabled:before?.enabled||false,total:initial.inventory?.total??TOTAL_STOCK,winProbabilityBps:before?.winProbabilityBps??5000,prizeId:before?.prize?.id||'scarf',rulesTextSummary:{length:beforeRules.length,sha256:digest(beforeRules)}},after:{enabled:campaign.enabled,total:inventory.total,winProbabilityBps:campaign.winProbabilityBps,prizeId:campaign.prize?.id||'scarf',rulesTextSummary:{length:afterRules.length,sha256:digest(afterRules)}}});
    campaign.audit=campaign.audit.slice(-100);
    await store.transaction(async tx=>{
      const prior=await tx.get(MANAGEMENT_COLLECTION,operationId);
      if(prior){if(prior.fingerprint!==fingerprint)fail('REQUEST_CONFLICT','操作编号冲突',409);return;}
      const current=await read(tx);
      if((current.campaign?.revision||0)!==payload.revision)fail('REVISION_CONFLICT','活动已由其他终端修改，请刷新后重试',409);
      // Pause/resume may race a draw; never overwrite the transaction's newer counters.
      const latest=current.inventory||inventory;
      if(payload.operation==='configure'&&latest.awarded!==inventory.awarded)fail('REVISION_CONFLICT','中奖记录已更新，请刷新后重试',409);
      const nextInventory=payload.operation==='configure'?{...latest,total:inventory.total,remaining:inventory.total-latest.awarded,legacyRedeemed:before?.managed?latest.legacyRedeemed:latest.redeemed}:{...latest,legacyRedeemed:before?.managed?latest.legacyRedeemed:latest.redeemed};
      await tx.set(COLLECTIONS.campaigns,CAMPAIGN_ID,campaign);await tx.set(COLLECTIONS.inventory,CAMPAIGN_ID,nextInventory);
      await tx.set(MANAGEMENT_COLLECTION,operationId,{fingerprint,revision:campaign.revision,createdAt:now()});
    });
    return snapshot();
  };
}
function createManagementHttp({store,key,center,now=Date.now}){
  if(!/^[a-f0-9]{64}$/.test(key||''))fail('INVALID_CONFIG','头巾管理密钥尚未配置',503);
  const call=createManagementService({store,center,key,now});
  return async event=>{
    const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
    try{
      if(event?.path!=='/api/scarf-management')fail('NOT_FOUND','接口不存在',404);
      if(event.httpMethod!=='POST')fail('METHOD_NOT_ALLOWED','请使用POST请求',405);
      const h={};for(const [k,v]of Object.entries(event.headers||{})){if(typeof v!=='string'||Object.hasOwn(h,k.toLowerCase()))fail('INVALID_REQUEST','请求头无效');h[k.toLowerCase()]=v;}
      if(Object.hasOwn(h,'origin'))fail('SERVER_ONLY','管理接口仅供收银后台调用',403);
      if(!/^application\/json(?:\s*;|$)/i.test(h['content-type']||'')||typeof event.body!=='string'||event.body.length>45000)fail('INVALID_REQUEST','请求格式不正确');
      const body=event.isBase64Encoded?Buffer.from(event.body,'base64').toString('utf8'):event.body;
      if(Buffer.byteLength(body)>32768)fail('INVALID_REQUEST','请求内容过大');
      const timestamp=h['x-lottery-time'],nonce=h['x-lottery-nonce'],signature=h['x-lottery-signature'];
      if(!/^\d{13}$/.test(timestamp||'')||Math.abs(now()-Number(timestamp))>60000||!/^[A-Za-z0-9_-]{16,100}$/.test(nonce||'')||!/^[a-f0-9]{64}$/.test(signature||''))fail('UNAUTHORIZED','管理签名已失效',401);
      const expected=crypto.createHmac('sha256',key).update(timestamp+'\n'+nonce+'\n'+body).digest();
      if(!crypto.timingSafeEqual(expected,Buffer.from(signature,'hex')))fail('UNAUTHORIZED','管理签名不正确',401);
      let input;try{input=JSON.parse(body);}catch{fail('INVALID_REQUEST','请求不是有效JSON');}
      if(!only(input,['campaignId','action','payload'])||input.campaignId!==CAMPAIGN_ID)fail('INVALID_CAMPAIGN','活动身份不匹配');
      await store.transaction(async tx=>{const id='nonce-'+digest(nonce);if(await tx.get(MANAGEMENT_COLLECTION,id))fail('REPLAYED','此签名请求已使用，请重新发起',409);await tx.set(MANAGEMENT_COLLECTION,id,{expiresAt:new Date(now()+120000)});});
      return {statusCode:200,headers,body:JSON.stringify({ok:true,data:await call(input.action,input.payload)})};
    }catch(error){return {statusCode:error.gatewayFault?error.status:503,headers,body:JSON.stringify({ok:false,code:error.gatewayFault?error.code:'SERVICE_UNAVAILABLE',error:error.gatewayFault?error.message:'管理服务暂时不可用，请刷新核对后重试'})};}
  };
}
module.exports={createManagementService,createManagementHttp,MANAGEMENT_COLLECTION};
