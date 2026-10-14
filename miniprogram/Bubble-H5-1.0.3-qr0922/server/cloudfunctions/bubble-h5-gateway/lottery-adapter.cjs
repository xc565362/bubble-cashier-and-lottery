'use strict';
const crypto = require('node:crypto');
const {createCloudStore} = require('./vendor/lottery/store.js');
const {createService} = require('./vendor/lottery/service.js');
const {createCenterLottery} = require('./vendor/lottery/center-lottery.cjs');
const {createPhysicalCenter} = require('./vendor/lottery/physical-center.cjs');
const {createActivityCode} = require('./vendor/lottery/activity-code.js');
const {campaign, prizes} = require('./vendor/lottery/config.js');
const configurationError = () => Object.assign(new Error('活动服务配置尚未与现有后台核对，请联系管理员'), {code: 'INVALID_CONFIG'});
function publicReceipt(entry) {
  // This adapter requires an active physical center. Every physical receipt must direct
  // staff to POS, even when the receipt is already redeemed or temporarily unavailable.
  return entry && entry.prize && entry.prize.kind === 'physical' ? {...entry, requiresPos: true} : entry;
}
function parseRequiredConfig(env, name) {
  let value;
  try { value = JSON.parse(env[name] || 'null'); } catch { throw configurationError(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw configurationError();
  return value;
}
function createLotteryAdapter({cloud, env = process.env, now = Date.now}) {
  // This snapshot already uses the shared coupon center, physical center and managed pool.
  // Missing physical configuration must fail closed; otherwise a legacy redeem could bypass POS.
  const centerConfig = parseRequiredConfig(env, 'CASHIER_CENTER_JSON');
  const physicalConfig = parseRequiredConfig(env, 'PHYSICAL_CENTER_JSON');
  let catalogCenterConfig=null;
  if(env.LOTTERY_MANAGEMENT_CENTER_JSON)catalogCenterConfig=parseRequiredConfig(env,'LOTTERY_MANAGEMENT_CENTER_JSON');
  if (physicalConfig.stage !== 'active') throw configurationError();
  const adminIds = (env.LOTTERY_ADMIN_OPENIDS || '').split(',').map(value => value.trim()).filter(Boolean);
  const store = createCloudStore(cloud.database());
  const options = {store, campaign, prizes, adminIds, now,catalogCenterConfig,physicalConfig,
    randomTicket: () => crypto.randomInt(100), randomIndex: limit => crypto.randomInt(limit),
    makeCode: () => crypto.randomBytes(8).toString('hex').toUpperCase(),
    makeCouponCode: () => 'LJC1_' + crypto.randomBytes(16).toString('hex').toUpperCase(),
    entryId: openId => crypto.createHash('sha256').update(`${campaign.id}:${openId}`).digest('hex').slice(0, 32)};
  let service;
  try {
    const base = createCenterLottery({...options, createService, centerConfig});
    service = createPhysicalCenter({...options, base, physicalConfig});
  } catch { throw configurationError(); }
  const page = env.H5_MINIPROGRAM_ENTRY_PAGE;
  if (!/^[A-Za-z0-9_/-]+$/.test(page || '') || page.startsWith('/')) throw configurationError();
  const activityCode = createActivityCode({cloud, store, adminIds, campaign: {...campaign, entryPage: page}});
  return async (action, payload, openId) => {
    if (action !== 'activityCode') {
      const data = await service(action, payload, openId);
      return action === 'state' ? {...data, entry: publicReceipt(data.entry)} : publicReceipt(data);
    }
    const result = await activityCode(openId);
    const response = await cloud.getTempFileURL({fileList: [result.fileID]});
    const file = response.fileList && response.fileList[0];
    if (!file || (file.status !== undefined && file.status !== 0) || typeof file.tempFileURL !== 'string' || !file.tempFileURL.startsWith('https://')) throw Object.assign(new Error('活动码图像暂时无法打开，请稍后重试'), {code: 'CODE_NOT_READY'});
    return {url: file.tempFileURL, tempURL: file.tempFileURL, page: result.page, scene: result.scene, envVersion: result.envVersion, createdAt: result.createdAt};
  };
}
module.exports = {createLotteryAdapter};
