'use strict';
const {readConfig, createCodeExchange, createGateway, createCloudRateLimiter} = require('./gateway.cjs');
const {createCloudCodeGuard, healthResponse, createCloudTicketStore, createNativeTicketHandler, checkCloudStorage} = require('./auth-support.cjs');
let handler, nativeLogin;
exports.main = async event => {
  const health = await healthResponse(event, process.env, {readConfig, defaultBasePath: '/api/bubble-h5', service: 'bubble-h5-gateway', checkStorage: async () => { const cloud = require('wx-server-sdk'); cloud.init({env: cloud.DYNAMIC_CURRENT_ENV}); return checkCloudStorage(cloud.database(), 'lottery_h5_rates'); }});
  if (health) return health;
  try {
    if (!handler) {
      const config = readConfig(process.env);
      if (!config.enabled) return {statusCode: 503, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}, body: JSON.stringify({ok: false, code: 'SERVICE_NOT_CONFIGURED', message: '活动网页尚未接通正式服务'})};
      const cloud = require('wx-server-sdk');
      cloud.init({env: cloud.DYNAMIC_CURRENT_ENV});
      const {createLotteryAdapter} = require('./lottery-adapter.cjs');
      const consumeRate = createCloudRateLimiter(cloud.database());
      const tickets = config.loginMode === 'cloud-ticket' ? createCloudTicketStore(cloud.database(), {collection: 'lottery_h5_rates', appId: config.appId, origin: config.ticketOrigin, audience: 'bubble-h5-gateway'}) : null;
      nativeLogin = createNativeTicketHandler({config, getWXContext: () => cloud.getWXContext(), tickets, consumeRate});
      handler = createGateway({config, exchangeCode: createCodeExchange(config), callLottery: createLotteryAdapter({cloud}), consumeRate, consumeCode: createCloudCodeGuard(cloud.database(), {collection: 'lottery_h5_rates', appId: config.appId}), consumeTicket: tickets?.consume});
    }
    if (event?.action === 'issueH5SessionTicket') return await nativeLogin(event);
    return await handler(event);
  } catch {
    // Do not serialize credentials, environment values, provider URLs, or arbitrary exception messages.
    return {statusCode: 503, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}, body: JSON.stringify({ok: false, code: 'SERVICE_NOT_CONFIGURED', message: '活动网页尚未接通正式服务，请联系工作人员'})};
  }
};
