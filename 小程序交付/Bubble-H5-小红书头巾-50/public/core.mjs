export const CODE_PATTERN=/^[0-9a-z]{16}$/i;
export const INVITE_PATTERN=/^[0-9a-f]{16}$/i;
export const DEFAULT_PRIZE_IMAGE='./assets/scarf.svg';
export function prizeImage(value){
  if(value===DEFAULT_PRIZE_IMAGE)return value;
  if(typeof value!=='string'||!/^https:\/\//i.test(value))return DEFAULT_PRIZE_IMAGE;
  try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:DEFAULT_PRIZE_IMAGE;}catch{return DEFAULT_PRIZE_IMAGE;}
}
export function campaignView(state={}){
  const c=state.campaign||{},prize=state.prize||{},bps=c.winProbabilityBps;
  return {title:c.title||'山野好礼',venue:c.venue||'请咨询现场工作人员',prize:{id:prize.id||'',name:prize.name||'活动奖品',imageUrl:prizeImage(prize.imageUrl)},probability:Number.isInteger(bps)&&bps>=0&&bps<=10000?String(bps/100):'待公布',total:Number.isSafeInteger(state.inventory?.total)&&state.inventory.total>=0?state.inventory.total:'待公布'};
}
// Historical entries predate the catalog and always awarded the original scarf.
// Never derive their prize from the currently configured catalog.
export function entryPrize(entry){const prize=entry?.prize||{id:'scarf',name:'魔术头巾'};return {...prize,name:prize.name||'活动奖品',imageUrl:prizeImage(prize.imageUrl)};}
export const escapeHtml=(value='')=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function dateLabel(value){if(!value||!Number.isFinite(new Date(value).getTime()))return '时间待公布';return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value));}
export function safeEntry(value,fresh=true,now=Date.now()){
  if(!value)return null;
  const outcome=value.outcome==='won'?'won':'lost';
  let status=outcome==='lost'?'lost':['pending','issuing','reserved','redeemed','expired','unavailable'].includes(value.status)?value.status:'unavailable';
  if(status==='pending'&&value.expiresAt&&new Date(value.expiresAt).getTime()<=now)status='expired';
  if(status==='pending'&&(!fresh||!CODE_PATTERN.test(value.code||'')))status='unavailable';
  const code=outcome==='won'&&status==='pending'?value.code:'';
  return {...value,outcome,status,code,formattedCode:code?(code.match(/.{1,4}/g)||[]).join(' '):'',statusLabel:{lost:'本次未中奖',pending:'待领取',issuing:'领取码准备中',reserved:'收银台核销中',redeemed:'已核销',expired:'已过期',unavailable:'领取状态待确认'}[status]};
}
export function parseLaunch(hash){
  const [raw,query='']=String(hash||'').replace(/^#\/?/,'').split('?');
  const params=new URLSearchParams(query);const valid=r=>['home','result','rules','staff'].includes(r);
  const route=valid(raw)?raw:'home',back=(params.get('return_route')||'').replace(/^\//,'');
  const invite=(params.get('inviteCode')||'').replace(/[\s-]/g,'').toUpperCase();
  return {route:valid(back)?back:route,code:params.get('wx_code')||'',inviteCode:INVITE_PATTERN.test(invite)?invite:''};
}
export const reasonLabel=reason=>({NOT_CONFIGURED:'活动时间尚未公布',PAUSED:'活动暂未开放',NOT_STARTED:'活动还未开始',ENDED:'本次活动已结束',SOLD_OUT:'本期奖品已抽完',ALREADY_DRAWN:'你已参与本次抽奖',READY:''}[reason]||'活动暂不可用');
export function createEpoch(){let value=0;return {next:()=>++value,current:()=>value,isCurrent:token=>value===token};}
