import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {prizeBoard, safeImageUrl, prizeArt, fallbackPrizeImage, probabilityCaption, probabilityExplanation} from '../public/catalog.mjs';
import {createEpoch, refreshDelay, safeEntry, campaignView, escapeHtml} from '../public/core.mjs';

const prizes = count => Array.from({length:count}, (_, index) => ({id:`server-prize-${index}`,name:`奖品 ${index}`,kind:'physical',icon:'cap',probability:100 / count}));
const stateFrame = items => ({campaign:{drawMode:'inventory',venue:'活动现场'},prizes:items,inventory:{total:100,remaining:90},entry:null,drawError:''});

test('one to many server prizes produce one draw control and no missing or hard-coded IDs', () => {
  for (const count of [0,1,2,3,5,8,9,12,25]) {
    const source=prizes(count), board=prizeBoard(source);
    assert.equal(board.slots.filter(slot=>slot.kind==='draw').length,1);
    assert.deepEqual(board.slots.filter(slot=>slot.kind==='prize').map(slot=>slot.prize.id).sort(),source.map(prize=>prize.id).sort());
    assert.deepEqual(board.ringOrder,source.map(prize=>prize.id));
    assert.equal(board.classic,count===8);
    assert.ok(board.columns>=1&&board.columns<=3);
    if (count===8) assert.equal(board.slots[4].kind,'draw');
  }
  const board=prizeBoard([{id:'draw',name:'奖品'},null,{id:'draw',name:'重复'}, {id:''}]);
  assert.deepEqual(board.ringOrder,['draw']);
  assert.equal(board.slots.length,2,'an opaque prize ID must not become a second button');
});

test('product images accept HTTPS only, escape attributes and fall back once to an original icon', () => {
  const url='https://images.example.invalid/prize.jpg?v=2&fit=contain';
  assert.equal(safeImageUrl(url),url);
  for (const invalid of ['http://images.example.invalid/a.jpg','javascript:alert(1)','data:image/svg+xml,a','//images.example.invalid/a.jpg','https://user:password@images.example.invalid/a.jpg','https:\\images.example.invalid/a.jpg','https://images.example.invalid/a\n.jpg','not a url']) assert.equal(safeImageUrl(invalid),'');
  const html=prizeArt({kind:'physical',name:'<img onerror="x">',imageUrl:url,icon:'cap'});
  assert.match(html,/v=2&amp;fit=contain/);
  assert.match(html,/alt="&lt;img onerror=&quot;x&quot;&gt;"/);
  assert.match(html,/referrerpolicy="no-referrer"/);
  assert.match(prizeArt({kind:'physical',name:'礼品',imageUrl:'javascript:alert(1)',icon:'waist'}),/src="\.\/assets\/waist.svg"/);
  const attributes=new Map([['data-prize-image','remote'],['data-fallback-src','./assets/cap.svg'],['data-fallback-alt','帽子示意图']]);
  const image={getAttribute:key=>attributes.get(key),setAttribute:(key,value)=>attributes.set(key,value),removeAttribute:key=>attributes.delete(key)};
  assert.equal(fallbackPrizeImage(image),true);
  assert.equal(attributes.get('src'),'./assets/cap.svg');
  assert.equal(attributes.get('alt'),'帽子示意图');
  assert.equal(fallbackPrizeImage(image),false,'a missing bundled icon cannot start an error loop');
});

test('probabilities distinguish fixed, initial inventory and a service-provided effective value', () => {
  assert.equal(probabilityCaption({probability:25},{drawMode:'fixed'}),'固定 25%');
  assert.equal(probabilityCaption({probability:20,configuredProbability:25},{drawMode:'fixed'}),'固定 25%');
  assert.equal(probabilityCaption({effectiveProbability:0,configuredProbability:50},{drawMode:'fixed',enabled:false}),'设定 50%');
  assert.equal(probabilityCaption({probability:25},{drawMode:'inventory'}),'初始配置 25%');
  assert.equal(probabilityCaption({probability:25},{inventory:{}}),'初始配置 25%');
  assert.equal(probabilityCaption({probability:25,effectiveProbability:0},{drawMode:'inventory'}),'当前 0%');
  assert.equal(probabilityCaption({probability:25,effectiveProbability:33.333333},{drawMode:'inventory'}),'当前 33.3333%');
  assert.equal(probabilityCaption({probability:25,effectiveProbability:150},{drawMode:'fixed'}),'固定 25%');
  assert.equal(probabilityCaption({probability:NaN},{drawMode:'fixed'}),'');
  assert.match(probabilityExplanation({drawMode:'inventory'},[]),/不代表剩余奖池的实时中奖概率/);
  assert.match(probabilityExplanation({drawMode:'inventory'},[{effectiveProbability:20}]),/标注为“当前”/);
  assert.match(probabilityExplanation({drawMode:'inventory'},[{effectiveProbability:20}]),/当前剩余名额比例/);
  assert.match(probabilityExplanation({drawMode:'fixed'},[{effectiveProbability:20}]),/按固定概率抽取/);
  assert.doesNotMatch(probabilityExplanation({drawMode:'inventory'},[{effectiveProbability:20}]),/初始/);
  assert.doesNotMatch(probabilityExplanation({drawMode:'fixed'},[{effectiveProbability:0}]),/初始/);
});

