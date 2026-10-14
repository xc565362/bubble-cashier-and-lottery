const test=require('node:test');
const assert=require('node:assert/strict');


const {createHarness,collectionSuffixes}=require('./index.js');
function database({failOneFulfillmentSync=false}={}) {
  let rows=new Map(),queue=Promise.resolve(),syncFailed=false;const touched=new Set();
  function collection(table,state) {
    touched.add(table);
    return {doc(id){return {async get(){const value=state.get(table+'/'+id);return {data:value?{...structuredClone(value),_id:id}:null};},async set({data}){if(Object.hasOwn(data,'_id'))throw Object.assign(new Error('Cannot update immutable document field _id'),{code:'DATABASE_DOCUMENT_ID_MODIFIED'});if(failOneFulfillmentSync&&!syncFailed&&table.endsWith('_scarf_entries')&&data.couponId){syncFailed=true;throw new Error('Injected temporary fulfillment sync failure');}state.set(table+'/'+id,structuredClone(data));}};},
      where(filter){
        const matches=()=>[...rows].filter(([key])=>key.startsWith(table+'/')).map(([key,row])=>({...structuredClone(row),_id:key.slice(table.length+1)})).filter(row=>Object.entries(filter).every(([key,value])=>{const actual=key.split('.').reduce((current,key)=>current?.[key],row);return value&&typeof value==='object'?value.gt!==undefined?actual>value.gt:value.in.includes(actual):actual===value;}));
        return {async count(){return {total:matches().length};},orderBy(field,order){assert.equal(order,'asc');return {limit(n){return {async get(){return {data:matches().sort((a,b)=>a[field].localeCompare(b[field])).slice(0,n)};}};}};}};
      },async count(){return {total:[...rows.keys()].filter(key=>key.startsWith(table+'/')).length};}};
  }
  return {command:{gt:value=>({gt:value}),in:value=>({in:value})},collection:table=>collection(table,rows),runTransaction(job){const pending=queue.then(async()=>{const copy=structuredClone(rows),result=await job({collection:table=>collection(table,copy)});rows=copy;return result;});queue=pending.catch(()=>{});return pending;},touched,serialize:()=>JSON.stringify([...rows])};
}
test('private cloud QA harness executes and separate harness readback preserves all results in the isolated namespace',async()=>{
  const db=database(),prefix='qa_lottery_abcdef012345',secret='c'.repeat(64),now=()=>1791886000000;
  const result=await createHarness({db,prefix,secret,now})('run');assert.equal(result.ok,true);assert.equal(result.checks.length,9);assert.equal(result.originalDraws,3);assert.equal(result.scarfWins,2);assert.equal(result.scarfMisses,1);
  const separate=await createHarness({db,prefix,secret,now})('readback');assert.equal(separate.persistenceDigest,result.persistenceDigest);
  assert.deepEqual([...db.touched].filter(name=>!name.startsWith(prefix+'_')),[]);assert.ok([...db.touched].every(name=>collectionSuffixes.includes(name.slice(prefix.length+1))));
  await assert.rejects(createHarness({db,prefix,secret,now})('run'),/QA_ALREADY_INITIALIZED_NO_RESET/);
});
test('private cloud QA harness rejects production namespace and unsupported actions without writes',async()=>{
  const db=database(),secret='c'.repeat(64);
  assert.throws(()=>createHarness({db,prefix:'lottery_entries',secret}));
  await assert.rejects(createHarness({db,prefix:'qa_lottery_abcdef012345',secret})('reset'),/QA_ACTION_DENIED/);
  assert.equal(db.serialize(),'[]');
});
test('QA harness accepts only explicit issuing response on transient sync failure and proves durable-code recovery',async()=>{
  const db=database({failOneFulfillmentSync:true}),prefix='qa_lottery_abcdef012346',secret='d'.repeat(64),now=()=>1791886000000;
  const result=await createHarness({db,prefix,secret,now})('run');
  assert.equal(result.ok,true);assert.ok(result.pendingConcurrentResponses>=1);assert.equal(result.scarfWins,2);
  assert.equal((await createHarness({db,prefix,secret,now})('readback')).persistenceDigest,result.persistenceDigest);
});
