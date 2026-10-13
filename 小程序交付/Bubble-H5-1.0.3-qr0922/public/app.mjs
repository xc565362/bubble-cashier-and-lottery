import {escapeHtml as e,safeEntry,campaignView,parseLaunch,createEpoch,refreshDelay} from './core.mjs';
import {prizeBoard,prizeArt as art,fallbackPrizeImage,probabilityCaption,probabilityExplanation} from './catalog.mjs';
import {createApi} from './api.mjs';
import {drawQr,drawBarcode} from './qr.mjs';

const runtime=window.BUBBLE_H5_CONFIG||{},main=document.querySelector('#main'),modal=document.querySelector('#modal');
const initial=parseLaunch(location.hash);
// Remove the one-use login code before rendering or loading optional scripts.
history.replaceState(null,'',location.pathname+location.search+`#/${initial.returnRoute}`);
const previewAllowed=runtime.mode==='preview'&&['localhost','127.0.0.1','[::1]'].includes(location.hostname);
let api=previewAllowed?(await import('./preview.mjs')).createPreview(sessionStorage):createApi(runtime);
const epoch=createEpoch();
let S={route:initial.returnRoute,loading:true,error:'',state:null,drawing:false,busy:false,codeMode:'qr',identity:null,staffCode:'',staffEntry:null,previewOpen:false,previewScenario:'empty'};
let refreshTimer,toastTimer,scanStream,scanTimer,modalResolve;
let refreshInFlight=0;
let scanGeneration=0;
const expiredAuth=error=>['AUTH_REQUIRED','INVALID_TOKEN','TOKEN_EXPIRED'].includes(error.code);
const button=(text,action,kind='primary',disabled=false)=>`<button class="${kind}" data-action="${action}" ${disabled?'disabled':''}>${text}</button>`;
const heading=(en,title,subtitle)=>`<div class="page-heading"><div class="kicker">${en}</div><h1 class="page-title">${title}</h1><p class="page-subtitle">${subtitle}</p></div>`;
const previewTools=()=>!api.isPreview?'':`<details class="preview-tools" ${S.previewOpen?'open':''}><summary>预览设置</summary><div class="preview-controls"><p>仅操作本标签页的演示数据，不连接正式奖池。原活动时间保持不变；此处可体验已结束活动的交互。</p><label for="scenario">查看不同状态</label><select id="scenario">${Object.entries({empty:'未抽奖',coupon:'可用购物券',physical:'待领取实物',using:'收银结算中',issuing:'正在发券',unavailable:'状态待同步',not_started:'尚未到使用时间',redeemed:'已核销',expired:'已过期',voided:'已作废',offline:'模拟断网',online:'恢复连接'}).map(([value,label])=>`<option value="${value}" ${value===S.previewScenario?'selected':''}>${label}</option>`).join('')}</select>${button('应用预览状态','scenario','secondary')}${button('重置演示数据','reset','text-button')}</div></details>`;

function toast(message){clearTimeout(toastTimer);const target=document.querySelector('#toast');target.textContent=message;target.hidden=false;toastTimer=setTimeout(()=>target.hidden=true,3400);}
function stopRefresh(){clearTimeout(refreshTimer);refreshTimer=null;}
function isOffline(){return !navigator.onLine || !!api.isOffline?.();}
function unavailable(){
  epoch.next();stopRefresh();closeModal(false);
  if(S.state?.entry)S.state={...S.state,entry:safeEntry(S.state.entry,false)};
  S.staffEntry=null;S.staffCode='';
  document.querySelector('#offline-banner').hidden=!isOffline();
  render();
}
function authFailure(error){
  if(expiredAuth(error)){api.logout?.();S.state=null;S.identity=null;S.staffEntry=null;S.staffCode='';S.error=error.message;S.loading=false;closeModal(false);epoch.next();}
}
function refreshBlocked(){return S.drawing||S.busy||modal.open||S.previewOpen;}
function schedule(){
  stopRefresh();
  if(refreshInFlight)return;
  const delay=refreshDelay(S,{visible:!document.hidden,online:!isOffline(),authenticated:api.hasSession(),modalOpen:modal.open});
  if(delay===null)return;
  refreshTimer=setTimeout(()=>{
    refreshTimer=null;
    const next=refreshDelay(S,{visible:!document.hidden,online:!isOffline(),authenticated:api.hasSession(),modalOpen:modal.open});
    if(next===delay)return load(true);
    schedule();
  },delay);
}

