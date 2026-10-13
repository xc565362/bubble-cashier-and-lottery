import {escapeHtml as e,dateLabel,safeEntry,parseLaunch,createEpoch,CODE_PATTERN,INVITE_PATTERN,reasonLabel,prizeImage,campaignView,entryPrize} from './core.mjs';
import {createApi} from './api.mjs';
import {drawQr,drawBarcode} from './qr.mjs';
import {createWheel} from './wheel.mjs';

const runtime=window.BUBBLE_H5_CONFIG||{},main=document.querySelector('#main'),modal=document.querySelector('#modal');
const launch=parseLaunch(location.hash);
history.replaceState(null,'',location.pathname+location.search+`#/${launch.route}`);
const localPreview=runtime.mode==='preview'&&['localhost','127.0.0.1','[::1]'].includes(location.hostname);
const api=localPreview?(await import('./preview.mjs')).createPreview(sessionStorage):createApi(runtime);
const epoch=createEpoch();
const S={route:launch.route,invite:launch.inviteCode||(api.isPreview?api.launchInvite():''),inviteDraft:'',state:null,loading:true,error:'',busy:false,drawing:false,mode:'qr',identity:null,staffCode:'',staffResult:null,grant:null,previewOpen:false,scenario:'empty'};
let refreshTimer,toastTimer,resolveModal,scanStream,scanTimer,scanGeneration=0,wheel=null;
const button=(label,action,kind='primary',disabled=false)=>`<button class="${kind}" data-action="${action}" ${disabled?'disabled':''}>${label}</button>`;
const art=(cls='reward-art',prize=campaignView(S.state||{}).prize)=>`<img class="${cls}" data-prize-image src="${e(prizeImage(prize.imageUrl))}" alt="${e(prize.name)}示意，款式以现场实物为准">`;
const heading=(title,copy)=>`<header class="page-heading"><h1 class="page-title">${title}</h1><p class="page-subtitle">${copy}</p></header>`;
const offline=()=>!navigator.onLine||!!api.isOffline?.();
const isAuthError=err=>['AUTH_REQUIRED','INVALID_TOKEN','TOKEN_EXPIRED'].includes(err.code);
const current=ticket=>epoch.isCurrent(ticket)&&!document.hidden&&!offline();
function toast(message){clearTimeout(toastTimer);const target=document.querySelector('#toast');target.textContent=message;target.hidden=false;toastTimer=setTimeout(()=>target.hidden=true,3200);}
function stopRefresh(){clearTimeout(refreshTimer);refreshTimer=null;}
function canRefresh(){return api.hasSession()&&!document.hidden&&!offline()&&!S.loading&&!S.busy&&!S.drawing&&!S.previewOpen&&!modal.open&&!document.activeElement?.matches?.('input,textarea,select,[contenteditable="true"]');}
function schedule(){stopRefresh();const interval=S.route==='result'&&S.state?.entry&&['pending','issuing','reserved','unavailable'].includes(S.state.entry.status)?3000:['home','rules'].includes(S.route)?10000:0;if(interval&&api.hasSession()&&!document.hidden&&!offline())refreshTimer=setTimeout(()=>{if(!api.hasSession()){authFailure(Object.assign(new Error('登录已失效，请从小程序重新进入活动'),{code:'AUTH_REQUIRED'}));render();return;}canRefresh()?load(true):schedule();},interval);}
function authFailure(err){if(isAuthError(err)){epoch.next();api.logout?.();S.state=null;S.identity=null;S.staffResult=null;S.staffCode='';S.grant=null;S.error=err.message;S.loading=false;closeModal(false);}}
function invalidate(){epoch.next();wheel?.cancel();S.wheelIndex=null;stopRefresh();closeModal(false);if(S.state?.entry)S.state={...S.state,entry:safeEntry(S.state.entry,false)};S.staffResult=null;S.staffCode='';S.grant=null;document.querySelector('#offline-banner').hidden=!offline();render();}

