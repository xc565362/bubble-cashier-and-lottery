import config from './campaign.mjs';
// Isolated interactive fixtures. Never called when the configured mode is production.
export function createPreview(storage) {
  const key='bubble-h5-preview-qr0922-v1';
  let offline=false,forcedStatus='',busy=Promise.resolve();
  const read=()=>{try{return JSON.parse(storage.getItem(key)||'null')||{entry:null};}catch{return {entry:null};}};
  const write=value=>storage.setItem(key,JSON.stringify(value));
  const copy=value=>JSON.parse(JSON.stringify(value));
  const createEntry=kind=>({prize:copy(config.prizes.find(p=>p.id===(kind==='physical'?'cap':'cash10'))),code:kind==='physical'?'DE00000000000001':'LJC1_DE000000000000000000000000000001',createdAt:config.campaign.startsAt+3600000,expiresAt:config.campaign.redeemEndsAt,status:'pending',checkoutCoupon:kind!=='physical',requiresPos:kind==='physical',minimumGoodsAmountCents:0});
  const withState=value=>value?{...copy(value),status:forcedStatus||value.status}:null;
  return {
    isPreview:true,
    hasSession:()=>true,
    async call(action,payload={}) {
      const work=async()=>{
        if(offline)throw new Error('演示断网：领取凭证已隐藏，请恢复连接后刷新');
        const data=read();
        if(action==='state')return {campaign:copy(config.campaign),prizes:copy(config.prizes),inventory:{total:500,remaining:data.entry?499:500},entry:withState(data.entry),drawError:''};
        if(action==='draw'){if(!data.entry){data.entry=createEntry('coupon');write(data);}return withState(data.entry);}
        if(action==='identity')return {isAdmin:true,openId:'preview-staff-no-production-access'};
        if(action==='lookup') {if(!data.entry || String(payload.code||'').replace(/[\s-]/g,'').toUpperCase()!==data.entry.code.toUpperCase())throw new Error('未找到此演示奖品，请复制「我的奖品」中的演示码');return withState(data.entry);}
        if(action==='redeem'){if(!data.entry || payload.code!==data.entry.code)throw new Error('未找到此演示奖品');throw new Error(data.entry.checkoutCoupon?'购物券请在收银系统使用，不能直接核销':'实物奖品请在收银系统扫码免费入单，完成核销后发放');}
        if(action==='activityCode')throw new Error('当前为隔离预览，不生成正式活动码。正式接入后由原活动服务生成。');
        throw new Error('不支持此操作');
      };
      const task=busy.then(work);busy=task.catch(()=>{});return task;
    },
    scenario(name){offline=false;forcedStatus='';if(name==='empty'){write({entry:null});return;}if(name==='offline'){offline=true;return;}if(['coupon','physical'].includes(name)){write({entry:createEntry(name)});return;}if(name==='online')return;forcedStatus=name;if(!read().entry)write({entry:createEntry('coupon')});},
    reset(){offline=false;forcedStatus='';storage.removeItem(key);},
    isOffline:()=>offline
  };
}
