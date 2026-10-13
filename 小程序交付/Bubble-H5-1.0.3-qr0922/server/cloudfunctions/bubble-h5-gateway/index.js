'use strict';
const {readConfig, createCodeExchange, createGateway, createCloudRateLimiter} = require('./gateway.cjs');
let handler;
exports.main = async event => {
  try {
    if (!handler) {
      const config = readConfig(process.env);
      if (!config.enabled) return {statusCode: 503, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}, body: JSON.stringify({ok: false, code: 'SERVICE_NOT_CONFIGURED', message: '活动网页尚未接通正式服务'})};
      const cloud = require('wx-server-sdk');
      cloud.init({env: cloud.DYNAMIC_CURRENT_ENV});
      const {createLotteryAdapter} = require('./lottery-adapter.cjs');
      handler = createGateway({config, exchangeCode: createCodeExchange(config), callLottery: createLotteryAdapter({cloud}), consumeRate: createCloudRateLimiter(cloud.database())});
    }
    return await handler(event);
  } catch {
    // Do not serialize credentials, environment values, provider URLs, or arbitrary exception messages.
    return {statusCode: 503, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}, body: JSON.stringify({ok: false, code: 'SERVICE_NOT_CONFIGURED', message: '活动网页尚未接通正式服务，请联系工作人员'})};
  }
};
