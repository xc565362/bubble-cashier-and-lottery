export function createApi(config, {fetchImpl = fetch, now = Date.now, onAuthExpired = () => {}, setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
  let token='',expiresAt=0,generation=0,expiryTimer;
  const base=String(config.apiBase||'').replace(/\/$/,'');
  let validBase=false;
  try { const url=new URL(base);validBase=!url.username&&!url.password&&!url.search&&!url.hash&&(url.protocol==='https:'||(['localhost','127.0.0.1','[::1]'].includes(globalThis.location?.hostname)&&url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))); } catch {}
  const authError=()=>Object.assign(new Error('登录已失效，请返回小程序重新进入活动'),{code:'AUTH_REQUIRED'});
  function clear(notify=false){token='';expiresAt=0;generation++;clearTimer(expiryTimer);if(notify)onAuthExpired(authError());}
  async function request(path, body, authenticated) {
    if (!validBase) throw Object.assign(new Error('活动页面正在准备中，请稍后从小程序重新进入'),{code:'NOT_CONFIGURED'});
    if(authenticated&&(!token||expiresAt<=now())){clear(true);throw authError();}
    const epoch=generation,controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
    try {
      const response=await fetchImpl(base+path,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...(authenticated?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body),signal:controller.signal,cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});
      let result;try{result=await response.json();}catch{throw new Error('活动服务返回异常，请稍后重试');}
      if(epoch!==generation)throw authError();
      if(response.status===401||['AUTH_REQUIRED','TOKEN_EXPIRED','INVALID_TOKEN','SESSION_EXPIRED','UNAUTHENTICATED','LOGIN_REUSED'].includes(result.code)){clear(true);throw authError();}
      if(!response.ok||!result.ok)throw Object.assign(new Error(result.message||result.error||'活动服务暂不可用，请稍后重试'),{code:result.code||'SERVICE_ERROR'});
      return result.data;
    } catch(error) {
      if(error.name==='AbortError'||error instanceof TypeError)throw Object.assign(new Error('网络连接失败，请重试；已中奖结果会为你保留'),{code:'NETWORK_ERROR'});
      throw error;
    } finally {clearTimeout(timeout);}
  }
  return {
    isPreview:false,
    async login(credential){
      clear();
      const body=typeof credential==='string'?{code:credential}:credential;
      if(!body||Object.keys(body).length!==1||!(typeof body.code==='string'&&/^[A-Za-z0-9_-]{8,256}$/.test(body.code)||typeof body.ticket==='string'&&/^HT1\.[A-Za-z0-9_-]{43}$/.test(body.ticket)))throw authError();
      const epoch=generation,data=await request('/session',body,false);
      if(epoch!==generation)throw authError();
      if(typeof data.token!=='string'||!Number.isSafeInteger(data.expiresAt)||data.expiresAt<=now()||data.expiresAt>now()+30*60*1000)throw new Error('登录验证失败，请重新进入');
      token=data.token;expiresAt=data.expiresAt;
      expiryTimer=setTimer(()=>{if(epoch===generation)clear(true);},expiresAt-now());expiryTimer?.unref?.();
    },
    call:(action,payload={})=>request('/call',{action,payload},true),
    logout(){clear();},
    hasSession:()=>!!token&&expiresAt>now()
  };
}