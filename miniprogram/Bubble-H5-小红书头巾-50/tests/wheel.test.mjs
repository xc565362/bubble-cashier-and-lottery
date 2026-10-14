import test from 'node:test';
import assert from 'node:assert/strict';
import {createWheel} from '../public/wheel.mjs';

function scheduler(){
  let sequence=0,time=0;const jobs=new Map(),delays=[];
  return {
    setTimer(callback,delay){const id=sequence++;jobs.set(id,{callback,at:time+delay});delays.push(delay);return id;},
    clearTimer(id){jobs.delete(id);},
    tick(){const next=[...jobs].sort((a,b)=>a[1].at-b[1].at)[0];if(!next)return false;const [id,job]=next;jobs.delete(id);time=job.at;job.callback();return true;},
    drain(){let steps=0;while(this.tick()){if(++steps>1000)throw new Error('A timer leaked');}return steps;},
    get pending(){return jobs.size;},get time(){return time;},get delays(){return delays;}
  };
}
function fixture(options={}){
  const clock=scheduler(),steps=[];
  const wheel=createWheel({onStep:index=>steps.push(index),setTimer:clock.setTimer,clearTimer:clock.clearTimer,...options});
  return {wheel,clock,steps};
}

test('the waiting animation advances clockwise and a second start cannot add a timer',()=>{
  const {wheel,clock,steps}=fixture();wheel.start();wheel.start();
  assert.deepEqual(steps,[0]);assert.equal(clock.pending,1);
  for(let i=0;i<10;i++)clock.tick();
  assert.deepEqual(steps,[0,1,2,3,4,5,6,7,0,1,2]);
  assert.equal(clock.pending,1);wheel.cancel();assert.equal(clock.pending,0);
});

test('every decorative target preserves the exact server outcome and advances in ring order',async()=>{
  for(const outcome of ['won','lost'])for(const random of [0,0.24,0.25,0.49,0.5,0.74,0.75,0.999,1]){
    const {wheel,clock,steps}=fixture({random:()=>random});wheel.start();
    const result=wheel.finish(outcome);assert.equal(wheel.finish(outcome),result);
    clock.drain();assert.equal(await result,true);
    const target=Math.min(3,Math.floor(random*4))*2+(outcome==='lost'?1:0);
    assert.equal(steps.at(-1),target);assert.equal(steps.at(-1)%2,outcome==='won'?0:1);
    assert.ok(steps.length>=25);
    for(let i=1;i<steps.length;i++)assert.equal(steps[i],(steps[i-1]+1)%8);
    assert.ok(clock.time>=3399&&clock.time<=3401);assert.equal(clock.pending,0);
    assert.equal(clock.delays.at(-1),300);
    const settlingDelays=clock.delays.slice(1,-1);
    for(let i=1;i<settlingDelays.length;i++)assert.ok(settlingDelays[i]>=settlingDelays[i-1]);
    wheel.start();wheel.cancel();wheel.cancel();assert.equal(clock.pending,0);
  }
});

test('a slow server does not require a second long animation or select a result while waiting',async()=>{
  let randomCalls=0;const {wheel,clock,steps}=fixture({random:()=>{randomCalls++;return 0.9;}});
  wheel.start();for(let i=0;i<75;i++)clock.tick();
  assert.equal(randomCalls,0);const responseAt=clock.time;
  const result=wheel.finish('lost');assert.equal(randomCalls,1);clock.drain();
  assert.equal(await result,true);assert.equal(steps.at(-1),7);
  assert.ok(clock.time-responseAt>=1599&&clock.time-responseAt<=1601);assert.equal(clock.pending,0);
});

test('cancelling before a result permanently stops the instance and never evaluates randomness',async()=>{
  for(const started of [false,true]){
    const {wheel,clock,steps}=fixture({random:()=>{throw new Error('Must not pick a target');}});
    if(started)wheel.start();const before=[...steps];wheel.cancel();wheel.cancel();wheel.start();
    assert.equal(await wheel.finish('won'),false);assert.equal(clock.drain(),0);assert.deepEqual(steps,before);
  }
});

test('cancelling while settling resolves the waiting draw and prevents late callbacks',async()=>{
  const {wheel,clock,steps}=fixture();wheel.start();const result=wheel.finish('won');
  clock.tick();clock.tick();const before=[...steps];wheel.cancel();
  assert.equal(await result,false);assert.equal(clock.pending,0);clock.drain();assert.deepEqual(steps,before);
  assert.equal(await wheel.finish('won'),false);
});

test('the final cell stays visible for 300 ms and can still be cancelled during that dwell',async()=>{
  for(const cancel of [false,true]){
    const {wheel,clock,steps}=fixture({random:()=>0});wheel.start();let settled=false;
    const result=wheel.finish('won');result.then(()=>{settled=true;});
    for(let i=0;i<24;i++)clock.tick();
    await Promise.resolve();assert.equal(steps.at(-1),0);assert.equal(steps.length,25);
    assert.equal(settled,false);assert.equal(clock.pending,1);
    const landedAt=clock.time;
    if(cancel)wheel.cancel();else clock.tick();
    assert.equal(await result,!cancel);assert.equal(clock.pending,0);
    assert.equal(clock.time-landedAt,cancel?0:300);assert.equal(steps.length,25);
  }
});

test('reduced motion waits without spinning, then shows the server result without timers',async()=>{
  for(const outcome of ['won','lost']){
    const {wheel,clock,steps}=fixture({reducedMotion:true,random:()=>0.5});wheel.start();
    assert.deepEqual(steps,[]);assert.equal(clock.pending,0);
    assert.equal(await wheel.finish(outcome),true);assert.deepEqual(steps,[outcome==='won'?4:5]);assert.equal(clock.pending,0);
  }
});

test('invalid or contradictory server results reject and cannot fabricate a winning landing',async()=>{
  for(const outcome of [undefined,null,'pending','win','',true]){
    const {wheel,clock,steps}=fixture();wheel.start();clock.tick();const before=[...steps];
    await assert.rejects(wheel.finish(outcome),/server outcome/);assert.equal(clock.pending,0);assert.deepEqual(steps,before);
    assert.equal(await wheel.finish('won'),false);
  }
  const {wheel,clock}=fixture();wheel.start();const result=wheel.finish('won');
  await assert.rejects(wheel.finish('lost'),/cannot change/);assert.equal(await result,false);assert.equal(clock.pending,0);
});

test('finish can start an idle wheel and cancellation from a step callback is respected',async()=>{
  const first=fixture();const result=first.wheel.finish('lost');first.clock.drain();assert.equal(await result,true);
  const clock=scheduler();let wheel;
  wheel=createWheel({onStep:()=>wheel.cancel(),setTimer:clock.setTimer,clearTimer:clock.clearTimer});
  assert.equal(await wheel.finish('won'),false);assert.equal(clock.pending,0);
});
