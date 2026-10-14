import campaign from './campaign.mjs';
const clone=value=>JSON.parse(JSON.stringify(value));
export function createPreview(storage,{now=Date.now,randomBit,randomRoll=()=>crypto.getRandomValues(new Uint32Array(1))[0]/4294967296,randomCode=()=>Array.from(crypto.getRandomValues(new Uint8Array(7)),v=>v.toString(16).padStart(2,'0')).join('').toUpperCase()}={}){
  const key='bubble-scarf-preview-v1';let offline=false,forced='',queue=Promise.resolve();
  const read=()=>{let data;try{data=JSON.parse(storage.getItem(key)||'null');}catch{}return {entry:null,remaining:campaign.totalStock,invites:{},config:clone(campaign),fulfillment:'legacy',...data};};
  const write=data=>storage.setItem(key,JSON.stringify(data));
  const issue=data=>{const inviteCode='DE'+randomCode();data.invites[inviteCode]={expiresAt:now()+600000,used:false};return {inviteCode,expiresAt:data.invites[inviteCode].expiresAt};};
  const frame=data=>({campaign:{...clone(data.config),rulesText:typeof data.config.rulesText==='string'?data.config.rulesText:''},prize:clone(data.config.prize),entry:clone(data.entry),inventory:{total:data.config.totalStock,remaining:data.remaining},requiresInvite:true,availability:{canDraw:!data.entry&&!forced&&data.remaining>0,reason:data.entry?'ALREADY_DRAWN':forced||(!data.remaining?'SOLD_OUT':'READY')}});
  return {
    isPreview:true,hasSession:()=>true,isOffline:()=>offline,
    launchInvite(){const data=read();const existing=Object.entries(data.invites).find(([,v])=>!v.used&&v.expiresAt>now());if(existing)return existing[0];const grant=issue(data);write(data);return grant.inviteCode;},
    async call(action,payload={}){const work=()=>{
      if(offline)throw new Error('演示断网，恢复连接后可重新确认结果');
      const data=read();
      if(action==='identity')return {isAdmin:true};
      if(action==='state')return frame(data);
      if(action==='grant'){const grant=issue(data);write(data);return grant;}
      if(action==='draw'){
        if(data.entry)return frame(data);
        if(forced||data.remaining<=0)throw new Error('当前不开放抽奖，参与资格未消耗');
        const code=String(payload.inviteCode||'').toUpperCase(),invitation=data.invites[code];
        if(!invitation||invitation.used||invitation.expiresAt<=now())throw new Error('参与码已失效，请让工作人员重新确认');
        const won=(randomBit?randomBit()/2:randomRoll())*10000<data.config.winProbabilityBps;invitation.used=true;
        data.entry={outcome:won?'won':'lost',status:won?'pending':'lost',code:won?'DE'+randomCode():'',createdAt:now(),expiresAt:data.config.redeemEndsAt,prize:clone(data.config.prize),fulfillment:data.fulfillment,fulfillmentStatus:data.fulfillment==='cashier'?'ready':'legacy'};
        if(won)data.remaining--;write(data);return frame(data);
      }
      if(action==='lookup'||action==='redeem'){
        const code=String(payload.code||'').replace(/[\s-]/g,'').toUpperCase();
        if(!data.entry||data.entry.outcome!=='won'||code!==data.entry.code)throw new Error('未找到此演示领取码');
        const alreadyRedeemed=data.entry.status==='redeemed';
        if(action==='redeem'){if(data.entry.fulfillment==='cashier')throw new Error('请到收银系统核销此凭证');if(!['pending','redeemed'].includes(data.entry.status))throw new Error('此凭证不可领取');if(!alreadyRedeemed){data.entry.status='redeemed';data.entry.redeemedAt=now();write(data);}}
        return {entry:clone(data.entry),prize:clone(data.entry.prize||campaign.prize),campaign:clone(data.config),alreadyRedeemed};
      }
      throw new Error('不支持此操作');
    };const pending=queue.then(work);queue=pending.catch(()=>{});return pending;},
    scenario(name){offline=false;forced='';const data=read();if(name==='offline'){offline=true;return;}if(name==='online')return;
      if(name==='not_started'){forced='NOT_STARTED';data.entry=null;}
      else if(name==='sold_out'){data.remaining=0;data.entry=null;}
      else if(name==='empty'){data.entry=null;data.remaining=data.config.totalStock;}
      else {const lost=name==='lost';data.entry={outcome:lost?'lost':'won',status:lost?'lost':name==='won'?'pending':name,code:lost?'':'DE00000000000050',createdAt:now(),expiresAt:name==='expired'?now()-1:null,redeemedAt:name==='redeemed'?now():null,prize:clone(data.config.prize),fulfillment:data.fulfillment,fulfillmentStatus:data.fulfillment==='cashier'?'ready':'legacy'};data.remaining=lost?data.config.totalStock:Math.max(0,data.config.totalStock-1);}
      write(data);
    },
    configure({title,venue,prize,winProbabilityBps,total,fulfillment,rulesText}={}){
      const data=read(),issued=data.config.totalStock-data.remaining;
      if(rulesText!==undefined){if(typeof rulesText!=='string')throw new Error('活动说明须为文本');const lines=rulesText.replace(/\r\n?/g,'\n');rulesText=lines.trim();if(rulesText.length>5000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(lines))throw new Error('活动说明不正确');}
      if(winProbabilityBps!==undefined&&(!Number.isInteger(winProbabilityBps)||winProbabilityBps<0||winProbabilityBps>10000))throw new Error('中奖概率不正确');
      if(total!==undefined&&(!Number.isSafeInteger(total)||total<issued))throw new Error('总奖品数不能小于已中奖数量');
      data.config={...data.config,...(title!==undefined?{title}:{}),...(venue!==undefined?{venue}:{}),...(rulesText!==undefined?{rulesText}:{}),...(prize?{prize:clone(prize)}:{}),...(winProbabilityBps!==undefined?{winProbabilityBps}:{}),...(total!==undefined?{totalStock:total}:{})};
      if(total!==undefined)data.remaining=total-issued;if(['legacy','cashier'].includes(fulfillment))data.fulfillment=fulfillment;
      write(data);return frame(data);
    },
    reset(){offline=false;forced='';storage.removeItem(key);}
  };
}
