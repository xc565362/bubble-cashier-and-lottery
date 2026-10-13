const crypto = require('node:crypto');
const { redemptionDeadline } = require('./domain.js');
const {normalizeCatalog,entitlement}=require('./catalog.cjs');
const fault = (code, message) => Object.assign(new Error(message), { code });
const fail = message => { throw fault('INVALID_CONFIG', message); };
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const signature = inventory => JSON.stringify([1, inventory.total, Object.keys(inventory.quantities).sort().map(id => [id, inventory.quantities[id]])]);

function createPoolManagement({ store, campaign, prizes, now = Date.now, getCenter = async () => null, provisionCatalog }) {
  const key = campaign.id + ':management';
  function quantities(value,catalog=prizes) {
    const ids=catalog.map(p=>p.id).sort();
    if (!value || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(ids) ||
      ids.some(id => !Number.isSafeInteger(value[id]) || value[id] < 0 || value[id] > 1000000)) fail('每个奖品的总名额必须为 0 至 1000000 的整数');
    if (ids.reduce((sum, id) => sum + value[id], 0) < 1) fail('奖池至少保留一个名额');
    return Object.fromEntries(ids.map(id => [id, value[id]]));
  }
  function weights(value,catalog=prizes) {
    const ids=catalog.map(p=>p.id).sort();
    if (!value || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(ids) ||
      ids.some(id => !Number.isSafeInteger(value[id]) || value[id] < 0 || value[id] > 10000) ||
      ids.reduce((sum, id) => sum + value[id], 0) !== 10000) fail('固定概率合计必须为 100%，最多两位小数');
    return Object.fromEntries(ids.map(id => [id, value[id]]));
  }
  function validate(settings) {
    if (!['inventory', 'fixed'].includes(settings.mode) || typeof settings.enabled !== 'boolean' ||
      !Number.isSafeInteger(settings.revision) || settings.revision < 0 || settings.baseSignature !== signature(campaign.inventory)) fail('奖池管理配置异常');
    const catalog=normalizeCatalog(settings.catalog||prizes,prizes);
    quantities(settings.quantities,catalog); weights(settings.weightsBps,catalog);
    for(const p of catalog)if(p.retired&&settings.weightsBps[p.id]!==0)fail('已停用奖项概率必须为0');
    settings.catalog=catalog;
    return settings;
  }
  async function readSettings(tx) {
    if (!campaign.inventory) return null;
    const saved = await tx.get('pools', key);
    const defaults = { version: 1, revision: 0, mode: 'inventory', enabled: campaign.enabled !== false,
      quantities: { ...campaign.inventory.quantities }, weightsBps: Object.fromEntries(prizes.map(p => [p.id, Math.round(p.probability * 100)])),
      baseSignature: signature(campaign.inventory), catalog:normalizeCatalog(prizes,prizes), updatedAt: null, lastAudit: null };
    return validate(saved || defaults);
  }
  function inventory(settings) {
    const q = quantities(settings.quantities,settings.catalog);
    const ids=settings.catalog.map(p=>p.id);
    return { version: 1, total: ids.reduce((sum, id) => sum + q[id], 0), quantities: q };
  }
  function assertFixedAvailable(settings, stock) {
    if (settings?.mode !== 'fixed') return;
    const depleted = settings.catalog.filter(p => settings.weightsBps[p.id] > 0 && stock.quantities[p.id] === 0);
    if (depleted.length) throw fault('FIXED_STOCK_EMPTY', `${depleted.map(p => p.name).join('、')}名额已用完，固定概率抽奖已暂停，请补充名额或调整概率`);
  }
  async function read(tx) {
    const settings = await readSettings(tx);
    if (!settings) fail('当前活动不是固定名额奖池');
    const marker = await tx.get('pools', campaign.id + ':init');
    const stock = await tx.get('pools', campaign.id + ':stock');
    const config = inventory(settings);
    const ids=settings.catalog.map(p=>p.id).sort();
    if (!marker || !stock) throw fault('POOL_NOT_READY', '原奖池尚未初始化，管理操作不会创建或重置奖池');
    if (marker.campaignId !== campaign.id || stock.campaignId !== campaign.id || marker.version !== 1 || stock.version !== 1 ||
      marker.initializedAt !== stock.initializedAt || !Number.isSafeInteger(marker.initializedAt) ||
      marker.signature !== signature(config) || stock.signature !== marker.signature ||
      !Number.isSafeInteger(stock.remaining) || !Number.isSafeInteger(stock.allocated) || stock.remaining < 0 || stock.allocated < 0 ||
      stock.remaining + stock.allocated !== config.total || !stock.quantities ||
      JSON.stringify(Object.keys(stock.quantities).sort()) !== JSON.stringify(ids) ||
      ids.some(id => !Number.isSafeInteger(stock.quantities[id]) || stock.quantities[id] < 0 || stock.quantities[id] > config.quantities[id]) ||
      ids.reduce((sum, id) => sum + stock.quantities[id], 0) !== stock.remaining) throw fault('POOL_CORRUPT', '原奖池数据不一致，已禁止修改，请先核对备份');
    return { settings, marker, stock, config };
  }
  async function snapshot() {
    const result = await store.transaction(async tx => {
      const { settings, stock, config } = await read(tx);
      const audit = [];
      for (let n = settings.revision; n > Math.max(0, settings.revision - 30); n--) {
        const row = await tx.get('pools', campaign.id + ':audit:' + n);
        if (row) audit.push(row);
      }
      let blockedReason = '';
      try { assertFixedAvailable(settings, stock); } catch (error) { blockedReason = error.message; }
      return { service: 'bubble-lottery-management', version: 1, campaignId: campaign.id, title: campaign.title,
        revision: settings.revision, enabled: settings.enabled, mode: settings.mode, startsAt: campaign.startsAt, endsAt: campaign.endsAt, redemptionEndsAt: redemptionDeadline(campaign),
        total: config.total, allocated: stock.allocated, remaining: stock.remaining, blockedReason, audit,
        catalog:settings.catalog, capabilities:[],
        prizes: settings.catalog.map(p => ({ ...p, amount: p.amount || 0,
          quota: config.quantities[p.id], allocated: config.quantities[p.id] - stock.quantities[p.id], remaining: stock.quantities[p.id],
          weightBps: settings.weightsBps[p.id], effectiveProbability: blockedReason || !stock.remaining || !settings.enabled || now()<campaign.startsAt || now()>=campaign.endsAt ? 0 : settings.mode === 'fixed' ? settings.weightsBps[p.id] / 100 : stock.quantities[p.id] / stock.remaining * 100 })) };
    });
    try { result.center = await getCenter(result.catalog); if(result.center?.catalogSupported&&typeof provisionCatalog==='function')result.capabilities=['catalog-v1','lottery-catalog-v1']; } catch { result.center = null; result.centerError = '券中心数量暂时无法核对，暂停与降低名额以外的修改不可用'; }
    // Only report identity returned by the verified center reader. This describes
    // the cloud redemption connection, not local SKU matching or stock readiness.
    const centerIdentity = typeof result.center?.centerId === 'string' && result.center.centerId.length > 0 &&
      ['production', 'development'].includes(result.center.environment);
    const physicalRequired = result.catalog.some(prize => prize.kind === 'physical');
    result.fulfillment = {
      ready: centerIdentity && (!physicalRequired || result.center.physicalSupported === true),
      centerId: centerIdentity ? result.center.centerId : '',
      environment: centerIdentity ? result.center.environment : '',
    };
    return result;
  }
  async function update(input, actor = 'cashier-admin') {
    if (!input || !/^[a-zA-Z0-9_-]{16,80}$/.test(input.requestId || '') || !Number.isSafeInteger(input.expectedRevision) ||
      typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 200) fail('请填写修改原因并刷新后再保存');
    if (!['pause', 'resume', 'configure'].includes(input.operation)) fail('不支持的奖池管理操作');
    const requestKey = campaign.id + ':request:' + hash(input.requestId);
    const fingerprint = hash(input);
    const previous = await store.transaction(tx => tx.get('pools', requestKey));
    if (previous) { if (previous.fingerprint !== fingerprint) fail('重复请求的内容不一致'); return { revision: previous.revision, duplicate: true }; }
    const before=await store.transaction(read);
    if(before.settings.revision!==input.expectedRevision)throw fault('REVISION_CONFLICT','配置已被另一台电脑修改，请刷新后重新核对');
    let requestedCatalog=before.settings.catalog;
    if(input.catalog!==undefined){
      if(input.operation!=='configure'||before.settings.enabled)throw fault('POOL_ACTIVE','请先暂停新抽奖，再修改奖项');
      requestedCatalog=normalizeCatalog(input.catalog,prizes);
      for(const old of before.settings.catalog){const next=requestedCatalog.find(p=>p.id===old.id);if(!next)fail('删除奖项请停用并保留历史ID');if(entitlement(next)!==entitlement(old))fail('更换商品、面额或权益请新增奖项ID，保留原中奖记录');if(old.centerCampaignId)next.centerCampaignId=old.centerCampaignId;else delete next.centerCampaignId;}
      for(const p of requestedCatalog)if(!before.settings.catalog.some(old=>old.id===p.id))delete p.centerCampaignId;
    }
    const requested = input.operation === 'configure' ? quantities(input.quantities,requestedCatalog) : null;
    const weightBps = input.operation === 'configure' ? weights(input.weightsBps,requestedCatalog) : null;
    if (requested && !['inventory', 'fixed'].includes(input.mode)) fail('请选择有效抽奖模式');
    if(requested)for(const p of requestedCatalog){const allocated=(before.config.quantities[p.id]||0)-(before.stock.quantities[p.id]||0);if(requested[p.id]<allocated)fail('总名额不能小于已经抽中的数量');if(p.retired&&(requested[p.id]!==allocated||weightBps[p.id]!==0))fail('停用奖项请将总名额设为已抽中数量，并将概率设为0');}
    let center = null;
    if(input.catalog!==undefined){
      if(typeof provisionCatalog!=='function')throw fault('CATALOG_UNSUPPORTED','券中心尚未升级完整奖品管理，不能保存奖项修改');
      const preflight=await getCenter(before.settings.catalog);
      if(!preflight?.catalogSupported)throw fault('CATALOG_UNSUPPORTED','券中心尚未升级完整奖品管理，不能保存奖项修改');
      requestedCatalog=await provisionCatalog({catalog:requestedCatalog,previous:before.settings.catalog,quantities:requested,requestId:input.requestId,reason:input.reason.trim()});
      requestedCatalog=normalizeCatalog(requestedCatalog,prizes);
    }
    if (input.operation !== 'pause') { try { center = await getCenter(requestedCatalog); } catch {} }
    if(input.catalog!==undefined&&!center)throw fault('CENTER_CAPACITY','更新后的奖品与券中心未核对通过，奖池配置尚未保存');
    return store.transaction(async tx => {
      const previous = await tx.get('pools', requestKey);
      if (previous) { if (previous.fingerprint !== fingerprint) fail('重复请求的内容不一致'); return { revision: previous.revision, duplicate: true }; }
      const { settings, marker, stock, config } = await read(tx);
      if (settings.revision !== input.expectedRevision) throw fault('REVISION_CONFLICT', '配置已被另一台电脑修改，请刷新后重新核对');
      if (input.operation === 'configure' && settings.enabled) throw fault('POOL_ACTIVE', '请先暂停新抽奖，再调整模式、概率或名额');
      const next = { ...settings, enabled: input.operation === 'resume', ...(requested ? { mode: input.mode, quantities: requested, weightsBps: weightBps,catalog:requestedCatalog } : {}),
        revision: settings.revision + 1, updatedAt: now() };
      validate(next);
      const nextConfig = inventory(next);
      const nextStock = { ...stock, quantities: { ...stock.quantities }, signature: signature(nextConfig) };
      const ids=next.catalog.map(p=>p.id);
      for (const id of ids) {
        const allocated = (config.quantities[id]||0) - (stock.quantities[id]||0);
        if (nextConfig.quantities[id] < allocated) fail('总名额不能小于已经抽中的数量');
        nextStock.quantities[id] = nextConfig.quantities[id] - allocated;
        if(next.catalog.find(p=>p.id===id).retired&&nextStock.quantities[id]!==0)fail('停用奖项请将总名额设为已抽中数量，并将概率设为0');
        if (input.operation !== 'pause' && (input.operation === 'resume' || nextConfig.quantities[id] > (config.quantities[id]||0))) {
          const capacity = center?.prizes?.[id];
          if (!capacity || !Number.isSafeInteger(capacity.quota) || capacity.quota < nextConfig.quantities[id] || capacity.issued > allocated ||
            (input.operation === 'resume' && capacity.enabled === false && nextStock.quantities[id] > 0 && (next.mode !== 'fixed' || next.weightsBps[id] > 0))) {
            throw fault('CENTER_CAPACITY', `${next.catalog.find(p => p.id === id).name}的券中心上限或已发数量未核对通过，不能增加名额或恢复抽奖`);
          }
        }
      }
      nextStock.remaining = ids.reduce((sum, id) => sum + nextStock.quantities[id], 0);
      if (input.operation === 'resume') {
        if (now() >= campaign.endsAt || now() >= redemptionDeadline(campaign)) fail('活动已结束，不能通过恢复按钮延长活动');
        if (!nextStock.remaining) throw fault('SOLD_OUT', '可抽名额已用完');
        assertFixedAvailable(next, nextStock);
      }
      const audit = { revision: next.revision, at: next.updatedAt, actor, operation: input.operation, reason: input.reason.trim(),
        before: { mode: settings.mode, enabled: settings.enabled, quantities: settings.quantities, weightsBps: settings.weightsBps,catalog:settings.catalog },
        after: { mode: next.mode, enabled: next.enabled, quantities: next.quantities, weightsBps: next.weightsBps,catalog:next.catalog } };
      await tx.set('pools', key, next);
      await tx.set('pools', campaign.id + ':stock', nextStock);
      await tx.set('pools', campaign.id + ':init', { ...marker, signature: nextStock.signature });
      await tx.set('pools', campaign.id + ':audit:' + next.revision, audit);
      await tx.set('pools', requestKey, { fingerprint, revision: next.revision, at: next.updatedAt });
      return { revision: next.revision, duplicate: false };
    });
  }
  return { readSettings, inventory, assertFixedAvailable, snapshot, update, signature };
}
module.exports = { createPoolManagement, signature };
