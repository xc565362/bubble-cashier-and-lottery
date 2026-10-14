// The server supplies the outcome. Randomness here only picks one of four
// visually equivalent cells; it never decides whether a participant wins.
export function createWheel({onStep, reducedMotion=false, setTimer=setTimeout, clearTimer=clearTimeout, random=Math.random}={}){
  if(typeof onStep!=='function')throw new TypeError('onStep is required');
  let phase='idle',timer=null,index=-1,moves=0,promise=null,resolveFinish=null,serverOutcome=null;
  const stopTimer=()=>{if(timer!==null){clearTimer(timer);timer=null;}};
  const schedule=(callback,delay)=>{
    if(phase==='cancelled'||phase==='complete')return;
    timer=setTimer(()=>{timer=null;callback();},delay);
  };
  const emit=()=>onStep(index);
  const spin=()=>{
    if(phase!=='spinning')return;
    index=(index+1)%8;moves++;emit();
    if(phase==='spinning')schedule(spin,80);
  };
  function start(){
    if(phase!=='idle')return;
    phase='spinning';
    if(reducedMotion)return;
    index=0;emit();
    if(phase==='spinning')schedule(spin,80);
  }
  function cancel(){
    stopTimer();phase='cancelled';
    if(resolveFinish){const resolve=resolveFinish;resolveFinish=null;resolve(false);}
  }
  function finish(outcome){
    if(outcome!=='won'&&outcome!=='lost'){
      cancel();return Promise.reject(new TypeError('Expected server outcome won or lost'));
    }
    if(phase==='cancelled')return Promise.resolve(false);
    if(promise){
      if(outcome!==serverOutcome){cancel();return Promise.reject(new Error('The server outcome cannot change during a draw'));}
      return promise;
    }
    let value;
    try{value=Number(random());}catch(error){cancel();return Promise.reject(error);}
    const slot=Math.min(3,Math.max(0,Math.floor((Number.isFinite(value)?value:0)*4)));
    const target=slot*2+(outcome==='lost'?1:0);
    serverOutcome=outcome;
    promise=new Promise(resolve=>{resolveFinish=resolve;});
    if(phase==='idle')start();
    if(phase==='cancelled')return promise;
    stopTimer();phase='settling';
    const complete=()=>{
      if(phase!=='settling')return;
      phase='complete';const resolve=resolveFinish;resolveFinish=null;resolve(true);
    };
    if(reducedMotion){index=target;emit();complete();return promise;}
    const rounds=Math.max(1,3-Math.floor(moves/8));
    const count=rounds*8+(target-index+8)%8;
    const duration=Math.max(1300,3100-moves*80);
    const weights=Array.from({length:count},(_,step)=>0.45+1.55*((step+1)/count)**2);
    const sum=weights.reduce((total,weight)=>total+weight,0);
    let step=0;
    const settle=()=>{
      if(phase!=='settling')return;
      index=(index+1)%8;step++;emit();
      if(phase!=='settling')return;
      if(step===count){schedule(complete,300);return;}
      schedule(settle,duration*weights[step]/sum);
    };
    schedule(settle,duration*weights[0]/sum);
    return promise;
  }
  return {start,finish,cancel};
}
