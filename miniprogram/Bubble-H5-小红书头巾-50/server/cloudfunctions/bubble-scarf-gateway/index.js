'use strict';
const {readConfig, createCodeExchange, createGateway, createCloudRateLimiter} = require('./gateway.cjs');
const {createCloudCodeGuard, healthResponse, createCloudTicketStore, createNativeTicketHandler, checkCloudStorage} = require('./auth-support.cjs');
let handler,management,shared,nativeLogin;
exports.main = async event => {
  const health = await healthResponse(event, process.env, {readConfig, defaultBasePath: '/api/scarf-h5', service: 'bubble-scarf-gateway', extraChecks: {cloudEnvironment: /^[A-Za-z0-9_-]{6,128}$/.test(process.env.SCARF_CLOUD_ENV || ''), staffConfigured: (process.env.SCARF_ADMIN_OPENIDS || '').split(',').some(id => /^[A-Za-z0-9_-]{10,128}$/.test(id.trim()))}, checkStorage: async () => { const cloud = require('wx-server-sdk'); cloud.init({env: process.env.SCARF_CLOUD_ENV}); return checkCloudStorage(cloud.database(), 'bubble_scarf_rates'); }});
  if (health) return health;
  try {
    if (!shared) {
      const envId = process.env.SCARF_CLOUD_ENV;
      if (!/^[A-Za-z0-9_-]{6,128}$/.test(envId || '')) throw new Error('Not configured');
      const cloud = require('wx-server-sdk');
      cloud.init({env: envId});
      const store=require('./service.cjs').createCloudStore(cloud.database());
      let center;
      if(process.env.SCARF_COUPON_URL)center=require('./center.cjs').createScarfCenter({config:{baseUrl:process.env.SCARF_COUPON_URL,centerId:process.env.SCARF_COUPON_CENTER_ID,adminToken:process.env.SCARF_COUPON_ADMIN_TOKEN,environment:'production'}});
      shared={cloud,store,center};
    }
    if(event?.path==='/api/scarf-management'){
      if(process.env.SCARF_MANAGEMENT_ENABLED!=='1')throw new Error('Not configured');
      if(!management)management=require('./management.cjs').createManagementHttp({store:shared.store,center:shared.center,key:process.env.SCARF_MANAGEMENT_KEY});
      return await management(event);
    }
    if (!handler) {
      const config = readConfig(process.env);
      if (!config.enabled) throw new Error('Not configured');
      const admins = (process.env.SCARF_ADMIN_OPENIDS || '').split(',').map(id => id.trim()).filter(Boolean);
      if (!admins.length) throw new Error('Not configured');
      const {cloud,store,center}=shared;
      const {createScarfAdapter} = require('./adapter.cjs');
      const service=require('./service.cjs').createService({store,adminOpenIds:admins,center});
      const consumeRate = createCloudRateLimiter(cloud.database());
      const tickets = config.loginMode === 'cloud-ticket' ? createCloudTicketStore(cloud.database(), {collection: 'bubble_scarf_rates', appId: config.appId, origin: config.ticketOrigin, audience: 'bubble-scarf-gateway'}) : null;
      nativeLogin = createNativeTicketHandler({config, getWXContext: () => cloud.getWXContext(), tickets, consumeRate});
      handler = createGateway({config, exchangeCode: createCodeExchange(config), callLottery: createScarfAdapter({cloud,service}), consumeRate, consumeCode: createCloudCodeGuard(cloud.database(), {collection: 'bubble_scarf_rates', appId: config.appId}), consumeTicket: tickets?.consume});
    }
    if (event?.action === 'issueH5SessionTicket') return await nativeLogin(event);
    return await handler(event);
  } catch {
    // Deliberately omit environment values, provider messages, OpenIDs and incoming tokens from logs/responses.
    return {statusCode: 503, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}, body: JSON.stringify({ok: false, code: 'SERVICE_NOT_CONFIGURED', message: '活动网页尚未接通正式服务，请联系工作人员'})};
  }
};
