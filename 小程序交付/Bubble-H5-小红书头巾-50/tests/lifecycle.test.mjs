import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import campaign from '../public/campaign.mjs';
import {createApi} from '../public/api.mjs';
import {createWheel} from '../public/wheel.mjs';
import {createEpoch, escapeHtml, safeEntry, dateLabel, CODE_PATTERN, INVITE_PATTERN, reasonLabel, campaignView, entryPrize} from '../public/core.mjs';

// Execute the real application functions with a small DOM boundary. These are
// behavior checks, not source-text assertions, and never contact a real service.
const app = fs.readFileSync(fileURLToPath(new URL('../public/app.mjs', import.meta.url)), 'utf8');
function productionFunction(name) {
  const declaration = new RegExp(`(?:^|\\n)(?:async )?function ${name}\\(`).exec(app);
  if (!declaration) throw new Error(`Missing production function: ${name}`);
  const start = declaration.index + (app[declaration.index] === '\n' ? 1 : 0);
  const remaining = app.slice(start);
  const next = /\n(?:async )?function [A-Za-z_$][\w$]*\(/.exec(remaining);
  if (!next) throw new Error(`Cannot isolate production function: ${name}`);
  return remaining.slice(0, next.index);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
const INVITE = 'AA00000000000001';
const AWARD = 'BB00000000000001';
const pendingAward = (code = AWARD) => ({outcome: 'won', status: 'pending', code, expiresAt: Date.now() + 3600000, createdAt: Date.now()});
const frame = (entry = null) => ({campaign, prize:campaign.prize, entry, inventory: {total: 200, remaining: entry?.outcome === 'won' ? 199 : 200}, availability: {canDraw: !entry, reason: entry ? 'ALREADY_DRAWN' : 'READY'}});

function harness(api, {route = 'home', confirm = true} = {}) {
  const epoch = createEpoch(), alerts = [], modals = [], events = [];
  const main = {className: '', innerHTML: '', querySelector: () => null};
  const elements = {'#preview-banner': {hidden: true}, '#offline-banner': {hidden: true}};
  const state = {
    route, invite: INVITE, state: frame(), loading: false, error: '', busy: false, drawing: false,
    mode: 'qr', identity: {isAdmin: true}, staffCode: AWARD, staffResult: null, grant: null,
    previewOpen: false, scenario: 'empty'
  };
  const context = {
    api, campaign, epoch, main, S: state, safeEntry, dateLabel, CODE_PATTERN, INVITE_PATTERN, reasonLabel, campaignView, entryPrize, e: escapeHtml, createWheel, wheel:null,
    modal:{open:false},document: {hidden: false, activeElement:null, querySelector: selector => elements[selector], querySelectorAll: () => []},
    offline: () => context.disconnected, disconnected: false,
    isAuthError: error => ['AUTH_REQUIRED', 'INVALID_TOKEN', 'TOKEN_EXPIRED'].includes(error.code),
    current: ticket => epoch.isCurrent(ticket) && !context.document.hidden && !context.disconnected,
    matchMedia: () => ({matches: true}), setTimeout, clearTimeout,
    art: (cls,prize=campaign.prize) => `<img class="${cls}" src="${prize.imageUrl}" alt="${escapeHtml(prize.name)}">`,
    heading: (title, copy) => `<h1>${title}</h1><p>${copy}</p>`,
    button: (label, action) => `<button data-action="${action}">${label}</button>`,
    closeModal(value) { events.push(['close', value]); },
    stopRefresh() {}, schedule() { events.push(['schedule']); },
    showModal(...args) { modals.push(args); return Promise.resolve(confirm); },
    async alertUser(...args) { alerts.push(args); },
    navigate(page) { events.push(['navigate', page]); },
    toast(message) { events.push(['toast', message]); }
  };
  vm.createContext(context);
  vm.runInContext(
    ['canRefresh', 'authFailure', 'invalidate', 'previewTools', 'home', 'result', 'rules', 'staff', 'render', 'load', 'draw', 'lookup', 'redeem']
      .map(productionFunction).join('\n') + '\nglobalThis.driver={draw,lookup,redeem,render,load,invalidate,canRefresh};',
    context, {filename: 'production-lifecycle-functions.mjs'}
  );
  return {context, state, epoch, main, alerts, modals, events, ...context.driver};
}

test('draw interrupted by hiding and returning reloads the authoritative result after the late response', async () => {
  const response = deferred(), actions = [];
  const fresh = pendingAward('CC00000000000002');
  const h = harness({
    isPreview: false, hasSession: () => true,
    call(action) { actions.push(action); return action === 'draw' ? response.promise : Promise.resolve(frame(fresh)); }
  });
  const work = h.draw();
  assert.equal(h.state.drawing, true);
  h.context.document.hidden = true;
  h.invalidate();
  // The production visibility handler deliberately defers refresh while drawing.
  h.context.document.hidden = false;
  assert.equal(h.state.drawing, true);
  response.resolve(frame(pendingAward(AWARD)));
  await work;
  assert.deepEqual(actions, ['draw', 'state']);
  assert.equal(h.state.state.entry.code, fresh.code, 'fresh state must win over the discarded draw response');
  assert.equal(h.state.state.availability.canDraw, false);
  assert.equal(h.state.drawing, false);
  assert.equal(h.modals.length, 0, 'the discarded result must not open a winner dialog');
  assert.match(h.main.innerHTML, /查看我的结果/);
});

test('a late draw response while offline cannot restore a credential or launch a refresh', async () => {
  const response = deferred(), actions = [];
  const h = harness({isPreview: false, hasSession: () => true, call(action) { actions.push(action); return response.promise; }});
  const work = h.draw();
  h.context.disconnected = true;
  h.invalidate();
  response.resolve(frame(pendingAward()));
  await work;
  assert.deepEqual(actions, ['draw']);
  assert.equal(h.state.state.entry, null);
  assert.equal(h.state.drawing, false);
  assert.equal(h.modals.length, 0);
  assert.ok(!h.main.innerHTML.includes(AWARD));
});

for (const [label, flag, shouldIssue] of [
  ['a confirmed first redemption', false, true],
  ['a duplicate redemption', true, false],
  ['an ambiguous redemption without an idempotency flag', undefined, false]
]) {
  test(`${label} gives the correct physical handoff instruction`, async () => {
    const actions = [];
    const data = {entry: {...pendingAward(), status: 'redeemed'}};
    if (flag !== undefined) data.alreadyRedeemed = flag;
    const h = harness({isPreview: false, hasSession: () => true, async call(action, payload) { actions.push([action, payload.code]); return data; }}, {route: 'staff'});
    h.state.staffResult = {entry: safeEntry(pendingAward())};
    await h.redeem();
    assert.deepEqual(actions, [['redeem', AWARD]]);
    assert.equal(h.state.busy, false);
    assert.equal(h.state.staffResult.entry.status, 'redeemed');
    assert.equal(h.state.staffResult.entry.code, '');
    assert.equal(h.alerts.length, 1);
    if (shouldIssue) {
      assert.equal(h.alerts[0][0], '核销成功');
      assert.equal(h.alerts[0][1], '请发放魔术头巾 1 份。');
    } else {
      assert.match(h.alerts[0][1], /勿重复发放/);
      assert.ok(!h.alerts[0][1].includes('请发放 1 条'));
    }
    await h.redeem();
    assert.equal(actions.length, 1, 'a redeemed entry must not submit another handoff');
  });
}

test('an expired session during draw clears protected state and renders a recoverable login message', async () => {
  let now = 0, requests = 0;
  const api = createApi({apiBase: 'https://api.example.invalid/scarf'}, {
    now: () => now,
    fetchImpl: async () => {
      requests++;
      return {ok: true, status: 200, json: async () => ({ok: true, data: {token: 'test-session-only', expiresAt: 1000}})};
    }
  });
  await api.login('test-one-time-code');
  now = 1001;
  const h = harness(api);
  await assert.doesNotReject(h.draw());
  assert.equal(requests, 1, 'expired authentication must not reach the draw API');
  assert.equal(api.hasSession(), false);
  assert.equal(h.state.state, null);
  assert.equal(h.state.identity, null);
  assert.equal(h.state.staffResult, null);
  assert.equal(h.state.drawing, false);
  assert.match(h.main.innerHTML, /登录已失效/);
  assert.match(h.main.innerHTML, /重新加载/);
  assert.match(h.main.innerHTML, /从工作人员提供的小程序参与入口重新进入/);
  assert.equal(h.alerts.length, 1);
});

test('a lookup returning after invalidation cannot refill a stale redeemable award', async () => {
  const response = deferred();
  const h = harness({isPreview: false, hasSession: () => true, call: () => response.promise}, {route: 'staff'});
  const work = h.lookup();
  assert.equal(h.state.busy, true);
  h.invalidate();
  response.resolve({entry: pendingAward()});
  await work;
  assert.equal(h.state.staffResult, null);
  assert.equal(h.state.staffCode, '');
  assert.equal(h.state.busy, false);
  assert.equal(h.alerts.length, 0);
  assert.ok(!h.main.innerHTML.includes('核销并发放 1 条头巾'));
});

test('an obsolete lookup authentication error cannot clear a newer identity', async () => {
  const response = deferred();
  let logouts = 0;
  const h = harness({isPreview: false, hasSession: () => true, call: () => response.promise, logout() { logouts++; }}, {route: 'staff'});
  const work = h.lookup();
  h.invalidate();
  const replacement = {isAdmin: true, owner: 'newer-session'};
  h.state.identity = replacement;
  response.reject(Object.assign(new Error('旧请求登录过期'), {code: 'TOKEN_EXPIRED'}));
  await work;
  assert.equal(logouts, 0);
  assert.equal(h.state.identity, replacement);
  assert.equal(h.state.error, '');
  assert.equal(h.alerts.length, 0);
});

test('home and rules render current prizes and exact probability while a winner keeps the original prize',()=>{
  const h=harness({isPreview:false,hasSession:()=>true});
  const old={...pendingAward(),prize:{id:'old',name:'原款魔术头巾',imageUrl:'https://example.invalid/old.png'},fulfillment:'cashier'};
  h.state.state={...frame(old),campaign:{...campaign,title:'赛事新活动',winProbabilityBps:2750},prize:{id:'new',name:'新版奖品',imageUrl:'https://example.invalid/new.png'},inventory:{total:260,remaining:259}};
  h.render();assert.match(h.main.innerHTML,/27.5%/);assert.match(h.main.innerHTML,/新版奖品/);assert.match(h.main.innerHTML,/共 260 份/);assert.match(h.main.innerHTML,/赛事新活动/);
  h.state.route='rules';h.render();assert.match(h.main.innerHTML,/27.5%/);assert.match(h.main.innerHTML,/新版奖品，共 260 份/);
  h.state.route='result';h.state.state.entry=safeEntry(old);h.render();assert.match(h.main.innerHTML,/原款魔术头巾/);assert.match(h.main.innerHTML,/https:\/\/example.invalid\/old.png/);assert.doesNotMatch(h.main.innerHTML,/新版奖品|new.png/);assert.match(h.main.innerHTML,/0 元核销领取/);
});
test('custom rules replace default prose as escaped multiline text while retaining live facts and the staff entrance',()=>{
  const h=harness({isPreview:false,hasSession:()=>true},{route:'rules'});
  const rulesText='第一行\n<img src=x onerror=alert(1)> & "引号"\n<script>alert(2)</script>\n'+ '长'.repeat(4900);
  h.state.state={...frame(),campaign:{...campaign,title:'说明测试活动',startsAt:1800000000000,rulesText,winProbabilityBps:2750},prize:{name:'新奖品'},inventory:{total:260,remaining:260}};
  h.render();
  assert.ok(h.main.innerHTML.includes(`<div class="custom-rules-text">${escapeHtml(rulesText)}</div>`));
  assert.doesNotMatch(h.main.innerHTML,/<script>|<img src=x|<h2>怎样参与<\/h2>/);
  for(const fact of ['说明测试活动','新奖品，共 260 份','27.5%',dateLabel(1800000000000),'href="#/staff"'])assert.ok(h.main.innerHTML.includes(fact));
  h.state.state.campaign.rulesText='';h.render();assert.match(h.main.innerHTML,/<h2>怎样参与<\/h2>/);assert.match(h.main.innerHTML,/活动时间与帮助/);assert.match(h.main.innerHTML,/参与记录用于防止重复抽奖/);assert.doesNotMatch(h.main.innerHTML,/custom-rules-text/);
});
test('rules page replaces saved text on refresh and defaults remain available for old responses',async()=>{
  let rulesText='新的活动说明';const h=harness({isPreview:false,hasSession:()=>true,async call(){return {...frame(),campaign:{...campaign,rulesText}};}},{route:'rules'});
  h.state.state={...frame(),campaign:{...campaign,rulesText:'旧的活动说明'}};h.render();
  await h.load(true);assert.match(h.main.innerHTML,/新的活动说明/);assert.doesNotMatch(h.main.innerHTML,/旧的活动说明/);
  rulesText=undefined;await h.load(true);assert.match(h.main.innerHTML,/<h2>怎样参与<\/h2>/);assert.match(h.main.innerHTML,/href="#\/staff"/);
});

test('cashier awards have no mobile redeem button and cannot call the legacy redeem API',async()=>{
  let calls=0;const h=harness({isPreview:false,hasSession:()=>true,async call(){calls++;}}, {route:'staff'});
  h.state.staffResult={entry:safeEntry({...pendingAward(),fulfillment:'cashier',prize:{name:'原款头巾'}})};
  h.render();assert.match(h.main.innerHTML,/收银系统扫描此码/);assert.doesNotMatch(h.main.innerHTML,/data-action="redeem"/);
  await h.redeem();assert.equal(calls,0);assert.equal(h.alerts[0][0],'请到收银台核销');assert.equal(h.state.staffResult.entry.status,'pending');
});

test('an issuing winner displays a retained result, polls, and never shows a credential prematurely',()=>{
  const h=harness({isPreview:false,hasSession:()=>true},{route:'result'});
  h.state.state=frame(safeEntry({...pendingAward(),status:'issuing',fulfillment:'cashier',prize:{name:'已中头巾'}}));h.render();
  assert.match(h.main.innerHTML,/已中头巾/);assert.match(h.main.innerHTML,/中奖结果已保留/);assert.doesNotMatch(h.main.innerHTML,/data-testid="award-code"/);assert.doesNotMatch(h.main.innerHTML,/去抽一份好礼/);
});

test('silent refresh waits through typing, dialogs, draws, staff operations, preview tools, and hidden pages',async()=>{
  let calls=0;const h=harness({isPreview:false,hasSession:()=>true,async call(){calls++;return frame();}});
  const blockers=[()=>{h.context.document.activeElement={matches:()=>true};},()=>{h.context.modal.open=true;},()=>{h.state.drawing=true;},()=>{h.state.busy=true;},()=>{h.state.previewOpen=true;},()=>{h.context.document.hidden=true;}];
  for(const block of blockers){h.context.document.activeElement=null;h.context.modal.open=false;h.state.drawing=false;h.state.busy=false;h.state.previewOpen=false;h.context.document.hidden=false;block();await h.load(true);}
  assert.equal(calls,0);h.context.document.hidden=false;await h.load(true);assert.equal(calls,1);
});

test('typing that starts during a silent response preserves the input and current screen',async()=>{
  const response=deferred(),h=harness({isPreview:false,hasSession:()=>true,call:()=>response.promise});
  h.state.invite='';h.state.inviteDraft='AA00';h.render();const original=h.main.innerHTML;
  const task=h.load(true);h.context.document.activeElement={matches:()=>true};
  response.resolve({...frame(),prize:{name:'暂缓显示的奖品'},inventory:{total:400,remaining:400}});await task;
  assert.equal(h.main.innerHTML,original);assert.equal(h.state.inviteDraft,'AA00');assert.equal(h.state.state.prize.name,'魔术头巾');
  h.context.document.activeElement=null;h.render();assert.match(h.main.innerHTML,/value="AA00"/);
});

test('a draw supersedes an in-flight catalog refresh',async()=>{
  const stateResponse=deferred(),drawResponse=deferred();
  const h=harness({isPreview:false,hasSession:()=>true,call:action=>action==='state'?stateResponse.promise:drawResponse.promise});
  const loading=h.load(true),drawing=h.draw();
  stateResponse.resolve({...frame(),prize:{name:'旧配置返回'}});await loading;assert.equal(h.state.drawing,true);assert.equal(h.state.state.entry,null);
  drawResponse.resolve(frame({...pendingAward(),prize:{name:'开奖快照'},fulfillment:'cashier'}));await drawing;
  assert.equal(h.state.state.entry.prize.name,'开奖快照');assert.match(h.modals[0][1],/开奖快照/);assert.match(h.modals[0][1],/0 元核销领取/);
});

test('refresh schedule uses ten seconds for the catalog and three for active claims',()=>{
  const h=harness({isPreview:false,hasSession:()=>true});const timers=[];
  h.context.setTimeout=(callback,delay)=>{timers.push({callback,delay});return timers.length;};h.context.clearTimeout=()=>{};
  vm.runInContext('let refreshTimer;\n'+productionFunction('schedule'),h.context);
  h.context.schedule();assert.equal(timers.at(-1).delay,10000);
  h.state.route='rules';h.context.schedule();assert.equal(timers.at(-1).delay,10000);
  h.state.route='result';h.state.state=frame({...pendingAward(),status:'issuing'});h.context.schedule();assert.equal(timers.at(-1).delay,3000);
  const count=timers.length;h.state.route='staff';h.context.schedule();assert.equal(timers.length,count);
});

test('session expiry while waiting for the next refresh removes the credential',()=>{
  let session=true,callback;
  const h=harness({isPreview:false,hasSession:()=>session,logout(){session=false;}},{route:'result'});
  h.state.state=frame(safeEntry(pendingAward()));h.context.setTimeout=handler=>{callback=handler;return 1;};h.context.clearTimeout=()=>{};
  vm.runInContext('let refreshTimer;\n'+productionFunction('schedule'),h.context);
  h.context.schedule();session=false;callback();assert.equal(h.state.state,null);assert.match(h.main.innerHTML,/登录已失效/);assert.doesNotMatch(h.main.innerHTML,/data-testid="award-code"/);
});

test('a cashier reservation hides the code until the next confirmed state',()=>{
  const h=harness({isPreview:false,hasSession:()=>true},{route:'result'});
  h.state.state=frame(safeEntry({...pendingAward(),status:'reserved',fulfillment:'cashier',prize:{name:'待交付头巾'}}));h.render();
  assert.equal(h.state.state.entry.code,'');assert.match(h.main.innerHTML,/收银台正在核销/);assert.doesNotMatch(h.main.innerHTML,/data-testid="award-code"/);
  let delay;h.context.setTimeout=(callback,ms)=>{delay=ms;return 1;};h.context.clearTimeout=()=>{};vm.runInContext('let refreshTimer;\n'+productionFunction('schedule'),h.context);h.context.schedule();assert.equal(delay,3000);
  h.state.state=frame(safeEntry({...pendingAward(),status:'redeemed',fulfillment:'cashier',prize:{name:'待交付头巾'}}));h.render();assert.match(h.main.innerHTML,/奖品已领取/);assert.doesNotMatch(h.main.innerHTML,/data-testid="award-code"/);
});

function useAnimatedWheel(h){
  let seq=0;
  const timers=new Map(),steps=[];
  h.context.matchMedia=()=>({matches:false});
  h.context.createWheel=options=>createWheel({...options,random:()=>0.6,
    onStep:index=>{steps.push(index);options.onStep(index);},
    setTimer:callback=>{const id=++seq;timers.set(id,callback);return id;},
    clearTimer:id=>timers.delete(id)});
  return {timers,steps,flush(){let ticks=0;while(timers.size){assert.ok(ticks++<100,'animation must settle');const [id,callback]=timers.entries().next().value;timers.delete(id);callback();}}};
}

for(const outcome of ['won','lost'])test(`grid animation lands on the server ${outcome} result and repeated clicks never draw twice`,async()=>{
  let draws=0;
  const entry=outcome==='won'?{...pendingAward(),fulfillment:'cashier'}:{outcome:'lost',status:'lost'};
  const h=harness({isPreview:false,hasSession:()=>true,async call(){draws++;return frame(entry);}});
  const animation=useAnimatedWheel(h),work=h.draw();
  await h.draw();
  assert.equal(draws,1);
  assert.equal(h.modals.length,0,'result stays closed until the animation finishes');
  assert.equal(h.state.drawing,true);
  animation.flush();await work;
  assert.ok(animation.steps.length>=25);
  assert.equal(h.state.wheelIndex%2,outcome==='won'?0:1);
  assert.equal(h.state.state.entry.outcome,outcome);
  assert.equal(h.modals.length,1);
  assert.match(h.modals[0][1],outcome==='won'?/0 元核销领取/:/本次未中奖/);
  assert.equal(animation.timers.size,0);
  await h.draw();assert.equal(draws,1,'after settling the center only opens the saved result');
});

test('hiding during settling stops all ticks and reloads the saved award on return',async()=>{
  const actions=[],entry={...pendingAward(),fulfillment:'cashier'};
  const h=harness({isPreview:false,hasSession:()=>true,async call(action){actions.push(action);return frame(entry);}});
  const animation=useAnimatedWheel(h),work=h.draw();
  await Promise.resolve();
  assert.ok(animation.timers.size>0);
  h.context.document.hidden=true;h.invalidate();h.context.document.hidden=false;
  await work;
  assert.equal(animation.timers.size,0);
  assert.deepEqual(actions,['draw','state']);
  assert.equal(h.state.state.entry.code,entry.code);
  assert.equal(h.state.drawing,false);
  assert.equal(h.modals.length,0);
});

test('an unknown server outcome cannot animate a loss or present a made-up result',async()=>{
  const h=harness({isPreview:false,hasSession:()=>true,async call(){return frame({outcome:'unknown'});}});
  const animation=useAnimatedWheel(h);await h.draw();
  assert.equal(animation.timers.size,0);
  assert.equal(h.state.state.entry,null);
  assert.equal(h.state.wheelIndex,null);
  assert.equal(h.modals.length,0);
  assert.match(h.alerts[0][1],/开奖结果暂未确认/);
});

test('a rejected draw stops the waiting animation without fabricating a consolation result',async()=>{
  const h=harness({isPreview:false,hasSession:()=>true,async call(){throw new Error('连接中断');}});
  const animation=useAnimatedWheel(h);await h.draw();
  assert.equal(animation.timers.size,0);
  assert.equal(h.state.drawing,false);
  assert.equal(h.state.state.entry,null);
  assert.equal(h.modals.length,0);
  assert.equal(h.alerts[0][1],'连接中断');
});
