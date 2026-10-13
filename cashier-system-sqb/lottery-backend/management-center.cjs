const { redemptionDeadline } = require('./domain.js');
function createManagementCenter({ config, prizes, campaign, fetchFn = fetch,allowLocalTest=false }) {
  async function request(route, body) {
    const origin = new URL(config?.baseUrl || 'https://invalid.invalid');
    if (!(origin.protocol === 'https:'||allowLocalTest&&config.environment==='development'&&origin.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(origin.hostname)) || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash ||
      !config?.centerId || !/^[A-Za-z0-9_.-]{32,300}$/.test(config.adminToken || '')) throw new Error('券中心管理配置尚未完成');
    const response = await fetchFn(new URL(route, origin), { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Authorization: 'Bearer ' + config.adminToken, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new Error('券中心请求失败，请核对服务器版本与连接');
    return result.data;
  }
  async function read(catalog=prizes) {
    const info = await request('/v1/info');
    if (info.service !== 'stall-coupon-center' || info.centerId !== config.centerId || info.environment !== (allowLocalTest&&config.environment==='development'?'development':'production') || info.role !== 'admin') throw new Error('券中心身份不匹配');
    const campaigns = await request('/v1/campaigns');
    const mapped = {};
    const used = new Set();
    for (const prize of catalog) {
      const id = prize.centerCampaignId||config.prizes?.[prize.id];
      const c = campaigns.find(item => item.id === id);
      if (!c || used.has(id) || (c.kind || 'cash') !== prize.kind || Date.parse(c.startsAt) !== campaign.startsAt || Date.parse(c.expiresAt) !== campaign.redeemEndsAt ||
        (campaign.redemptionEndsAt != null && Date.parse(c.redemptionEndsAt) !== redemptionDeadline(campaign)) ||
        (prize.kind === 'physical' ? c.physical?.prizeId !== prize.id || c.physical.quantity !== 1 || prize.product&&['sku','barcode'].some(key=>(c.physical.product?.[key]||'')!==(prize.product[key]||'')) : c.amountCents !== Math.round(prize.amount * 100) || prize.centerCampaignId&&c.minimumCents!==(prize.minimumCents||0))) throw new Error('奖品与券中心映射不一致');
      used.add(id);
      mapped[prize.id] = { campaignId: id, quota: c.quota, issued: c.issued, enabled: c.enabled, redemptionEnabled: c.redemptionEnabled ?? true, redemptionEndsAt: c.redemptionEndsAt || c.expiresAt };
    }
    return { centerId: info.centerId, environment: info.environment,
      physicalSupported: info.capabilities?.includes('physical-prize-v1') === true,
      catalogSupported:info.capabilities?.includes('lottery-catalog-v1')===true, quotaAdjustmentSupported: info.capabilities?.includes('quota-increase-v1') === true, prizes: mapped };
  }
  async function counts(current) {
    const result = current ? structuredClone(current) : await read();
    for (const p of Object.values(result.prizes)) {
      const rows = await request('/v1/coupons?campaignId=' + encodeURIComponent(p.campaignId) + '&state=REDEEMED');
      p.redeemed = rows.total;
    }
    return result;
  }
  async function increase({ prizeId, quota, requestId, reason },catalog=prizes) {
    const center = await read(catalog);
    if (!center.prizes[prizeId] || !Number.isSafeInteger(quota) || quota < 1 || quota > 1000000 || typeof reason !== 'string' || !reason.trim()) throw new Error('券发放上限或原因无效');
    if (!center.quotaAdjustmentSupported) throw new Error('券服务器需要升级后才能提高发放上限，抽奖名额尚未改变');
    return request('/v1/campaigns/quota', { id: center.prizes[prizeId].campaignId, quota, requestId, reason });
  }
  async function provision({catalog,previous,quantities,requestId,reason='目录发布重试'}){
    const {createCatalogCenter}=require('./catalog-center.cjs');const client=createCatalogCenter({config,fetchFn,allowLocalTest});await client.verify();
    const prepared=[];
    for(const prize of catalog){
      const old=previous.find(p=>p.id===prize.id);
      if(old&&!old.centerCampaignId){prepared.push(prize);continue;}
      const id='catalog-'+require('node:crypto').createHash('sha256').update(requestId+':'+prize.id).digest('hex');
      const {centerCampaignId,...safe}=prize;
      const result=await client.request('/v1/campaigns/lottery-provision',{requestId:id,campaignId:campaign.id,prize:safe,quota:quantities[prize.id],startsAt:new Date(campaign.startsAt).toISOString(),expiresAt:new Date(campaign.redeemEndsAt).toISOString(),redemptionEndsAt:new Date(redemptionDeadline(campaign)).toISOString()});
      if(!result?.campaign?.id||old?.centerCampaignId&&result.campaign.id!==old.centerCampaignId)throw new Error('奖品履约引用不一致');
      if(!old&&Number.isSafeInteger(result.campaign.quota)&&result.campaign.quota<quantities[prize.id]){
        if(result.campaign.issued!==0||result.campaign.lotteryCatalog?.campaignId!==campaign.id||result.campaign.lotteryCatalog?.prizeId!==prize.id)throw Object.assign(new Error('该奖项已产生中心发放记录或活动身份不一致，请刷新目录核对，不能按未发布奖项恢复'),{code:'CENTER_CAPACITY'});
        await client.request('/v1/campaigns/quota',{id:result.campaign.id,quota:quantities[prize.id],requestId:'catalog-capacity-'+require('node:crypto').createHash('sha256').update(requestId+':'+prize.id).digest('hex'),reason:'恢复未发布奖项名额：'+String(reason).slice(0,180)});
      }
      prepared.push({...prize,centerCampaignId:result.campaign.id});
    }
    return prepared;
  }
  return { read, counts, increase,provision };
}
module.exports = { createManagementCenter };
