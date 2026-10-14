'use strict';
const fail = message => { throw Object.assign(new Error(message), {code:'INVALID_CONFIG'}); };
const text = (value, limit, name, optional=false) => { if (typeof value !== 'string' || value.length > limit || (!optional&&!value.trim()) || /[\u0000-\u001f]/.test(value)) fail(name+'格式不正确'); return value.trim(); };
function normalizeCatalog(input, legacy=[]) {
  if (!Array.isArray(input)||!input.length||input.length>60) fail('奖项数量须为1至60项');
  const old = new Map(legacy.map(p=>[p.id,p])), ids=new Set();
  return input.map(p=>{
    if(!p||typeof p!=='object'||Array.isArray(p)||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(p.id||'')||ids.has(p.id))fail('奖项ID无效或重复');
    ids.add(p.id);
    if(!['cash','physical'].includes(p.kind))fail('请选择立减金或实物奖品');
    const result={id:p.id,name:text(p.name,60,'奖品名称'),shortName:text(p.shortName||p.name,60,'奖品简称'),kind:p.kind,
      label:text(p.label||'',60,'奖品标签',true),icon:text(p.icon|| (p.kind==='cash'?'ticket':'gift'),40,'奖品图标'),imageUrl:text(p.imageUrl||'',2048,'奖品图片',true),retired:p.retired===true};
    if(result.imageUrl){let u;try{u=new URL(result.imageUrl);}catch{fail('图片请使用HTTPS完整地址');}if(u.protocol!=='https:'||u.username||u.password)fail('图片请使用HTTPS完整地址');}
    if(p.kind==='cash') { if(!Number.isFinite(p.amount)||p.amount<=0||!Number.isSafeInteger(Math.round(p.amount*100))||Math.abs(p.amount*100-Math.round(p.amount*100))>1e-7||p.amount>10000)fail('立减金面额须为0.01至10000元，最多两位小数');result.amount=p.amount;result.minimumCents=p.minimumCents??0;if(!Number.isSafeInteger(result.minimumCents)||result.minimumCents<0)fail('最低消费金额无效'); }
    else if(p.product){const value=p.product;if(!value||typeof value!=='object'||Array.isArray(value))fail('请配置实物对应商品');result.product={id:text(value.id||'',120,'商品ID',true),name:text(value.name||p.name,120,'商品名称'),sku:text(value.sku||'',120,'商品SKU',true),barcode:text(value.barcode||'',120,'商品条码',true)};if(!result.product.sku&&!result.product.barcode)fail('新实物奖品必须提供唯一SKU或条码');}
    else if(!old.has(p.id))fail('新实物奖品必须绑定收银商品');
    if(p.centerCampaignId){if(!/^[A-Za-z0-9_-]{1,100}$/.test(p.centerCampaignId))fail('奖品履约引用无效');result.centerCampaignId=p.centerCampaignId;}
    return result;
  });
}
function entitlement(prize){return JSON.stringify([prize.kind,prize.kind==='cash'?prize.amount:0,prize.minimumCents||0,prize.product?[prize.product.sku,prize.product.barcode]:null]);}
function publicPrize(p){const {centerCampaignId,product,...rest}=p;return rest;}
module.exports={normalizeCatalog,entitlement,publicPrize};