test('a new physical prize without a supported image uses a neutral gift instead of another product', () => {
  const html=prizeArt({kind:'physical',name:'新奖品',icon:'new-scarf'});
  assert.match(html,/product-placeholder/);
  assert.match(html,/实物奖品示意/);
  assert.doesNotMatch(html,/assets\/tote|<img/);
  for(const icon of ['cap','bucket','waist','tote']) assert.match(prizeArt({kind:'physical',name:'原奖品',icon}),new RegExp(`assets/${icon}\\.svg`));
});

test('a failed new remote image becomes an accessible neutral placeholder without retrying', () => {
  const attributes=new Map([['data-prize-image','remote'],['data-fallback-src',''],['data-fallback-kind','neutral'],['data-fallback-alt','新奖品实物奖品示意图']]);
  let replacement;
  const createElement=()=>({attributes:new Map(),children:[],setAttribute(key,value){this.attributes.set(key,value);},append(child){this.children.push(child);}});
  const image={getAttribute:key=>attributes.get(key),removeAttribute:key=>attributes.delete(key),ownerDocument:{createElement},replaceWith(element){replacement=element;}};
  assert.equal(fallbackPrizeImage(image),true);
  assert.equal(replacement.className,'product-placeholder');
  assert.equal(replacement.attributes.get('aria-label'),'新奖品实物奖品示意图');
  assert.equal(replacement.children[0].className,'gift-icon');
  assert.equal(fallbackPrizeImage(image),false);
});

test('cash prizes honor a custom HTTPS image and recover the original amount when it fails', () => {
  const html=prizeArt({kind:'cash',name:'30 元购物券',amount:30,imageUrl:'https://images.example.invalid/cash.jpg'});
  assert.match(html,/src="https:\/\/images.example.invalid\/cash.jpg"/);
  assert.match(html,/data-fallback-kind="cash"/);
  assert.match(prizeArt({kind:'cash',amount:30,imageUrl:'javascript:alert(1)'}),/<span class="amount">30<\/span>/);
  const attributes=new Map([['data-prize-image','remote'],['data-fallback-kind','cash'],['data-fallback-amount','30']]);
  let replacement;
  const createElement=()=>({children:[],append(...children){this.children.push(...children);}});
  const image={getAttribute:key=>attributes.get(key),removeAttribute:key=>attributes.delete(key),ownerDocument:{createElement},replaceWith(element){replacement=element;}};
  assert.equal(fallbackPrizeImage(image),true);
  assert.equal(replacement.className,'cash');
  assert.equal(replacement.children[0].textContent,'¥');
  assert.equal(replacement.children[1].textContent,'30');
  assert.equal(fallbackPrizeImage(image),false);
});

test('refresh cadence suspends for interaction, hidden, offline and expired authentication', () => {
  const state={route:'home',loading:false,drawing:false,busy:false,previewOpen:false,state:{entry:null}};
  const ready={authenticated:true};
  assert.equal(refreshDelay(state,ready),10000);
  assert.equal(refreshDelay({...state,route:'rules'},ready),10000);
  assert.equal(refreshDelay({...state,route:'prize'},ready),3000);
  assert.equal(refreshDelay({...state,route:'staff'},ready),null);
  for (const name of ['loading','drawing','busy','previewOpen']) assert.equal(refreshDelay({...state,[name]:true},ready),null);
  for (const option of [{visible:false},{online:false},{authenticated:false},{modalOpen:true}]) assert.equal(refreshDelay(state,{...ready,...option}),null);
});

const source=fs.readFileSync(fileURLToPath(new URL('../public/app.mjs',import.meta.url)),'utf8');
function productionFunction(name) {
  const declaration=new RegExp(`(?:^|\\n)(?:async )?function ${name}\\(`).exec(source);
  if(!declaration)throw new Error(`Missing production function ${name}`);
  const start=declaration.index+(source[declaration.index]==='\n'?1:0),tail=source.slice(start);
  const next=/\n(?:async )?function [A-Za-z_$][\w$]*\(/.exec(tail);
  if(!next)throw new Error(`Cannot isolate ${name}`);
  return tail.slice(0,next.index);
}
function deferred(){let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};}
function refreshHarness(call=async()=>stateFrame(prizes(9))) {
  const S={route:'home',state:stateFrame(prizes(8)),loading:false,drawing:false,busy:false,previewOpen:false,error:''};
  const epoch=createEpoch(),timers=new Map(),renders=[],calls=[],modal={open:false};let timerId=0;
  const context={
    S,epoch,modal,refreshDelay,safeEntry,campaignView,e:escapeHtml,prizeBoard,probabilityCaption,probabilityExplanation,art:prizeArt,
    api:{isPreview:false,hasSession:()=>true,call(action){calls.push(action);return call(action);}},
    document:{hidden:false,querySelector:()=>({hidden:true})},disconnected:false,
    isOffline:()=>context.disconnected,
    expiredAuth:()=>false,authFailure(){},closeModal(){modal.open=false;},
    render(){renders.push(S.state);},
    heading:(_en,title,subtitle)=>`<h1>${title}</h1><p>${subtitle}</p>`,
    setTimeout(callback,delay){const id=++timerId;timers.set(id,{callback,delay});return id;},
    clearTimeout(id){timers.delete(id);}
  };
  vm.createContext(context);
  vm.runInContext(`let refreshTimer,refreshInFlight=0;\n${['stopRefresh','refreshBlocked','schedule','unavailable','home','rules','load'].map(productionFunction).join('\n')}\nglobalThis.driver={schedule,stopRefresh,load,unavailable,home,rules};`,context);
  return {S,epoch,context,timers,renders,calls,modal,...context.driver,
    fire(){const [id,timer]=timers.entries().next().value||[];assert.ok(timer,'expected one pending refresh');timers.delete(id);return timer.callback();}
  };
}

