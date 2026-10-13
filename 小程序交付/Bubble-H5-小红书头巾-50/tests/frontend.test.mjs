import test from 'node:test';
import assert from 'node:assert/strict';
import {createPreview} from '../public/preview.mjs';
import {safeEntry,parseLaunch,CODE_PATTERN,INVITE_PATTERN,createEpoch,dateLabel,prizeImage,entryPrize,campaignView} from '../public/core.mjs';
import {createApi} from '../public/api.mjs';
const store=()=>{const data=new Map();return {getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};};
const fixture=(randomBit=()=>0)=>{let seq=0;const memory=store();return {memory,api:createPreview(memory,{now:()=>1000,randomBit,randomCode:()=>String(++seq).padStart(14,'0')})};};
test('winning and losing draws each consume one invitation and one participation',async()=>{
  for(const bit of [0,1]){let rolls=0;const {api}=fixture(()=>{rolls++;return bit;});const inviteCode=api.launchInvite();
    const results=await Promise.all(Array.from({length:12},()=>api.call('draw',{inviteCode})));
    assert.equal(rolls,1);for(const result of results){assert.equal(result.entry.outcome,bit?'lost':'won');assert.equal(result.inventory.remaining,bit?200:199);assert.equal(!!result.entry.code,!bit);}
    const next=(await api.call('grant')).inviteCode;assert.equal((await api.call('draw',{inviteCode:next})).entry.outcome,bit?'lost':'won');assert.equal(rolls,1);
  }
});
test('a losing result survives a reload and never acquires a claim code',async()=>{
  const {api,memory}=fixture(()=>1);await api.call('draw',{inviteCode:api.launchInvite()});
  const reopened=createPreview(memory,{randomBit:()=>{throw new Error('must not roll again');}});
  const state=await reopened.call('draw',{inviteCode:'DE00000000000002'});assert.equal(state.entry.outcome,'lost');assert.equal(safeEntry(state.entry).code,'');
});
test('invalid or expired entry codes fail before creating a result',async()=>{
  const {api,memory}=fixture();await assert.rejects(api.call('draw',{inviteCode:'0000000000000000'}),/参与码/);assert.equal((await api.call('state')).entry,null);
  const code=api.launchInvite();const reopened=createPreview(memory,{now:()=>9999999});await assert.rejects(reopened.call('draw',{inviteCode:code}),/参与码/);assert.equal((await reopened.call('state')).entry,null);
});
test('no stock refuses a draw without fabricating a losing result',async()=>{
  const {api}=fixture();api.scenario('sold_out');assert.equal((await api.call('state')).availability.reason,'SOLD_OUT');await assert.rejects(api.call('draw',{inviteCode:api.launchInvite()}));assert.equal((await api.call('state')).entry,null);
});
test('winning claim can be redeemed once and duplicate confirmation is idempotent',async()=>{
  const {api}=fixture();const data=await api.call('draw',{inviteCode:api.launchInvite()}),code=data.entry.code;
  assert.ok(CODE_PATTERN.test(code));assert.equal((await api.call('lookup',{code})).entry.status,'pending');
  const [first,second]=await Promise.all([api.call('redeem',{code}),api.call('redeem',{code})]);assert.equal(first.entry.status,'redeemed');assert.equal(first.alreadyRedeemed,false);assert.equal(second.alreadyRedeemed,true);assert.equal(safeEntry(second.entry).code,'');assert.equal((await api.call('state')).inventory.remaining,199);
});
test('only fresh, unexpired winning pending claims reveal codes',()=>{
  const code='ABCDEF0123456789';for(const status of ['pending','redeemed','expired','unavailable']){const entry=safeEntry({outcome:'won',status,code});assert.equal(entry.code,status==='pending'?code:'');assert.equal(safeEntry(entry,false).code,'');}
  assert.equal(safeEntry({outcome:'lost',status:'pending',code}).code,'');assert.equal(safeEntry({outcome:'won',status:'pending',code,expiresAt:1},true,2).status,'expired');
});
test('route parsing separates authentication and invitation from allowed routes',()=>{
  assert.deepEqual(parseLaunch('#/home?wx_code=once&inviteCode=abcdef0123456789&return_route=%2Fresult'),{route:'result',code:'once',inviteCode:'ABCDEF0123456789'});
  assert.deepEqual(parseLaunch('#/javascript:x?inviteCode=<bad>&return_route=https://bad.invalid'),{route:'home',code:'',inviteCode:''});
});
test('offline preview cannot redeem or reveal a refreshed record',async()=>{
  const {api}=fixture();const data=await api.call('draw',{inviteCode:api.launchInvite()});api.scenario('offline');await assert.rejects(api.call('redeem',{code:data.entry.code}),/断网/);api.scenario('online');assert.equal((await api.call('state')).entry.status,'pending');
});
test('unspecified event time stays unspecified, and old responses can be discarded',()=>{
  assert.equal(dateLabel(null),'时间待公布');const epoch=createEpoch(),ticket=epoch.next();epoch.next();assert.equal(epoch.isCurrent(ticket),false);
});
test('unconfigured production cannot fall back to a demo prize',async()=>{
  let requests=0;const api=createApi({apiBase:''},{fetchImpl:async()=>{requests++;}});await assert.rejects(api.call('draw',{inviteCode:'DE00000000000001'}),/正在准备中/);assert.equal(requests,0);assert.equal(api.hasSession(),false);
});
test('claim codes accept letters independently of the hexadecimal invitation format',()=>{
  const code='GHIJKL0123456789';assert.ok(CODE_PATTERN.test(code));assert.ok(!INVITE_PATTERN.test(code));
  assert.equal(safeEntry({outcome:'won',status:'pending',code}).code,code);
  assert.equal(parseLaunch(`#/home?inviteCode=${code}`).inviteCode,'');
});
test('an issuing prize is retained without exposing a claim credential',()=>{
  const entry=safeEntry({outcome:'won',status:'issuing',code:'AB00000000000000',prize:{id:'a',name:'原奖品'}});
  assert.equal(entry.outcome,'won');assert.equal(entry.status,'issuing');assert.equal(entry.code,'');assert.equal(entry.statusLabel,'领取码准备中');
});
test('images use HTTPS or the built-in scarf and never accept executable or credentialed URLs',()=>{
  assert.equal(prizeImage('https://images.example.invalid/prize.png'),'https://images.example.invalid/prize.png');
  for(const url of ['',null,'http://example.invalid/prize.png','javascript:alert(1)','data:image/svg+xml,test','file:///C:/secret.png','//example.invalid/x.png','https://name:password@example.invalid/x.png','./assets/other.svg'])assert.equal(prizeImage(url),'./assets/scarf.svg');
  assert.equal(entryPrize({prize:{name:'老奖品',imageUrl:'https://example.invalid/old.png'}}).name,'老奖品');
  assert.equal(entryPrize({outcome:'won'}).name,'魔术头巾');
});
test('public campaign formatting displays exact basis-point probability and never fabricates stock',()=>{
  assert.equal(campaignView({campaign:{winProbabilityBps:1234},inventory:{total:310}}).probability,'12.34');
  assert.equal(campaignView({campaign:{winProbabilityBps:0}}).probability,'0');
  assert.equal(campaignView({campaign:{winProbabilityBps:10000}}).probability,'100');
  for(const value of [undefined,-1,10001,50.2,'5000'])assert.equal(campaignView({campaign:{winProbabilityBps:value}}).probability,'待公布');
  assert.equal(campaignView({}).total,'待公布');
});
test('preview changes its current catalog and probability but keeps the awarded prize snapshot',async()=>{
  const {api}=fixture();const before=await api.call('draw',{inviteCode:api.launchInvite()});
  api.configure({prize:{id:'second',name:'第二款奖品',imageUrl:'https://example.invalid/new.png'},winProbabilityBps:2750,total:260,title:'新的活动名称'});
  const state=await api.call('state');assert.equal(state.prize.name,'第二款奖品');assert.equal(state.campaign.winProbabilityBps,2750);assert.equal(state.inventory.total,260);assert.equal(state.inventory.remaining,259);assert.equal(state.entry.prize.name,'魔术头巾');assert.equal(state.entry.code,before.entry.code);
  assert.equal((await api.call('lookup',{code:before.entry.code})).prize.name,'魔术头巾');
});
test('preview honors zero and full probability and blocks mobile redemption for cashier awards',async()=>{
  const zero=fixture().api;zero.configure({winProbabilityBps:0});assert.equal((await zero.call('draw',{inviteCode:zero.launchInvite()})).entry.outcome,'lost');
  const full=fixture(()=>1).api;full.configure({winProbabilityBps:10000,fulfillment:'cashier'});const state=await full.call('draw',{inviteCode:full.launchInvite()});assert.equal(state.entry.outcome,'won');
  await assert.rejects(full.call('redeem',{code:state.entry.code}),/收银系统/);assert.equal((await full.call('state')).entry.status,'pending');
});
test('API surfaces backend error fields as well as message fields',async()=>{
  for(const field of ['message','error']){
    const api=createApi({apiBase:'https://example.invalid'}, {now:()=>1000,fetchImpl:async url=>({ok:!url.endsWith('/call'),status:url.endsWith('/call')?409:200,json:async()=>url.endsWith('/call')?{ok:false,code:'USE_CASHIER',[field]:'请到收银台核销'}:{ok:true,data:{token:'test',expiresAt:9999}}})});
    await api.login('test');await assert.rejects(api.call('redeem'),error=>error.code==='USE_CASHIER'&&error.message==='请到收银台核销');
  }
});