function previewTools(){if(!api.isPreview)return '';const options={empty:'未参与',won:'中奖 · 待领取',lost:'未中奖',issuing:'领取码准备中',reserved:'收银台核销中',redeemed:'已核销',expired:'已过期',sold_out:'奖品已抽完',not_started:'活动未开始',offline:'模拟断网',online:'恢复连接'};return `<details class="preview-tools" ${S.previewOpen?'open':''}><summary>演示设置</summary><div class="preview-controls"><p>仅本机演示，已模拟工作人员确认关注。中奖概率以活动说明为准；也可直接查看各种结果。</p><label for="scenario">查看不同状态</label><select id="scenario">${Object.entries(options).map(([value,label])=>`<option value="${value}" ${value===S.scenario?'selected':''}>${label}</option>`).join('')}</select>${button('应用演示状态','scenario','secondary')}${button('重置本机演示','reset','text-button')}</div></details>`;}
function home(){
  const state=S.state,entry=state.entry,available=state.availability?.canDraw,view=campaignView(state);
  const timing=state.campaign?.startsAt&&state.campaign?.endsAt?`${dateLabel(state.campaign.startsAt)} 至 ${dateLabel(state.campaign.endsAt)}`:'活动时间待公布';
  const chance=view.probability==='待公布'?'待公布':`${view.probability}%`;
  const action=entry?'查看我的结果':S.drawing?'抽奖中…':available?'立即抽奖':reasonLabel(state.availability?.reason);
  const cells=Array.from({length:8},(_,index)=>`<div class="wheel-cell ${index%2?'wheel-thanks':'wheel-prize'} ${S.wheelIndex===index&&(S.drawing||entry)?'is-active':''}" data-wheel-cell="${index}">${index%2?'<span class="wheel-thanks-mark" aria-hidden="true">⌁</span><span>谢谢惠顾</span>':`${art('wheel-prize-art',view.prize)}<span>${e(view.prize.name)}</span>`}</div>`).join('');
  return `<section class="hero grid-hero"><p class="eyebrow">${e(view.title)} · 关注抽好礼</p><h1 class="hero-title">奔向山野，<br><span>遇见小小好运。</span></h1><p class="hero-copy">关注小红书，让一份好礼陪你奔向下一程。</p></section>
    <section class="draw-panel grid-draw-panel" aria-label="参与抽奖">
      <div class="lottery-meta"><p><strong>${e(chance)}</strong> 中奖机会</p><span>好礼共 ${e(view.total)} 份</span></div>
      ${!entry&&!S.invite?`<label class="field-label" for="invite-code">工作人员提供的参与码</label><input id="invite-code" class="invite-input input" value="${e(S.inviteDraft||'')}" autocomplete="off" spellcheck="false" maxlength="24" placeholder="扫码进入，或在此输入参与码">`:''}
      <div class="lottery-grid ${S.drawing?'is-drawing':''}" role="group" aria-label="九宫格抽奖，四格奖品，四格谢谢惠顾" aria-busy="${S.drawing}">${cells}<button class="wheel-start" data-action="${entry?'open-result':'draw'}" ${S.busy||S.drawing||(!entry&&!available)?'disabled':''}><strong>${e(action)}</strong><small>${entry?'结果已保存':S.drawing?'好运正在转动':available?'试试今日手气':'请留意活动说明'}</small></button></div>
      <p class="eligibility-note" role="status">${S.drawing?'正在揭晓好运，请稍候…':entry?'本次参与结果已保存':S.invite?'参与码已就绪 · 每人 1 次机会':'请先向工作人员出示小红书关注页面'}</p>
      <p class="fineprint">有库存时每次中奖概率 ${e(chance)}${view.probability==='100'?'。':'，也有可能未中奖。'}<br>${e(view.total)} 份抽完即止 · ${e(timing)}</p>
    </section><section class="steps" aria-label="参与步骤"><div class="step"><span class="step-no">01</span><h3 class="step-title">关注小红书</h3><p class="step-copy">向工作人员出示关注页</p></div><div class="step"><span class="step-no">02</span><h3 class="step-title">扫码抽好礼</h3><p class="step-copy">确认后获取一次抽奖机会</p></div><div class="step"><span class="step-no">03</span><h3 class="step-title">凭码领好礼</h3><p class="step-copy">中奖后现场核销领取</p></div></section><p class="art-note">奖品图片仅为示意，款式以现场实物为准。</p><a class="inline-link" href="#/rules">查看完整活动说明 ↗</a>`;
}
function result(){
  const entry=S.state.entry;
  const head=heading('我的山野好礼','每一次相遇，都为下一程留下期待。');
  if(!entry)return head+`<section class="empty-state"><div class="result-symbol" aria-hidden="true">✧</div><h2 class="result-title">好运，还没有揭晓</h2><p class="result-copy">请先完成关注确认，再来试试今天的手气。</p><a class="primary" href="#/home">去抽一份好礼</a></section>`;
  if(entry.outcome==='lost')return head+`<section class="empty-state"><div class="result-symbol" aria-hidden="true">⌁</div><h2 class="result-title">这次，和好运擦肩。</h2><p class="result-copy">本次未抽中奖品。<br>谢谢你的关注，期待再次在山野相遇。</p><p class="hint">本次机会已使用，刷新页面不会重新抽奖。</p><a class="secondary" href="#/rules">查看活动说明</a></section>`;
  const prize=entryPrize(entry),cashier=entry.fulfillment==='cashier';
  const credentials=entry.status==='pending'?`<div class="code-modes" aria-label="领取码展示方式"><button class="code-mode ${S.mode==='qr'?'active':''}" data-action="qr" aria-pressed="${S.mode==='qr'}">二维码</button><button class="code-mode ${S.mode==='barcode'?'active':''}" data-action="barcode" aria-pressed="${S.mode==='barcode'}">条形码</button></div><div class="code-display"><canvas class="${S.mode==='qr'?'qr':'barcode'}-canvas" role="img" aria-label="奖品领取${S.mode==='qr'?'二维码':'条形码'}"></canvas></div><div class="code" data-testid="award-code">${e(entry.formattedCode)}</div>${button('复制领取码','copy-award','copy')}<p class="hint">${cashier?'请到现场收银台出示此码，0 元核销领取。':'请向工作人员出示，核销后领取 1 份。'}<br>领取码仅限使用一次，请勿转发。</p>`:`<h3 class="result-title">${e(entry.statusLabel)}</h3><p class="hint">${entry.status==='redeemed'?'奖品已领取，愿它陪你走过更多山野。':entry.status==='expired'?'已超过领取时间，请联系现场工作人员。':entry.status==='issuing'?'中奖结果已保留，正在准备领取码，请稍候。':entry.status==='reserved'?'收银台正在核销，请稍候。完成后将自动更新领取状态。':'正在重新确认状态，请恢复连接后刷新。'}</p>`;
  return head+`<section class="ticket"><div class="ticket-top"><span class="tag">${e(entry.statusLabel)}</span>${art('reward-art',prize)}<h2 class="prize-title">${e(prize.name)} × 1</h2><p class="ticket-subtitle">一份山野好礼，属于你。</p></div><div class="ticket-bottom">${credentials}${api.isPreview?'<p class="hint">演示凭证 · 不可实际领取</p>':''}</div></section><section class="detail-box"><div class="detail-row"><span>领取地点</span><strong>${e(campaignView(S.state).venue)}</strong></div><div class="detail-row"><span>领取截止</span><strong>${e(dateLabel(entry.expiresAt))}</strong></div><p>领取状态每 3 秒更新。完成核销后凭证失效，不可重复领取。</p>${button('刷新领取状态','refresh','secondary')}</section>`;
}
function rules(){
  const c=S.state.campaign||{},view=campaignView(S.state),chance=view.probability==='待公布'?'待公布':`${view.probability}%`;
  const customRules=typeof c.rulesText==='string'?c.rulesText.trim():'';
  const defaultRules=`<h2>怎样参与</h2><p>在越野赛事现场关注工作人员指定的小红书账号，并出示关注页面。工作人员确认后，出示参与码供你扫码进入活动。</p><p>每个微信账号在本次活动中限参与 1 次；一次性参与码使用后失效。未中奖同样使用本次机会，不能通过刷新或重新扫码再抽。</p><h2>怎样中奖与领取</h2><p>有库存时每次抽取有 ${e(chance)} 的机会中奖，中奖领取${e(view.prize.name)} 1 份；未中奖不发放领取码。${e(view.total)} 份抽完后停止抽奖。</p><p>中奖后在「我的结果」出示领取码，按页面提示前往收银台或由现场工作人员核销领取。每份奖品仅可领取一次，款式以现场实物为准。</p><p>活动奖品及概率以抽奖时的配置为准；已中奖的奖品会保留，不受后续调整影响。</p><h2>活动时间与帮助</h2><p>${c.startsAt&&c.endsAt?'活动起止及领取时间以本页公示为准。':'活动时间尚未确定，正式开放前会在本页及现场公布。'}领取地点：${e(view.venue)}。</p><p>参与记录用于防止重复抽奖及领取；如需查询或处理记录，请联系现场工作人员。</p>`;
  const body=customRules?`<div class="custom-rules-text">${e(customRules)}</div>`:defaultRules;
  return heading('活动说明','在出发前，把这份好运了解清楚。')+`<section class="rule-list"><div class="rule-row"><span class="rule-label">活动名称</span><strong class="rule-value">${e(view.title)}</strong></div><div class="rule-row"><span class="rule-label">活动奖品</span><strong class="rule-value">${e(view.prize.name)}，共 ${e(view.total)} 份</strong></div><div class="rule-row"><span class="rule-label">中奖概率</span><strong class="rule-value">${e(chance)}</strong></div><div class="rule-row"><span class="rule-label">开始时间</span><strong class="rule-value">${e(dateLabel(c.startsAt))}</strong></div><div class="rule-row"><span class="rule-label">抽奖截止</span><strong class="rule-value">${e(dateLabel(c.endsAt))}</strong></div><div class="rule-row"><span class="rule-label">领取截止</span><strong class="rule-value">${e(dateLabel(c.redeemEndsAt))}</strong></div></section><section class="detail-box">${body}<a class="secondary" href="#/staff">工作人员入口 ↗</a></section>`;
}
function staff(){
  const head=heading('现场工作台','先确认关注，再发放参与码；按领取凭证核销。');
  if(!S.identity?.isAdmin)return head+`<section class="empty-state"><h2 class="result-title">仅工作人员可进入</h2><p class="result-copy">当前微信账号没有此活动的管理权限。</p><a class="secondary" href="#/home">返回活动</a></section>`;
  const lookup=S.staffResult,entry=lookup?.entry,grant=S.grant,prize=entryPrize(entry);
  const grantView=!grant?'':`<section class="grant-card"><h3>请让已确认关注的用户扫码</h3>${grant.inviteQrUrl?`<img class="invite-qr" src="${e(grant.inviteQrUrl)}" alt="一次性抽奖参与小程序码">`:'<div class="code-display"><canvas class="invite-qr" role="img" aria-label="演示参与码二维码"></canvas></div>'}<div class="staff-code">${e(grant.inviteCode)}</div><p class="hint">有效至 ${e(dateLabel(grant.expiresAt))} · 仅限 1 人使用</p>${button('复制参与码','copy-invite','secondary')}${api.isPreview?`<p class="hint">此码仅用于本机演示；正式版展示微信小程序码。</p><a class="invite-link inline-link" href="#/home?inviteCode=${e(grant.inviteCode)}">在本机模拟扫码进入 ↗</a>`:''}</section>`;
  return head+`<section class="staff-form"><h2>发放抽奖机会</h2><p>请核对用户的小红书关注页面，再生成一次性参与码。</p>${button('确认已关注，生成参与码','grant','primary',S.busy)}${grantView}</section><section class="staff-form"><h2>查询中奖凭证</h2>${button('扫描领取码','scan','secondary',S.busy)}<label class="label" for="staff-code">输入或粘贴领取码</label><input id="staff-code" class="input" value="${e(S.staffCode)}" placeholder="请输入完整的 16 位领取码" maxlength="24" autocomplete="off" spellcheck="false" ${S.busy?'disabled':''}>${button('查询领取凭证','lookup','primary',S.busy)}</section>${entry?`<section class="staff-result"><span class="staff-status">${e(entry.statusLabel)}</span>${art('reward-art',prize)}<h2>${e(prize.name)} × 1</h2>${entry.status==='pending'?`<div class="staff-code">${e(entry.formattedCode)}</div>${entry.fulfillment==='cashier'?'<p>请在收银系统扫描此码，完成 0 元核销后再发放奖品。</p><p class="hint">此凭证由收银台统一核销，手机工作台仅供查询。</p>':button('核销并发放 1 份奖品','redeem','primary',S.busy)}`:`<p>${entry.status==='redeemed'?'此凭证已核销，请勿重复发放。':entry.status==='issuing'?'领取码正在准备中，请稍后重新查询。':entry.status==='reserved'?'收银台正在核销，请稍候，暂勿发放奖品。':'此凭证当前不可领取。'}</p>`}</section>`:''}${api.isPreview?'<p class="art-note">演示工作台，不产生真实发放记录。</p>':''}`;
}
function render(){
  document.querySelector('#preview-banner').hidden=!api.isPreview;
  document.querySelectorAll('.nav .item').forEach(link=>{link.classList.toggle('selected',link.dataset.page===S.route);link.dataset.page===S.route?link.setAttribute('aria-current','page'):link.removeAttribute('aria-current');link.setAttribute('aria-disabled',String(S.busy||S.drawing));});
  if(!S.loading&&!S.error&&S.route!=='staff'&&!S.state)S.error='活动信息暂不可用，请重新加载';
  main.className=`screen ${S.route}`;
  main.innerHTML=S.loading?'<p class="loading" role="status">正在加载山野好礼…</p>':S.error?heading('山野有约','关注小红书，抽一份山野好礼。')+`<section class="error-box" role="alert"><p>${e(S.error)}</p>${button('重新加载','refresh','secondary')}<p class="hint">${!api.isPreview?'请从工作人员提供的小程序参与入口重新进入。':''}</p></section>`+previewTools():({home,result,rules,staff}[S.route]||home)()+previewTools();
  if(S.route==='result'&&!S.error&&!S.loading&&S.state?.entry?.status==='pending'){
    const canvas=main.querySelector('canvas');if(canvas)try{S.mode==='qr'?drawQr(canvas,S.state.entry.code):drawBarcode(canvas,S.state.entry.code);}catch(err){canvas.remove();const p=document.createElement('p');p.className='hint';p.textContent=err.message;main.querySelector('.code-display')?.append(p);}
  }
  if(S.route==='staff'&&api.isPreview&&S.grant&&main.querySelector('canvas.invite-qr'))drawQr(main.querySelector('canvas.invite-qr'),S.grant.inviteCode);
}
async function load(silent=false){
  stopRefresh();if(silent&&!canRefresh()){schedule();return;}
  const ticket=epoch.next();let changed=false;if(!silent){S.loading=true;S.error='';render();}
  try{if(offline())throw new Error('连接已中断，请恢复后重新加载');
    if(S.route==='staff'){const data=await api.call('identity');if(!current(ticket))return;S.identity=data;}
    else {const data=await api.call('state');if(!current(ticket)||(silent&&!canRefresh()))return;if(!data?.campaign||!data.availability)throw new Error('活动数据暂不可用');S.state={...data,entry:safeEntry(data.entry)};document.title=`${campaignView(S.state).title} · Bubble 关注抽好礼`;}
    changed=true;S.error='';document.querySelector('#offline-banner').hidden=true;
  }catch(err){if(!epoch.isCurrent(ticket)||(silent&&!canRefresh()))return;changed=true;authFailure(err);if(S.route==='result'&&S.state?.entry&&!isAuthError(err)){S.state={...S.state,entry:safeEntry(S.state.entry,false)};S.error='';}else S.error=err.message;}
  finally{if(epoch.isCurrent(ticket)||!api.hasSession()){S.loading=false;if(changed||!silent)render();schedule();}}
}
function closeModal(value){stopCamera();if(modal.open)modal.close();if(resolveModal){const resolve=resolveModal;resolveModal=null;resolve(value);}}
function showModal(title,body,actions){closeModal(false);modal.innerHTML=`<h2 id="modal-title" class="modal-title">${e(title)}</h2>${body}<div class="modal-actions">${actions}</div>`;modal.showModal();return new Promise(resolve=>{resolveModal=resolve;});}
const alertUser=(title,message)=>showModal(title,`<p class="modal-copy">${e(message)}</p>`,button('知道了','modal-close'));
function navigate(route){if(S.busy||S.drawing)return;closeModal(false);location.hash=`/${route}`;}
async function onRoute(){if(S.busy||S.drawing){history.replaceState(null,'',`#/${S.route}`);return;}const parsed=parseLaunch(location.hash);if(parsed.inviteCode)S.invite=parsed.inviteCode;history.replaceState(null,'',location.pathname+location.search+`#/${parsed.route}`);stopCamera();closeModal(false);stopRefresh();epoch.next();S.route=parsed.route;S.mode='qr';S.staffResult=null;S.staffCode='';S.grant=null;window.scrollTo(0,0);await load();}
async function draw(){
  if(S.busy||S.drawing||S.loading||!S.state)return;if(S.state.entry)return navigate('result');
  if(!S.state.availability.canDraw)return toast(reasonLabel(S.state.availability.reason));
  const invite=(main.querySelector('#invite-code')?.value||S.invite||S.inviteDraft||'').replace(/[\s-]/g,'').toUpperCase();
  if(!INVITE_PATTERN.test(invite))return toast('请扫码进入，或输入工作人员提供的完整参与码');
  S.invite=invite;
  stopRefresh();const ticket=epoch.next();S.drawing=true;S.wheelIndex=null;render();
  const spinning=createWheel({reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,onStep:index=>{if(!current(ticket))return;S.wheelIndex=index;document.querySelectorAll('[data-wheel-cell]').forEach(cell=>cell.classList.toggle('is-active',Number(cell.dataset.wheelCell)===index));}});
  wheel=spinning;spinning.start();
  try{const data=await api.call('draw',{inviteCode:S.invite});if(!current(ticket))return;
    if(!['won','lost'].includes(data?.entry?.outcome))throw new Error('开奖结果暂未确认，请重新查看我的结果');
    if(!await spinning.finish(data.entry.outcome))return;
    if(!current(ticket))return;S.state={...data,entry:safeEntry(data.entry)};S.invite='';S.inviteDraft='';S.drawing=false;render();
    const entry=S.state.entry,won=entry?.outcome==='won',prize=entryPrize(entry);showModal(won?'山野好礼，抽中了！':'这次，和好运擦肩。',`${won?art('modal-art',prize):''}<p class="modal-prize">${won?`${e(prize.name)} × 1`:'本次未中奖'}</p><p class="modal-copy">${won?(entry.status==='issuing'?'中奖结果已保存，领取码正在准备中。':entry.fulfillment==='cashier'?'请到现场收银台出示领取码，0 元核销领取。':'请向工作人员出示领取码，核销后领取。'):'谢谢你的关注，期待山野里的下一次相遇。'}${api.isPreview?'<br>本次为演示结果':''}</p>`,button(won?'查看领取凭证':'查看我的结果','open-result')+button('稍后查看','modal-close','text-button'));
  }catch(err){spinning.cancel();S.wheelIndex=null;if(current(ticket)){render();authFailure(err);await alertUser('暂未完成抽奖',err.message);}}
  finally{spinning.cancel();if(wheel===spinning)wheel=null;S.drawing=false;if(!epoch.isCurrent(ticket)&&api.hasSession()&&!document.hidden&&!offline())await load(true);else {render();schedule();}}
}
async function copy(text){if(!text)return;try{await navigator.clipboard.writeText(text);toast('已复制');}catch{toast('请长按页面上的完整码复制');}}
async function lookup(){
  if(S.busy||!S.identity?.isAdmin)return;S.staffCode=(main.querySelector('#staff-code')?.value||S.staffCode).replace(/[\s-]/g,'').toUpperCase();
  if(!CODE_PATTERN.test(S.staffCode))return toast('请输入完整的 16 位领取码');
  const ticket=epoch.current();S.busy=true;S.staffResult=null;render();
  try{const data=await api.call('lookup',{code:S.staffCode});if(current(ticket))S.staffResult={...data,entry:safeEntry(data.entry)};}
  catch(err){if(current(ticket)){authFailure(err);await alertUser('查询未完成',err.message);}}
  finally{S.busy=false;render();}
}
async function redeem(){
  const entry=S.staffResult?.entry;if(S.busy||!S.identity?.isAdmin||entry?.status!=='pending'||offline())return;
  if(entry.fulfillment==='cashier')return alertUser('请到收银台核销','请在收银系统扫描此码，完成 0 元核销后再发放奖品。');
  const ticket=epoch.current(),prize=entryPrize(entry);S.busy=true;
  const confirmed=await showModal('确认发放奖品',`<p class="modal-copy">领取码 ${e(entry.formattedCode)}<br>请准备好${e(prize.name)} 1 份，核销成功后再交给用户。</p>`,button('确认核销','modal-confirm')+button('取消','modal-close','secondary'));
  if(!confirmed||!current(ticket)){S.busy=false;render();return;}
  S.staffResult=null;S.staffCode='';render();
  try{const data=await api.call('redeem',{code:entry.code});if(!current(ticket))return;S.staffResult={...data,entry:safeEntry(data.entry)};await alertUser(data.alreadyRedeemed===false?'核销成功':'请核对发放记录',data.alreadyRedeemed===false?`请发放${entryPrize(data.entry).name} 1 份。`:'此码已核销或结果需要确认，请核对现场记录，勿重复发放。');}
  catch(err){if(current(ticket)){authFailure(err);await alertUser('核销结果需确认',err.message+'。请重新查询凭证，确认后再发放。');}}
  finally{S.busy=false;render();}
}
async function grant(){
  if(S.busy||!S.identity?.isAdmin)return;const ticket=epoch.current();S.busy=true;
  const confirmed=await showModal('已确认小红书关注？','<p class="modal-copy">请确认已查看该用户的关注页面。生成后请让当前用户扫码，一码仅限使用一次。</p>',button('已确认，生成参与码','modal-confirm')+button('取消','modal-close','secondary'));
  if(!confirmed||!current(ticket)){S.busy=false;render();return;}S.grant=null;render();
  try{const data=await api.call('grant');if(!current(ticket))return;if(!INVITE_PATTERN.test(data.inviteCode)||(!api.isPreview&&!/^https:\/\//.test(data.inviteQrUrl||'')))throw new Error('参与码暂不可用，请稍后重试');S.grant=data;}
  catch(err){if(current(ticket)){authFailure(err);await alertUser('参与码未生成',err.message);}}
  finally{S.busy=false;render();}
}
function stopCamera(){scanGeneration++;clearTimeout(scanTimer);scanTimer=null;scanStream?.getTracks().forEach(track=>track.stop());scanStream=null;}
async function scan(){
  if(S.busy||!S.identity?.isAdmin)return;
  if(!window.BarcodeDetector||!navigator.mediaDevices?.getUserMedia)return alertUser('请使用扫码枪或手工输入','当前浏览器不支持摄像头扫码。可用扫码枪输入，或粘贴完整领取码。');
  showModal('扫描奖品领取码','<div class="scanner"><video autoplay muted playsinline></video><p class="hint">将中奖用户的领取码放入画面。</p></div>',button('取消扫描','modal-close','secondary'));
  const generation=scanGeneration,video=modal.querySelector('video'),valid=()=>generation===scanGeneration&&modal.open&&modal.contains(video)&&!document.hidden;let ownStream;
  try{ownStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false});if(!valid()){ownStream.getTracks().forEach(t=>t.stop());return;}scanStream=ownStream;video.srcObject=ownStream;await video.play();if(!valid())return;
    const available=await window.BarcodeDetector.getSupportedFormats();if(!valid())return;const detector=new window.BarcodeDetector({formats:['qr_code','code_128'].filter(f=>available.includes(f))});
    const tick=async()=>{if(!valid())return;try{const values=await detector.detect(video);if(!valid())return;if(values.length){S.staffCode=values[0].rawValue;closeModal(false);render();await lookup();return;}}catch{}if(valid())scanTimer=setTimeout(tick,250);};tick();
  }catch{ownStream?.getTracks().forEach(t=>t.stop());if(valid()){closeModal(false);await alertUser('未能打开相机','请允许相机权限，或改用扫码枪、手工输入。');}}
}
document.addEventListener('click',async event=>{
  const action=event.target.closest('[data-action]');if(event.target.closest('a')&&(S.busy||S.drawing)){event.preventDefault();return;}if(!action||action.disabled)return;
  switch(action.dataset.action){
    case 'draw':return draw();case 'open-result':closeModal(false);return navigate('result');case 'refresh':return load();
    case 'modal-close':return closeModal(false);case 'modal-confirm':return closeModal(true);
    case 'qr':case 'barcode':S.mode=action.dataset.action;render();return;
    case 'copy-award':return S.state?.entry?.status==='pending'&&!offline()?copy(S.state.entry.code):undefined;
    case 'copy-invite':return !offline()?copy(S.grant?.inviteCode):undefined;
    case 'lookup':return lookup();case 'redeem':return redeem();case 'grant':return grant();case 'scan':return scan();
    case 'scenario':if(api.isPreview){S.scenario=main.querySelector('#scenario').value;api.scenario(S.scenario);S.invite=api.launchInvite();invalidate();return load();}return;
    case 'reset':if(api.isPreview){const yes=await showModal('重置本机演示','<p class="modal-copy">仅清理当前标签页的演示数据。</p>',button('重置','modal-confirm')+button('取消','modal-close','secondary'));if(yes){api.reset();S.scenario='empty';S.invite=api.launchInvite();invalidate();await load();}}return;
  }
});
document.addEventListener('error',event=>{const image=event.target;if(image.matches?.('img[data-prize-image]')&&!image.dataset.fallback){image.dataset.fallback='true';image.src='./assets/scarf.svg';}},true);
main.addEventListener('input',event=>{if(event.target.id==='invite-code')S.inviteDraft=event.target.value;if(event.target.id==='staff-code'){S.staffCode=event.target.value;S.staffResult=null;main.querySelector('.staff-result')?.remove();}});
main.addEventListener('focusout',()=>schedule());
main.addEventListener('keydown',event=>{if(event.target.id==='staff-code'&&event.key==='Enter'){event.preventDefault();lookup();}});
main.addEventListener('toggle',event=>{if(event.target.matches('.preview-tools')){S.previewOpen=event.target.open;S.previewOpen?stopRefresh():schedule();}},true);
main.addEventListener('change',event=>{if(event.target.id==='scenario')S.scenario=event.target.value;});
modal.addEventListener('cancel',event=>{event.preventDefault();closeModal(false);});
window.addEventListener('hashchange',onRoute);window.addEventListener('offline',invalidate);window.addEventListener('online',()=>load());
document.addEventListener('visibilitychange',()=>{if(document.hidden)invalidate();else if(!S.drawing&&!S.busy)load();});
window.addEventListener('resize',()=>{if(S.route==='result'&&!S.loading&&!S.error)render();});
window.addEventListener('pagehide',()=>{invalidate();api.logout?.();});
try{if(!api.isPreview&&launch.code)await api.login(launch.code);await load();}catch(err){S.loading=false;S.error=err.message;authFailure(err);render();}
