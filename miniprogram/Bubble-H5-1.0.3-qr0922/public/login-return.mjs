const SDK_URL='https://res.wx.qq.com/open/js/jweixin-1.6.0.js';
let sdkPromise;
export function loginReturnPath({activity,entryPage,route,inviteCode}) {
  const scarf=activity==='scarf',fixed=scarf?'/pages/scarf-h5/index':'/pages/bubble-h5/index';
  if(entryPage&&entryPage!==fixed)throw new Error('活动入口配置不匹配，请返回小程序重新打开');
  const allowed=scarf?['home','result','rules','staff']:['home','prize','rules','staff'];
  const target=allowed.includes(route)?route:'home';
  return fixed+'?return_route='+encodeURIComponent('/'+target)+(scarf&&/^[A-F0-9]{16}$/.test(inviteCode||'')?'&inviteCode='+encodeURIComponent(inviteCode):'');
}
function loadSdk(){
  if(globalThis.wx?.miniProgram)return Promise.resolve(globalThis.wx);
  if(!sdkPromise)sdkPromise=new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src=SDK_URL;script.referrerPolicy='no-referrer';
    const timeout=setTimeout(()=>{script.remove();reject(new Error('请点击微信左上角返回小程序，再重新进入活动'));},8000);
    script.onload=()=>{clearTimeout(timeout);globalThis.wx?.miniProgram?resolve(globalThis.wx):reject(new Error('请返回小程序，再重新进入活动'));};
    script.onerror=()=>{clearTimeout(timeout);script.remove();reject(new Error('微信连接暂不可用，请返回小程序重新进入'));};
    document.head.append(script);
  }).catch(error=>{sdkPromise=null;throw error;});
  return sdkPromise;
}
export async function returnToMiniProgram(options,{sdk,timeoutMs=8000}={}) {
  const url=loginReturnPath(options),wx=sdk||await loadSdk();
  return new Promise((resolve,reject)=>{
    let done=false;const finish=error=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve();};
    const timer=setTimeout(()=>finish(new Error('请点击左上角返回小程序，再重新进入活动')),timeoutMs);
    try{wx.miniProgram.getEnv(result=>{
      if(done)return;
      if(result?.miniprogram!==true)return finish(new Error('请用微信扫描活动小程序码进入；普通网页不能完成微信登录'));
      wx.miniProgram.redirectTo({url,success:()=>finish(),fail:()=>finish(new Error('请返回小程序，从活动入口重新进入'))});
    });}catch{finish(new Error('请返回小程序，从活动入口重新进入'));}
  });
}
