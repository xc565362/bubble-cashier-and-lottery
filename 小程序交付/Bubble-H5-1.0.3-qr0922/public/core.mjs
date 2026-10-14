export const VALID_STATUSES = ['pending','using','issuing','unavailable','not_started','redeemed','voided','expired'];
export const CODE_PATTERN = /^(?:[0-9A-F]{16}|LJC1_[0-9A-F]{32})$/i;
export function escapeHtml(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
export function dateLabel(value) {
  if (!value) return '以活动现场公示为准';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '以活动现场公示为准';
  return new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date);
}
export function safeEntry(value, fresh = true) {
  if (!value) return null;
  let status = VALID_STATUSES.includes(value.status) ? value.status : 'unavailable';
  if (!fresh && status !== 'redeemed' && status !== 'voided' && status !== 'expired') status = 'unavailable';
  if (status === 'pending' && !CODE_PATTERN.test(value.code || '')) status = 'unavailable';
  const code = status === 'pending' ? value.code : '';
  const statusLabel = {pending:value.checkoutCoupon?'可使用 · 购物抵扣':'待核销 · 现场领取',using:'使用中 · 收银结算中',issuing:'奖品已确认 · 正在发券',unavailable:'券状态待同步',not_started:'尚未到使用时间',redeemed:'已核销',voided:'已作废',expired:'已过期'}[status];
  return {...value,status,code,statusLabel,formattedCode:code?(value.checkoutCoupon?code:(code.match(/.{1,4}/g)||[]).join(' ')):'',createdLabel:dateLabel(value.createdAt),redeemedLabel:dateLabel(value.redeemedAt),expiresLabel:dateLabel(value.expiresAt),minimumLabel:value.minimumGoodsAmountCents>0?`商品优惠后满 ${(value.minimumGoodsAmountCents/100).toFixed(2)} 元可用`:'无最低消费门槛'};
}
export function campaignView(value = {}) {
  return {...value,startLabel:dateLabel(value.startsAt),endLabel:dateLabel(value.endsAt),redeemLabel:dateLabel(value.redeemEndsAt)};
}
export function parseLaunch(hash) {
  const raw = String(hash || '').replace(/^#\/?/,'');
  const [path,query = ''] = raw.split('?');
  const params = new URLSearchParams(query || (raw.includes('wx_code=')?raw:''));
  const route = ['home','prize','rules','staff'].includes(path)?path:'home';
  const returnRoute=(params.get('return_route')||'').replace(/^\//,'');
  const ticket=params.get('wx_ticket')||'';
  return {route,code:params.get('wx_code')||'',...(/^HT1\.[A-Za-z0-9_-]{43}$/.test(ticket)?{ticket}:{}),returnRoute:['home','prize','rules','staff'].includes(returnRoute)?returnRoute:route};
}
// Invalidating the epoch rejects responses issued before a route/auth/network change.
export function createEpoch() {
  let value = 0;
  return {next:()=>++value,current:()=>value,isCurrent:token=>token===value};
}

// One timeout is used per visible route; the callback rechecks these conditions
// before starting another request. Prize credentials retain their faster cadence.
export function refreshDelay(state, {visible = true, online = true, authenticated = false, modalOpen = false} = {}) {
  if (!visible || !online || !authenticated || modalOpen || state.loading || state.drawing || state.busy || state.previewOpen) return null;
  if (state.route === 'home' || state.route === 'rules') return 10000;
  if (state.route === 'prize' && (!state.state?.entry || ['pending','using','issuing','unavailable','not_started'].includes(state.state.entry.status))) return 3000;
  return null;
}
