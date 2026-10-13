export function createApi(config, {fetchImpl = fetch, now = Date.now} = {}) {
  let token='',expiresAt=0;
  const base=String(config.apiBase||'').replace(/\/$/,'');
  const validBase=/^https:\/\//.test(base) || (['localhost','127.0.0.1','[::1]'].includes(globalThis.location?.hostname)&&/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/.test(base));
  const authError=()=>Object.assign(new Error('登录已失效，请从小程序重新进入活动'),{code:'AUTH_REQUIRED'});
  async function request(path, body, authenticated) {
    if (!validBase) throw Object.assign(new Error('活动页面正在准备中，请稍后从小程序重新进入'),{code:'NOT_CONFIGURED'});
    if(authenticated && (!token || expiresAt<=now())){token='';throw authError();}
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
    try {
      const response=await fetchImpl(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(authenticated?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body),signal:controller.signal,cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});
      let result;try{result=await response.json();}catch{throw new Error('活动服务返回异常，请稍后重试');}
      if(response.status===401 || ['AUTH_REQUIRED','TOKEN_EXPIRED','INVALID_TOKEN'].includes(result.code)){token='';expiresAt=0;throw authError();}
      if(!response.ok || !result.ok)throw Object.assign(new Error(result.message||'活动服务暂不可用，请稍后重试'),{code:result.code||'SERVICE_ERROR'});
      return result.data;
    } catch(error) {
      if(error.name==='AbortError'||error instanceof TypeError)throw Object.assign(new Error('网络连接失败，请重试；已中奖结果会为你保留'),{code:'NETWORK_ERROR'});
      throw error;
    } finally {clearTimeout(timeout);}
  }
  return {
    isPreview:false,
    async login(code){token='';expiresAt=0;if(!code)throw authError();const data=await request('/session',{code},false);if(typeof data.token!=='string'||!Number.isFinite(data.expiresAt)||data.expiresAt<=now())throw new Error('登录验证失败，请重新进入');token=data.token;expiresAt=data.expiresAt;},
    call:(action,payload={})=>request('/call',{action,payload},true),
    logout(){token='';expiresAt=0;},
    hasSession:()=>!!token&&expiresAt>now()
  };
}
