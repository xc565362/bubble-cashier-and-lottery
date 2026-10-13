import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import zxing from '@zxing/library';
import {safeEntry,parseLaunch,escapeHtml,createEpoch,dateLabel} from '../public/core.mjs';
import {createApi} from '../public/api.mjs';
import {qrLayout} from '../public/qr.mjs';
import {createPreview} from '../public/preview.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const qrContext={};vm.runInNewContext(fs.readFileSync(path.join(root,'public/vendor/qrcode.js'),'utf8'),qrContext);
const {MultiFormatReader,RGBLuminanceSource,HybridBinarizer,BinaryBitmap,DecodeHintType,BarcodeFormat}=zxing;
const codes=['A0123456789BCDEF','LJC1_0123456789ABCDEF0123456789ABCDEF','ljc1_0123456789abcdef0123456789abcdef'];
test('QR pixels decode to the literal token at mobile sizes and DPRs',()=>{
  for(const code of codes)for(const size of [180,210,240])for(const ratio of [1,1.5,2,3]){
    const pixels=Math.floor(size*ratio),layout=qrLayout(code,pixels,qrContext.qrcode),data=new Uint8ClampedArray(pixels*pixels).fill(255);
    for(const [x,y,w,h] of layout.rects){assert.ok([x,y,w,h].every(Number.isInteger));assert.ok(x>=4*w&&y>=4*h);assert.ok(pixels-x-w>=4*w&&pixels-y-h>=4*h);for(let row=y;row<y+h;row++)data.fill(0,row*pixels+x,row*pixels+x+w);}
    const decoded=new MultiFormatReader().decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(data,pixels,pixels))),new Map([[DecodeHintType.POSSIBLE_FORMATS,[BarcodeFormat.QR_CODE]]])).getText();
    assert.equal(decoded,code);
  }
});
test('only a fresh pending entry exposes an award token',()=>{
  for(const status of ['pending','using','issuing','unavailable','not_started','redeemed','voided','expired','unknown']){
    const value=safeEntry({status,code:codes[0]});assert.equal(value.code,status==='pending'?codes[0]:'');
    assert.equal(safeEntry(value,false).code,'');
  }
  assert.equal(safeEntry({status:'pending',code:'https://not-a-prize.invalid/'}).status,'unavailable');
});
test('a response issued before a navigation or connectivity change is rejected',()=>{
  const epoch=createEpoch(),old=epoch.next();epoch.next();assert.equal(epoch.isCurrent(old),false);
});
test('launch parsing only permits known routes and exposes the one-use code separately',()=>{
  assert.deepEqual(parseLaunch('#/home?wx_code=one-time-code&return_route=prize'),{route:'home',code:'one-time-code',returnRoute:'prize'});
  assert.deepEqual(parseLaunch('#/home?wx_code=one-time-code&return_route=%2Fprize'),{route:'home',code:'one-time-code',returnRoute:'prize'});
  assert.equal(parseLaunch('#/evil?return_route=https://evil.invalid').returnRoute,'home');
});
test('HTML is escaped and displayed campaign dates use Shanghai time',()=>{
  assert.equal(escapeHtml('<img onerror="x">'), '&lt;img onerror=&quot;x&quot;&gt;');
  assert.match(dateLabel(Date.UTC(2026,8,27,16,0)),/2026\/09\/28 00:00/);
});
test('production has no anonymous/demonstration fallback and stores no token in a URL',async()=>{
  let calls=[];const api=createApi({apiBase:'https://api.example.invalid/bubble'},{fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,status:200,json:async()=>url.endsWith('/session')?{ok:true,data:{token:'test-token',expiresAt:2000}}:{ok:true,data:{entry:null}}};},now:()=>1000});
  await assert.rejects(api.call('draw'),/登录已失效/);assert.equal(calls.length,0);
  await api.login('one-time-code');await api.call('state');
  assert.equal(calls[1].url,'https://api.example.invalid/bubble/call');assert.equal(calls[1].options.headers.Authorization,'Bearer test-token');
  assert.equal(calls[0].options.referrerPolicy,'no-referrer');api.logout();await assert.rejects(api.call('state'),/登录已失效/);
});
test('401 clears the session and mutation requests are never retried',async()=>{
  let calls=0,clock=0;const api=createApi({apiBase:'https://api.example.invalid'},{now:()=>clock,fetchImpl:async url=>{calls++;return url.endsWith('/session')?{ok:true,status:200,json:async()=>({ok:true,data:{token:'x',expiresAt:1000}})}:{ok:false,status:401,json:async()=>({ok:false,code:'SESSION_EXPIRED'})};}});
  await api.login('test-code');await assert.rejects(api.call('draw'),/登录已失效/);assert.equal(calls,2);assert.equal(api.hasSession(),false);
  await assert.rejects(api.call('draw'));assert.equal(calls,2);
});
test('bad configuration and failed transport cannot produce a local prize',async()=>{
  let calls=0;const api=createApi({apiBase:''},{fetchImpl:async()=>{calls++;}});await assert.rejects(api.call('draw'),/正在准备中/);assert.equal(calls,0);
});
test('demo fixtures are isolated, do not double draw, and cash cannot be redeemed by staff',async()=>{
  const makeStore=()=>{const data=new Map();return {getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};};
  const a=createPreview(makeStore()),b=createPreview(makeStore());const [one,two]=await Promise.all([a.call('draw'),a.call('draw')]);assert.equal(one.code,two.code);assert.equal((await a.call('state')).inventory.remaining,499);assert.equal((await b.call('state')).entry,null);
  assert.equal(safeEntry(one).status,'pending');assert.equal(one.code.length,37);await assert.rejects(a.call('redeem',{code:one.code}),/收银系统/);
  a.scenario('physical');const entry=(await a.call('state')).entry;assert.equal(entry.requiresPos,true);await assert.rejects(a.call('redeem',{code:entry.code}),/收银系统/);
  a.scenario('offline');await assert.rejects(a.call('state'),/断网/);a.scenario('online');assert.equal((await a.call('state')).entry.status,'pending');a.reset();assert.equal((await a.call('state')).entry,null);
});