test('a ten-second home refresh displays new server prizes and schedules exactly one successor', async () => {
  const h=refreshHarness();h.schedule();h.schedule();
  assert.equal(h.timers.size,1);
  assert.equal([...h.timers.values()][0].delay,10000);
  await h.fire();
  assert.deepEqual(h.calls,['state']);
  assert.equal(h.S.state.prizes.length,9);
  assert.match(h.home(),/data-prize="server-prize-8"/);
  assert.match(h.home(),/prize-grid--catalog/);
  assert.doesNotMatch(h.home(),/8 重好礼/);
  assert.match(h.rules(),/奖品 8/);
  assert.match(h.rules(),/初始奖池/);
  assert.equal(h.timers.size,1);
});

test('a slow state request cannot accumulate or overlap additional polling requests', async () => {
  const response=deferred(),h=refreshHarness(()=>response.promise);
  h.schedule();const work=h.fire();
  h.schedule();h.schedule();
  assert.equal(h.timers.size,0);
  assert.deepEqual(h.calls,['state']);
  response.resolve(stateFrame(prizes(3)));await work;
  assert.equal(h.timers.size,1);
  assert.equal(h.S.state.prizes.length,3);
});

test('poll callback rechecks visibility and an in-flight response cannot repaint an open dialog', async () => {
  const h=refreshHarness();h.schedule();h.context.document.hidden=true;
  await h.fire();assert.equal(h.calls.length,0);assert.equal(h.timers.size,0);
  const response=deferred(),waiting=refreshHarness(()=>response.promise),original=waiting.S.state;
  waiting.schedule();const work=waiting.fire();waiting.modal.open=true;
  response.resolve(stateFrame(prizes(2)));await work;
  assert.equal(waiting.S.state,original);
  assert.equal(waiting.renders.length,0);
  assert.equal(waiting.timers.size,0);
  waiting.modal.open=false;waiting.schedule();assert.equal(waiting.timers.size,1);
});

test('background invalidation rejects an old catalogue without restarting a hidden poll', async () => {
  const response=deferred(),h=refreshHarness(()=>response.promise),original=h.S.state;
  h.S.route='rules';h.schedule();const work=h.fire();
  h.context.document.hidden=true;h.unavailable();
  response.resolve(stateFrame(prizes(12)));await work;
  assert.equal(h.S.state,original);
  assert.equal(h.timers.size,0);
  h.context.document.hidden=false;h.schedule();assert.equal([...h.timers.values()][0].delay,10000);
});

test('animation visits server-provided IDs and lands on the returned prize for non-eight counts', async () => {
  for(const count of [2,5,9]) {
    const items=prizes(count),winner=items[count-1],epoch=createEpoch(),active=[],modals=[];
    const S={state:stateFrame(items),drawing:false,loading:false,error:'',busy:false};
    const result={prize:winner,status:'pending',code:'AB00000000000001'};
    const context={S,epoch,prizeBoard,safeEntry,e:escapeHtml,api:{isPreview:false,hasSession:()=>true,call:async()=>result},document:{hidden:false},isOffline:()=>false,
      main:{querySelectorAll:()=>items.map(prize=>({dataset:{prize:prize.id},classList:{toggle(_name,on){if(on)active.push(prize.id);}}}))},
      matchMedia:()=>({matches:false}),setTimeout:callback=>queueMicrotask(callback),stopRefresh(){},render(){},schedule(){},
      async load(){epoch.next();},showModal(...args){modals.push(args);},art:prizeArt,button:()=>'',navigate(){},toast(){},authFailure(){},async alertUser(){assert.fail('unexpected draw error');}
    };
    vm.createContext(context);vm.runInContext(`${productionFunction('draw')}\nglobalThis.performDraw=draw;`,context);
    await context.performDraw();
    assert.deepEqual([...new Set(active)],items.map(prize=>prize.id));
    assert.equal(active.at(-1),winner.id);
    assert.equal(S.state.entry.prize.id,winner.id);
    assert.equal(S.drawing,false);
    assert.equal(modals.length,1);
  }
});
