import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createDrawRecords,createCloudRecordsReader}=require('../lottery-backend/draw-records.cjs');
const {createManagementHttp}=require('../lottery-backend/management-http.cjs');
const scarf=require('../../miniprogram/Bubble-H5-小红书头巾-50/server/cloudfunctions/bubble-scarf-gateway/management.cjs');
const {createCouponStore}=require('../coupons/store.cjs');
const {couponHttp}=require('../coupons/http.cjs');
const key='a'.repeat(64),at=1791886000000,now=()=>at;
const id=n=>n.toString(16).padStart(32,'0');
const centerIdentity={centerId:'center-fixture',environment:'production'};
const original=(n,extra={})=>({_id:id(n),campaignId:'records-fixture',createdAt:at-n,prize:{id:'cap',name:'帽子',kind:'physical'},status:'pending',code:'ABCDEF0123456789',...extra});
const binding=n=>({...centerIdentity,campaignId:'coupon-campaign',owner:'owner-'+n,awardId:'award-'+n});
function reader(rows) {
  return async ({campaignId,limit,after,outcome,participantRef,mode})=>{
    const all=rows.filter(row=>row.campaignId===campaignId&&(!participantRef||row._id===participantRef)&&(outcome==='all'||(mode==='scarf'?row.outcome:row.prize?'won':'lost')===outcome)).sort((a,b)=>a._id.localeCompare(b._id));
    return {total:all.length,rows:structuredClone(all.filter(row=>row._id>after).slice(0,limit+1))};
  };
}
function records(rows,{center,...options}={}) {return createDrawRecords({readPage:reader(rows),campaignId:'records-fixture',key,center,now,...options});}
test('durable draws page stably by identity with filter-bound signed cursors and no row mutation',async()=>{
  const rows=[original(3),original(1),original(2)],before=structuredClone(rows),call=records(rows);
  const first=await call({limit:2});assert.equal(first.total,3);assert.deepEqual(first.items.map(r=>r.recordId),[id(1),id(2)]);assert.equal(first.hasMore,true);
  const last=await call({limit:2,cursor:first.nextCursor});assert.deepEqual(last.items.map(r=>r.recordId),[id(3)]);assert.equal(last.nextCursor,null);
  assert.equal((await call({participantRef:id(2)})).total,1);
  assert.equal((await call({outcome:'lost'})).total,0);
  await assert.rejects(call({outcome:'won',cursor:first.nextCursor}),{code:'INVALID_RECORD_QUERY'});
  await assert.rejects(call({participantRef:id(3),cursor:first.nextCursor}),{code:'INVALID_RECORD_QUERY'});
  await assert.rejects(call({cursor:first.nextCursor.slice(0,-1)+(first.nextCursor.endsWith('a')?'b':'a')}),{code:'INVALID_RECORD_QUERY'});
  assert.deepEqual(rows,before);
});
test('query bounds reject unexpected fields, raw OpenIDs, invalid cursor and malformed limit',async()=>{
  const call=records([]);
  for(const payload of [null,[],{limit:0},{limit:51},{limit:1.1},{limit:'20'},{outcome:'redeemed'},{participantRef:'wx-real-openid'},{cursor:'forged'},{openId:'victim'},{limit:NaN}]) await assert.rejects(call(payload),{code:'INVALID_RECORD_QUERY'});
  const empty=await call({limit:50});assert.deepEqual(empty.items,[]);assert.equal(empty.total,0);assert.equal(empty.hasMore,false);
});
test('legacy and incomplete records remain visible without fabricated coupon-center status',async()=>{
  const call=records([original(1,{status:'redeemed',redeemedAt:at-10}),original(2,{createdAt:'bad',prize:null}),original(3,{prize:{kind:'physical'}})]);
  const result=await call();assert.equal(result.items[0].issuance.status,'legacy');assert.equal(result.items[0].legacyStatus,'redeemed');assert.equal(result.items[0].redemption.status,'unknown');assert.equal(result.items[0].redemption.source,'legacy_record');
  assert.equal(result.items[1].outcome,'unknown');assert.equal(result.items[1].createdAt,null);assert.ok(result.warnings.includes('LEGACY_RECORDS'));
  assert.equal(result.items[2].prize,null);assert.equal(result.items[2].outcome,'won');
  assert.ok(!JSON.stringify(result).includes('ABCDEF0123456789'));
});
test('scarf misses, pending issuance and wins use persisted outcomes and never expose identity or code',async()=>{
  const rows=[original(1,{outcome:'lost',status:'lost',openId:'private-openid-one'}),original(2,{outcome:'won',openId:'private-openid-two',fulfillment:'cashier',center:binding(2),couponId:null})];
  let refs;
  const center={...centerIdentity,recordStatuses:async value=>{refs=value;return {...centerIdentity,checkedAt:at,items:value.map(r=>({recordId:r.recordId,result:'not_found'}))};}};
  const result=await records(rows,{mode:'scarf',center})();
  assert.equal(result.items[0].outcome,'lost');assert.equal(result.items[0].prize,null);assert.equal(result.items[0].issuance.status,'not_applicable');
  assert.equal(result.items[1].issuance.status,'pending');assert.equal(result.items[1].redemption.status,'unknown');assert.equal(refs.length,1);assert.equal(refs[0].awardId,'scarf-'+id(2));
  assert.ok(!JSON.stringify(result).includes('private-openid'));assert.ok(!JSON.stringify(result).includes('ABCDEF0123456789'));
  assert.equal((await records(rows,{mode:'scarf'})({outcome:'lost'})).items.length,1);
});
test('center status resolves already-issued pending responses without issuing, syncing, or altering a draw',async()=>{
  const rows=[original(1,{physicalCenter:binding(1)}),original(2,{cashCenter:binding(2),centerCouponId:'coupon-two'})],before=structuredClone(rows);
  let calls=0;
  const center={...centerIdentity,recordStatuses:async refs=>{calls++;return {...centerIdentity,checkedAt:at,items:refs.map((r,i)=>({recordId:r.recordId,result:'verified',couponId:i?'coupon-two':'coupon-one',state:i?'REDEEMED':'AVAILABLE',redeemedAt:i?at-20:null}))};}};
  const result=await records(rows,{center})();assert.equal(calls,1);assert.equal(result.items[0].issuance.couponId,'coupon-one');assert.equal(result.items[0].issuance.status,'issued');
  assert.equal(result.items[1].redemption.status,'REDEEMED');assert.equal(result.items[1].redemption.redeemedAt,at-20);assert.deepEqual(rows,before);
});
test('center outage and identity mismatch fail status closed without hiding durable draws',async()=>{
  const rows=[original(1,{physicalCenter:binding(1),physicalCouponId:'coupon-one'})];
  const failed=await records(rows,{center:{...centerIdentity,recordStatuses:async()=>{throw new Error('network secret');}}})();
  assert.equal(failed.items.length,1);assert.equal(failed.items[0].redemption.status,'unknown');assert.deepEqual(failed.warnings,['CENTER_STATUS_UNAVAILABLE']);
  const mismatched=await records(rows,{center:{centerId:'wrong',environment:'production',recordStatuses:async()=>{throw new Error('must not call');}}})();
  assert.deepEqual(mismatched.warnings,['CENTER_BINDING_UNVERIFIED']);
});
test('malformed center batch discards all partial assertions and does not leak error details',async()=>{
  const rows=[original(1,{physicalCenter:binding(1)}),original(2,{physicalCenter:binding(2)})];
  const result=await records(rows,{center:{...centerIdentity,recordStatuses:async refs=>({...centerIdentity,checkedAt:at,items:[{recordId:refs[0].recordId,result:'verified',couponId:'coupon-one',state:'AVAILABLE'},{recordId:refs[1].recordId,result:'verified',couponId:'coupon-two',state:'REDEEMED',redeemedAt:null}]})}})();
  assert.ok(result.items.every(row=>row.redemption.status==='unknown'&&row.issuance.status==='pending'&&row.issuance.couponId===null));
});
test('out-of-scope or out-of-order reader data errors are not reported as empty history',async()=>{
  for(const rows of [[original(1,{campaignId:'other'})],[original(2),original(1)]]) {
    await assert.rejects(createDrawRecords({readPage:async()=>({rows,total:rows.length}),campaignId:'records-fixture',key,now})(),{code:'RECORDS_UNAVAILABLE'});
  }
});
test('cloud records reader uses bounded queries, count and keyset pagination only',async()=>{
  const calls=[];
  const db={command:{in:v=>({in:v}),gt:v=>({gt:v})},collection(name){
    calls.push(['collection',name]);
    return {where(filter){
      calls.push(['where',filter]);
      return {count:async()=>({total:9}),orderBy(key,order){
        calls.push(['order',key,order]);
        return {limit(n){calls.push(['limit',n]);return {get:async()=>({data:[]})};}};
      }};
    }};
  }};
  const call=createCloudRecordsReader(db,'lottery_entries');
  assert.deepEqual(await call({campaignId:'fixture',mode:'original',limit:20,after:id(1),outcome:'won',participantRef:''}),{rows:[],total:9});
  assert.ok(calls.some(row=>row[0]==='limit'&&row[1]===21));assert.ok(calls.some(row=>row[0]==='where'&&row[1]._id?.gt===id(1)));assert.ok(calls.some(row=>row[0]==='where'&&row[1]['prize.kind']?.in.length===2));
});
function signed(campaignId,extra={}) {
  const body=JSON.stringify({campaignId,action:'records',payload:{limit:20}}),nonce=crypto.randomBytes(12).toString('hex'),timestamp=String(at);
  return {path:'/api/scarf-management',httpMethod:'POST',body,headers:{'content-type':'application/json','x-lottery-time':timestamp,'x-lottery-nonce':nonce,'x-lottery-signature':crypto.createHmac('sha256',key).update(timestamp+'\n'+nonce+'\n'+body).digest('hex')},...extra};
}
for(const type of ['original','scarf'])test(type+' management records require signed server requests and consume only replay nonce',async()=>{
  const campaignId=type==='original'?'records-fixture':'scarf-xhs-50-v1',rows=[original(1,{campaignId,outcome:'lost',status:'lost'})],writes=[],tables=new Map();let reads=0;
  const store={readEntries:async query=>{reads++;return reader(rows)(query);},transaction:async job=>job({get:async(table,id)=>tables.get(table+':'+id),set:async(table,id,value)=>{writes.push([table,id]);tables.set(table+':'+id,value);}})};
  const call=type==='original'?createManagementHttp({store,key,campaign:{id:campaignId},prizes:[],now}):scarf.createManagementHttp({store,key,now});
  const invalid=signed(campaignId);invalid.headers['x-lottery-signature']='0'.repeat(64);
  assert.equal((await call(invalid)).statusCode,401);assert.equal(reads,0);assert.equal(writes.length,0);
  const browser=signed(campaignId);browser.headers.origin='';assert.ok([401,403].includes((await call(browser)).statusCode));assert.equal(reads,0);
  const event=signed(campaignId),result=await call(event);assert.equal(result.statusCode,200);assert.equal(JSON.parse(result.body).data.items.length,1);assert.equal(reads,1);assert.equal(writes.length,1);assert.match(writes[0][0],/gatewayNonces|bubble_scarf_management/);
  assert.ok([400,409].includes((await call(event)).statusCode));assert.equal(reads,1);assert.equal(writes.length,1);
});
function couponFixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'lottery-record-status-')),file=path.join(directory,'center.sqlite');let clock=at;
  const store=createCouponStore({file,now:()=>clock}),admin={id:'admin',role:'admin'},call=(action,input={})=>store.dispatch(admin,action,{requestId:crypto.randomUUID(),...input});
  t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
  const campaign=call('create-campaign',{name:'Fixture cash',amountCents:500,minimumCents:0,quota:10,startsAt:new Date(at-1000).toISOString(),expiresAt:new Date(at+3600000).toISOString()});
  const actor={id:'fixture-lottery',role:'lottery',campaignId:campaign.id};
  const coupon=store.dispatch(actor,'issue',{requestId:crypto.randomUUID(),campaignId:campaign.id,owner:'fixture-owner',awardId:'fixture-award'});
  const input={centerId:store.identity.id,environment:store.identity.environment,refs:[{recordId:id(1),campaignId:campaign.id,owner:'fixture-owner',awardId:'fixture-award',couponId:coupon.id}]};
  return {directory,file,store,admin,campaign,coupon,input,call,advance:ms=>{clock+=ms;},read:input2=>store.dispatch(admin,'lottery-record-status',input2||input)};
}
function fileHashes(f) {return Object.fromEntries([f.file,f.file+'-wal'].filter(name=>fs.existsSync(name)).map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(name)).digest('hex')]));}
test('sanitized coupon batch status performs zero DB/WAL writes, creates no tokens or expiry events',t=>{
  const f=couponFixture(t),before=fileHashes(f);f.advance(7200000);
  const result=f.read();assert.equal(result.items[0].state,'EXPIRED');assert.equal(result.items[0].result,'verified');assert.deepEqual(fileHashes(f),before);
  assert.ok(!JSON.stringify(result).includes(f.coupon.code));assert.ok(!JSON.stringify(result).includes('fixture-owner'));
  const db=new DatabaseSync(f.file,{readOnly:true});try{assert.equal(JSON.parse(db.prepare('SELECT data FROM coupons WHERE id=?').get(f.coupon.id).data).state,'AVAILABLE');}finally{db.close();}
});
test('batch status finds persisted issuance by immutable binding without creating it and rejects wrong binding',t=>{
  const f=couponFixture(t),ref={...f.input.refs[0]};delete ref.couponId;
  assert.equal(f.read({...f.input,refs:[ref]}).items[0].couponId,f.coupon.id);
  assert.equal(f.read({...f.input,refs:[{...ref,awardId:'missing'}]}).items[0].result,'not_found');
  assert.equal(f.read({...f.input,refs:[{...f.input.refs[0],owner:'wrong'}]}).items[0].result,'mismatch');
  assert.throws(()=>f.read({...f.input,centerId:'wrong'}),{code:'CENTER_MISMATCH'});
});
test('batch status enforces admin scope, strict bounds, duplicates and injection-safe identifiers',t=>{
  const f=couponFixture(t),before=fileHashes(f);
  for(const role of ['cashier','lottery'])assert.throws(()=>f.store.dispatch({id:'other',role},'lottery-record-status',f.input),{code:'FORBIDDEN'});
  for(const refs of [[],Array(51).fill(f.input.refs[0]),[f.input.refs[0],f.input.refs[0]],[{...f.input.refs[0],owner:"'; DROP TABLE coupons; --"}],[{...f.input.refs[0],code:f.coupon.code}],[{...f.input.refs[0],couponId:[]}]] ) assert.throws(()=>f.read({...f.input,refs}),{code:'INVALID_INPUT'});
  assert.deepEqual(fileHashes(f),before);
});
test('batch status keeps payment-pending state beyond expiry, releases expired reservation virtually',t=>{
  const f=couponFixture(t),actor={id:'cashier',role:'cashier'};
  const reserved=f.store.dispatch(actor,'reserve',{requestId:crypto.randomUUID(),code:f.coupon.code,eligibleCents:1000,checkoutId:'fixture-checkout'});
  f.advance(16*60000);const before=fileHashes(f);assert.equal(f.read().items[0].state,'AVAILABLE');assert.deepEqual(fileHashes(f),before);
  const reserved2=f.store.dispatch(actor,'reserve',{requestId:crypto.randomUUID(),code:f.coupon.code,eligibleCents:1000,checkoutId:'fixture-checkout-2'});
  f.store.dispatch(actor,'prepare',{requestId:crypto.randomUUID(),id:reserved2.reservation.id,orderId:'fixture-order',orderNo:'F-1',eligibleCents:1000,paidCents:500});
  f.advance(7200000);const pending=fileHashes(f);assert.equal(f.read().items[0].state,'PAYMENT_PENDING');assert.deepEqual(fileHashes(f),pending);assert.ok(reserved.reservation.id);
});
test('batch HTTP endpoint rejects unauthenticated or browser-origin calls before dispatch',async t=>{
  const f=couponFixture(t),adminToken='test-admin-token-'+crypto.randomBytes(20).toString('hex'),handler=couponHttp(f.store,{adminToken});
  const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port+'/v1/lottery/records/status',base={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(f.input)},before=fileHashes(f);
  assert.equal((await fetch(url,base)).status,401);
  assert.equal((await fetch(url,{...base,headers:{...base.headers,authorization:'Bearer '+adminToken,origin:'https://attacker.invalid'}})).status,403);
  const good=await fetch(url,{...base,headers:{...base.headers,authorization:'Bearer '+adminToken}});assert.equal(good.status,200);assert.equal((await good.json()).data.items[0].state,'AVAILABLE');assert.deepEqual(fileHashes(f),before);
});