function home(){
  const state=S.state,campaign=state.campaign;
  const board=prizeBoard(state.prizes),blocked=!state.entry&&(state.drawError||!board.items.length);
  const grid=board.slots.map(slot=>slot.kind==='draw'?`<button class="prize-tile draw-tile" data-action="draw" ${S.drawing||S.busy||blocked?'disabled':''} aria-label="${state.entry?'查看我的奖品':'立即抽奖'}"><span class="draw-title">${S.drawing?'好运<br>揭晓中':state.entry?'查看<br>奖品':blocked?'暂未<br>开放':'立即<br>抽奖'}</span><span class="draw-small">${S.drawing?'请稍候':state.entry?'好运已经到账':'点击收获好运'}</span></button>`:(()=>{const p=slot.prize,probability=probabilityCaption(p,campaign);return `<div class="prize-tile" data-prize="${e(p.id)}">${probability?`<span class="probability">${e(probability)}</span>`:''}${art(p)}<span class="prize-name">${e(p.shortName||p.name)}</span></div>`;})()).join('');
  return `<div class="hero"><div class="kicker">— FOR EVERY FINISHER</div><h1 class="hero-title">此刻在地<br><span class="pink">赛场同行</span></h1><p class="hero-copy">扫码抽完赛助力礼，好运即刻出发。</p><div class="seal"><span>每一份热爱</span><div class="percent">100<span>%</span></div><span>都有回响</span></div></div><div class="content"><h2 class="section-label">你的赛场好运<span class="en">赛场好礼 · 100% 中奖</span></h2><section class="lottery-card" aria-label="活动奖品与抽奖"><div class="board-meta"><span>${state.inventory?`${e(state.inventory.total)} 份好礼${state.inventory.remaining!==null?` · 剩余 ${e(state.inventory.remaining)} 份`:''}`:'完赛有礼'}</span><span>GOOD LUCK</span></div><div class="prize-grid ${board.classic?'':'prize-grid--catalog'}" style="--prize-columns:${board.columns}">${grid}</div><p class="board-foot">${state.entry?'你已参与本次抽奖 · 前往我的奖品领取':e(state.drawError||(!board.items.length?'奖品信息正在更新，请稍后再来':'每人 1 次 · 有名额时必中 · 发完即止'))}</p></section><div class="minor-copy"><span>好运不落空，每一份热爱都有回响。</span><a class="text-button" href="#/rules">查看规则 ↗</a></div><h2 class="section-label">三步，把好礼带走<span class="en">HOW TO PLAY</span></h2><div class="steps"><div class="step"><span class="number">01</span><span class="title">参与抽奖</span><span class="desc">点击按钮，开启好运</span></div><div class="step"><span class="number">02</span><span class="title">出示二维码</span><span class="desc">在「我的奖品」查看</span></div><div class="step"><span class="number">03</span><span class="title">购物用券／领礼</span><span class="desc">金额券购物用，实物现场领</span></div></div><div class="location"><span aria-hidden="true">⌖</span><span>领取地点：${e(campaign.venue)}</span><span>现场核销</span></div><p class="art-note">奖品图片仅供参考，请以现场实物为准</p></div>`;
}
function prize(){
  const entry=S.state.entry,campaign=campaignView(S.state.campaign);
  const title=heading('MY RACE DAY REWARD','我的奖品','购物抵扣或现场领取，查看你的好礼凭证。');
  if(!entry)return title+`<div class="empty"><span class="symbol">✧</span><h2 class="title">好礼还在等你</h2><p class="copy">参与一次抽奖，收获一份赛场惊喜。<br>有名额时参与成功，即获 1 份好礼。</p><a class="primary" href="#/home">去抽一份好运 →</a></div>`;
  let credential;
  if(entry.status==='pending')credential=`<div class="code-modes" aria-label="领取码展示方式"><button class="code-mode ${S.codeMode==='qr'?'active':''}" data-action="code-qr" aria-pressed="${S.codeMode==='qr'}">二维码</button><button class="code-mode ${S.codeMode==='barcode'?'active':''}" data-action="code-barcode" aria-pressed="${S.codeMode==='barcode'}">条形码</button></div><div class="code-display"><canvas class="${S.codeMode==='qr'?'qr':'barcode'}-canvas" role="img" aria-label="${S.codeMode==='qr'?'奖品核销二维码':'奖品核销条形码'}"></canvas></div><div class="code ${entry.checkoutCoupon?'coupon-code':''}" data-testid="award-code">${e(entry.formattedCode)}</div>${button(`复制${entry.checkoutCoupon?'购物券码':'核销码'}`,'copy','copy')}<p class="hint">仅可核销一次，请勿随意转发${api.isPreview?'<br>演示凭证 · 不可实际抵扣或领取':''}</p>`;
  else if(entry.status==='using')credential='<div class="status">使用中</div><p class="hint">收银台正在结算，请等待付款结果。<br>付款成功后将自动显示已核销，请勿重复付款。</p>';
  else if(['issuing','unavailable','not_started'].includes(entry.status))credential=`<div class="status">${e(entry.statusLabel)}</div><p class="hint">中奖记录已保存，请稍候刷新。<br>券码可用后在此显示，无需重新抽奖。</p>`;
  else credential=`<div class="status">${entry.status==='redeemed'?'✓ 已核销':entry.status==='voided'?'已作废':'已超过使用期限'}</div><p class="hint">${entry.status==='redeemed'?'此凭证已使用，不可重复核销。':'请联系现场工作人员。'}</p>`;
  const row=(label,value)=>`<div class="detail-row"><span>${label}</span><span>${e(value)}</span></div>`;
  return title+`<section class="ticket"><div class="ticket-top"><span class="tag" role="status">${e(entry.statusLabel)}</span><div class="large-art">${art(entry.prize)}</div><h2 class="prize-title">${e(entry.prize.name)}</h2><div class="ticket-subtitle">FOR YOUR NEXT ADVENTURE</div></div><div class="ticket-bottom">${credential}</div></section><section class="detail-box">${row(entry.checkoutCoupon?'活动地点':'领取地点',campaign.venue)}${row('抽奖时间',entry.createdLabel)}${row('核销截止',entry.expiresLabel)}${entry.status==='redeemed'?row('核销时间',entry.redeemedLabel):''}${entry.checkoutCoupon?row('使用门槛',entry.minimumLabel):''}<h2 class="detail-title">使用须知</h2><p>${e(entry.checkoutCoupon?campaign.cashTerms:'请到活动展位出示核销码，由工作人员在收银系统扫码免费入单、完成核销后领取奖品。')}</p><p>可用或使用中时每 3 秒更新状态，也可手动刷新。</p>${button('刷新使用状态','refresh','secondary refresh')}</section>`;
}
function rules(){
  const state=S.state,c=campaignView(state.campaign),prizes=prizeBoard(state.prizes).items;
  const rulesText=typeof c.rulesText==='string'?c.rulesText.replace(/\r\n?/g,'\n').trim():'';
  return heading('ACTIVITY GUIDE','活动规则','先了解规则，再带上好运出发。')+`<section class="rule-section"><h2 class="rule-title">01 / 赛场好礼 · 100% 中奖</h2><h3 class="group">立减金奖品</h3>${prizes.filter(p=>p.kind==='cash').map(p=>`<div class="prob-row">${e(p.name)}</div>`).join('')}<h3 class="group">实物奖品</h3>${prizes.filter(p=>p.kind!=='cash').map(p=>`<div class="prob-row">${e(p.name)}</div>`).join('')}<p class="copy">${e(probabilityExplanation(state.campaign,prizes))}</p></section><section class="rule-section">${rulesText?`<h2 class="rule-title">02 / 活动说明</h2><p class="copy custom-rules">${e(rulesText).replace(/\n/g,'<br>')}</p>`:`<h2 class="rule-title">02 / 参与与领取</h2><p class="copy">1. 每个微信账号在本次活动中有 1 次抽奖机会；参与成功即获得 1 份奖品。</p><p class="copy">2. 在「我的奖品」查看核销码，前往${e(c.venue)}完成核销。</p><p class="copy">3. 实物由收银系统扫码免费入单、核销后发放；金额券用于购物抵扣，付款成功后核销，每张券仅可使用一次。</p><p class="copy">4. ${e(c.cashTerms)}</p>`}</section><section class="rule-section"><h2 class="rule-title">03 / 活动时间</h2><p class="copy">开始时间：${e(c.startLabel)}<br>抽奖截止：${e(c.endLabel)}<br>核销截止：${e(c.redeemLabel)}<br>请在公示的截止时间前领取。</p></section><section class="rule-section"><h2 class="rule-title">04 / 隐私与帮助</h2><p class="copy">本活动通过小程序验证微信账号，记录参与资格和中奖结果，不要求填写手机号或通讯录。记录仅用于本次抽奖、防重复参与和奖品核销。关于数据查询、更正或删除，请联系活动现场主办方。</p>${api.isPreview?'<p class="copy">当前为隔离预览，演示数据仅保存在当前浏览器标签页，可通过预览设置重置。</p>':''}<a class="secondary" href="#/staff">工作人员核销入口 ↗</a></section>`;
}
function staff(){
  const title=heading('STAFF ONLY','奖品核销','核对奖品，再确认发放。');
  if(!S.identity?.isAdmin)return title+`<div class="empty"><h2 class="title">此入口仅向工作人员开放</h2><p class="copy">当前微信账号没有核销权限。<br>请联系活动管理员添加账号。</p>${button('复制本人账号标识','copy-identity','secondary')}</div>`;
  const entry=S.staffEntry;
  return title+`<section class="staff-form">${api.isPreview?'<p class="tip">当前为核销演示，不产生真实发放记录。</p>':''}${button('扫描二维码／条形码','scan','secondary',S.busy)}<label class="label" for="staff-code">或输入完整奖品码／购物券码</label><input id="staff-code" class="input" value="${e(S.staffCode)}" placeholder="例如 A1B2 C3D4 E5F6 7890" maxlength="64" autocomplete="off" autocapitalize="off" spellcheck="false" ${S.busy?'disabled':''}>${button(S.busy?'正在查询…':'查询奖品 →','lookup','primary',S.busy)}</section>${entry?`<section class="staff-result"><div class="kicker">${e(entry.statusLabel)}</div><div class="large-art">${art(entry.prize)}</div><h2 class="name">${e(entry.prize.name)}</h2><div class="code">${e(entry.formattedCode)}</div>${entry.checkoutCoupon?'<p class="tip">此券用于购物抵扣，请在收银系统使用。付款成功后自动核销，工作人员不能在此直接发放。</p>':entry.status==='pending'?'<p class="tip">实物奖品请在收银系统扫码、免费入单。完成核销后再发放，本页只查询凭证。</p>':'<p class="tip">此凭证不可再次领取，请勿重复发放。</p>'}</section>`:''}<section class="detail-box"><p>请先核对奖品并准备好礼品。完成核销后再发放，避免重复领取。</p><h2 class="detail-title">固定扫码参与入口</h2><p>获取直达抽奖页面的正式活动码，可用于海报、展台印刷。生成后长按图片保存。</p>${button('获取固定活动码 ↗','activity-code','secondary',S.busy)}</section>`;
}
function render(){
  if(!S.loading&&!S.error&&S.route!=='staff'&&!S.state)S.error='活动信息暂不可用，请重新加载';
  document.querySelector('#preview-banner').hidden=!api.isPreview;
  document.querySelectorAll('.nav .item').forEach(link=>{const active=link.dataset.page===S.route;link.classList.toggle('selected',active);active?link.setAttribute('aria-current','page'):link.removeAttribute('aria-current');link.setAttribute('aria-disabled',String(S.drawing||S.busy));});
  main.className=`screen ${S.route}`;
  if(S.loading)main.innerHTML='<p class="loading" role="status">正在加载…</p>';
  else if(S.error)main.innerHTML=heading('BUBBLE RACE DAY','赛场同行','每一份热爱，都有回响。')+`<div class="error-box" role="alert"><p>${e(S.error)}</p>${button('重新加载','refresh','secondary')}<p class="hint">${!api.isPreview&&!api.hasSession()?'请返回小程序，从活动入口重新打开本页面。':''}</p></div>`+previewTools();
  else main.innerHTML=({home,prize,rules,staff}[S.route]||home)()+previewTools();
  if(S.route==='prize'&&S.state?.entry?.status==='pending'&&!S.loading&&!S.error){const canvas=main.querySelector('canvas');if(canvas){try{S.codeMode==='qr'?drawQr(canvas,S.state.entry.code):drawBarcode(canvas,S.state.entry.code);}catch(error){canvas.remove();const message=document.createElement('p');message.className='hint';message.textContent=error.message;main.querySelector('.code-display')?.append(message);}}}
}
async function load(silent=false){
  stopRefresh();refreshInFlight++;const ticket=epoch.next();
  if(!silent){S.loading=true;S.error='';render();}
  try {
    if(isOffline())throw new Error('连接已中断，请恢复连接后刷新');
    if(S.route==='staff'){
      const identity=await api.call('identity');if(!epoch.isCurrent(ticket)||document.hidden||isOffline()||(silent&&refreshBlocked()))return;S.identity=identity;
    }else{
      const state=await api.call('state');if(!epoch.isCurrent(ticket)||document.hidden||isOffline()||(silent&&refreshBlocked()))return;
      if(!state?.campaign||!Array.isArray(state.prizes))throw new Error('活动数据暂不可用，请稍后重试');
      S.state={...state,entry:safeEntry(state.entry)};
    }
    S.error='';document.querySelector('#offline-banner').hidden=true;
  }catch(error){
    if(!epoch.isCurrent(ticket))return;
    if(silent&&refreshBlocked()&&!expiredAuth(error))return;
    authFailure(error);
    if(S.route==='prize'&&S.state?.entry&&!expiredAuth(error)){S.state={...S.state,entry:safeEntry(S.state.entry,false)};S.error='';}
    else {S.error=error.message;S.staffEntry=null;}
  }finally{refreshInFlight--;if(epoch.isCurrent(ticket)||!api.hasSession()){S.loading=false;if(!silent||!refreshBlocked())render();}schedule();}
}
function navigate(page){if(S.drawing||S.busy)return;closeModal(false);location.hash=`/${page}`;}
async function onRoute(){
  const next=parseLaunch(location.hash).route;
  if(S.drawing||S.busy){history.replaceState(null,'',`#/${S.route}`);toast('请等待当前操作完成');return;}
  closeModal(false);stopCamera();stopRefresh();epoch.next();
  S.route=next;S.codeMode='qr';S.staffEntry=null;S.staffCode='';S.error='';
  window.scrollTo(0,0);await load();
}
function showModal(title,body,actions){
  closeModal(false);stopRefresh();modal.innerHTML=`<h2 id="modal-title" class="title">${e(title)}</h2>${body}<div class="modal-actions">${actions}</div>`;
  modal.showModal();return new Promise(resolve=>{modalResolve=resolve;});
}
function closeModal(value){stopCamera();if(modal.open)modal.close();if(modalResolve){const resolve=modalResolve;modalResolve=null;resolve(value);}schedule();}
function alertUser(title,text){return showModal(title,`<p class="subtitle">${e(text).replace(/\n/g,'<br>')}</p>`,button('知道了','modal-close'));}
async function draw(){
  if(S.drawing||S.busy||S.loading||S.error||!S.state)return;
  if(S.state.entry)return navigate('prize');
  if(S.state.drawError)return toast(S.state.drawError);
  const ring=prizeBoard(S.state.prizes).ringOrder;
  if(!ring.length)return toast('奖品信息正在更新，请稍后再来');
  stopRefresh();const ticket=epoch.next();S.drawing=true;render();
  try{
    const result=await api.call('draw');
    if(!epoch.isCurrent(ticket)||document.hidden||isOffline())return;
    const destination=ring.indexOf(result.prize.id);
    if(!matchMedia('(prefers-reduced-motion: reduce)').matches&&destination>=0){
      const steps=(ring.length<=12?2:1)*ring.length+destination+1,baseDelay=Math.max(4,Math.min(50,800/ring.length));
      for(let i=0;i<steps&&!document.hidden&&epoch.isCurrent(ticket);i++){
        main.querySelectorAll('[data-prize]').forEach(tile=>tile.classList.toggle('active',tile.dataset.prize===ring[i%ring.length]));
        await new Promise(resolve=>setTimeout(resolve,i>steps-5?100+(i-(steps-5))*40:baseDelay));
      }
    }
    if(!epoch.isCurrent(ticket)||document.hidden||isOffline())return;
    S.state={...S.state,entry:safeEntry(result)};S.drawing=false;
    const refresh=load(true),refreshTicket=epoch.current();await refresh;
    if(epoch.isCurrent(refreshTicket)&&api.hasSession()&&!document.hidden&&!isOffline()&&!S.error)showModal('好运，就在此刻',`<p class="subtitle">恭喜你抽中了</p><div class="large-art">${art(result.prize)}</div><div class="win-name">${e(result.prize.name)}</div><p class="subtitle">${result.checkoutCoupon?'购物结算前出示券码，付款成功后核销。':'请到活动展位，由收银登记核销后领取。'}${api.isPreview?'<br>演示奖品不产生真实领取资格':''}</p>`,button('查看领取凭证 →','open-prize')+button('稍后查看','modal-close','later'));
  }catch(error){if(epoch.isCurrent(ticket)&&!document.hidden){authFailure(error);await alertUser('温馨提示',error.message);}}
  finally{S.drawing=false;render();schedule();}
}
async function copy(text){if(!text)return;try{await navigator.clipboard.writeText(text);toast('已复制');}catch{const input=document.createElement('textarea');input.value=text;input.style.position='fixed';input.style.opacity='0';document.body.append(input);input.select();const ok=document.execCommand('copy');input.remove();toast(ok?'已复制':'请长按领取码文字复制');}}
async function lookup(){
  if(S.busy||!S.identity?.isAdmin)return;
  S.staffCode=main.querySelector('#staff-code')?.value||S.staffCode;
  if(!S.staffCode.trim())return toast('请输入完整奖品码或购物券码');
  stopRefresh();S.busy=true;S.staffEntry=null;render();const ticket=epoch.current();
  try{const entry=await api.call('lookup',{code:S.staffCode});if(epoch.isCurrent(ticket))S.staffEntry=safeEntry(entry);}
  catch(error){if(epoch.isCurrent(ticket)&&!document.hidden){authFailure(error);await alertUser('查询未完成',error.message);}}
  finally{S.busy=false;render();schedule();}
}
function stopCamera(){
  scanGeneration++;
  clearTimeout(scanTimer);scanTimer=null;
  const stream=scanStream;scanStream=null;
  stream?.getTracks().forEach(track=>track.stop());
  const video=modal.querySelector('.scanner video');
  if(video&&video.srcObject===stream)video.srcObject=null;
}
async function scan(){
  if(S.busy||document.hidden)return;
  if(!('BarcodeDetector' in window)||!navigator.mediaDevices?.getUserMedia)return alertUser('请使用扫码枪或手动输入','当前浏览器不支持直接扫码。可将扫码枪对准核销码，或复制完整领取码粘贴到输入框。');
  showModal('扫描领取码','<div class="scanner"><video autoplay muted playsinline></video><p class="hint">将二维码或条形码放入镜头中。</p></div>',button('取消扫描','modal-close','secondary'));
  const generation=++scanGeneration,video=modal.querySelector('.scanner video');
  const current=()=>generation===scanGeneration&&!document.hidden&&modal.open&&video&&modal.contains(video);
  let stream;
  // A cancelled permission request can still resolve. Dispose only its own stream,
  // without closing a newer dialog or stopping a subsequent scan.
  const dispose=()=>{
    stream?.getTracks().forEach(track=>track.stop());
    if(video&&video.srcObject===stream)video.srcObject=null;
    if(scanStream===stream)scanStream=null;
  };
  try{
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false});
    if(!current()){dispose();return;}
    scanStream=stream;video.srcObject=stream;await video.play();
    if(!current()){dispose();return;}
    const formats=await window.BarcodeDetector.getSupportedFormats();
    if(!current()){dispose();return;}
    const supported=['qr_code','code_128'].filter(f=>formats.includes(f));
    if(!supported.length)throw new Error('No supported code format');
    const detector=new window.BarcodeDetector({formats:supported});
    const tick=async()=>{
      if(!current()){dispose();return;}
      try{
        const results=await detector.detect(video);
        if(!current()){dispose();return;}
        if(results.length){S.staffCode=results[0].rawValue;closeModal(false);render();await lookup();return;}
      }catch{}
      if(current())scanTimer=setTimeout(tick,250);
      else dispose();
    };
    tick();
  }catch{
    dispose();
    if(!current())return;
    closeModal(false);await alertUser('未能打开相机','请允许相机权限后重试，或使用扫码枪／手动输入完整领取码。');
  }
}
async function activityCode(){
  if(S.busy||!S.identity?.isAdmin)return;stopRefresh();S.busy=true;render();const ticket=epoch.current();
  try{const result=await api.call('activityCode');if(!epoch.isCurrent(ticket)||document.hidden||isOffline())return;const url=result.url||result.tempFileURL;if(!url||!/^https:\/\//.test(url))throw new Error('活动码暂不可用，请联系管理员检查活动码服务');showModal('固定活动码',`<img class="activity-code-image" src="${e(url)}" alt="正式小程序活动码"><p class="hint">请核对活动入口后再用于印刷，长按图片保存。</p>`,button('关闭','modal-close','secondary'));}
  catch(error){if(epoch.isCurrent(ticket)&&!document.hidden){authFailure(error);await alertUser('活动码未生成',error.message);}}
  finally{S.busy=false;render();schedule();}
}
document.addEventListener('error',event=>fallbackPrizeImage(event.target),true);
document.addEventListener('click',async event=>{
  const control=event.target.closest('[data-action]');
  if(event.target.closest('.nav a')&&(S.drawing||S.busy)){event.preventDefault();return;}
  if(!control||control.disabled)return;
  const action=control.dataset.action;
  if(action==='draw')return draw();
  if(action==='refresh')return load();
  if(action==='open-prize'){closeModal(false);return navigate('prize');}
  if(action==='modal-close')return closeModal(false);
  if(action==='modal-confirm')return closeModal(true);
  if(action==='copy')return S.state?.entry?.status==='pending'&&!isOffline()?copy(S.state.entry.code):undefined;
  if(action==='copy-identity')return copy(S.identity?.openId);
  if(action==='code-qr'||action==='code-barcode'){if(S.state?.entry?.status==='pending'&&!isOffline()){S.codeMode=action==='code-qr'?'qr':'barcode';render();}return;}
  if(action==='lookup')return lookup();
  if(action==='scan')return scan();
  if(action==='activity-code')return activityCode();
  if(action==='scenario'&&api.isPreview){S.previewScenario=main.querySelector('#scenario').value;api.scenario(S.previewScenario);unavailable();return load();}
  if(action==='reset'&&api.isPreview){const yes=await showModal('重置演示数据','<p class="subtitle">仅清除当前标签页的演示奖品，正式活动数据不受影响。</p>',button('重置','modal-confirm')+button('取消','modal-close','secondary'));if(yes){api.reset();S.state=null;S.staffEntry=null;unavailable();await load();}}
});
main.addEventListener('toggle',event=>{if(event.target.matches('.preview-tools')){S.previewOpen=event.target.open;S.previewOpen?stopRefresh():schedule();}},true);
main.addEventListener('change',event=>{if(event.target.id==='scenario')S.previewScenario=event.target.value;});
main.addEventListener('input',event=>{if(event.target.id==='staff-code'){S.staffCode=event.target.value;S.staffEntry=null;main.querySelector('.staff-result')?.remove();}});
main.addEventListener('keydown',event=>{if(event.target.id==='staff-code'&&event.key==='Enter'){event.preventDefault();lookup();}});
modal.addEventListener('cancel',event=>{event.preventDefault();closeModal(false);});
window.addEventListener('hashchange',onRoute);
window.addEventListener('offline',unavailable);
window.addEventListener('online',()=>{if(!document.hidden&&!refreshBlocked())load();else schedule();});
window.addEventListener('pagehide',()=>{stopRefresh();stopCamera();epoch.next();api.logout?.();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){stopRefresh();stopCamera();unavailable();}else if(!refreshBlocked())load();else schedule();});
window.addEventListener('resize',()=>{if(S.route==='prize'&&!S.loading&&!S.error)render();});
try{if(!api.isPreview&&initial.code)await api.login(initial.code);await load();}
catch(error){S.loading=false;S.error=error.message;authFailure(error);render();}
