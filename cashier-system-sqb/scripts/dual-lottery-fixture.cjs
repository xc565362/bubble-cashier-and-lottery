'use strict';
// Two real application services, one temporary coupon center and one cashier bridge.
// All transport is injected. Nothing in this fixture reads production config or contacts the network.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { memoryStore } = require('./scarf-cashier-fixture.cjs');
const { createCouponStore } = require('../coupons/store.cjs');
const { createPool, ensureSchema } = require('../online/mysql.cjs');
const { deleteNamespace } = require('../online/mysql.cjs');
const { endpoints } = require('../coupons/http.cjs');
const { createService: createPayments } = require('../payments/service.cjs');
const { createService: createOriginalService } = require('../lottery-backend/service.js');
const { createCenterLottery } = require('../lottery-backend/center-lottery.cjs');
const { createPhysicalCenter } = require('../lottery-backend/physical-center.cjs');
const { createManagementHttp: createOriginalManagement } = require('../lottery-backend/management-http.cjs');
const baseline = require('../lottery-backend/config.js');
const originalH5Root = path.resolve(__dirname, '../../miniprogram/Bubble-H5-1.0.3-qr0922');
const scarfH5Root = path.resolve(__dirname, '../../miniprogram/Bubble-H5-小红书头巾-50');
const scarfBackend = path.join(scarfH5Root, 'server/cloudfunctions/bubble-scarf-gateway');
const STAFF = 'oDual_PreviewStaff0001';
const VISITOR = 'oDual_PreviewVisitor0001';

async function createFixture({ randomIndex = limit => crypto.randomInt(limit), randomBps = () => crypto.randomInt(10000), now = Date.now } = {}) {
  const { createService: createScarfService, CAMPAIGN_ID, COLLECTIONS } = require(path.join(scarfBackend, 'service.cjs'));
  const { createScarfCenter } = require(path.join(scarfBackend, 'center.cjs'));
  const { createManagementHttp: createScarfManagement, createManagementService } = require(path.join(scarfBackend, 'management.cjs'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-dual-lottery-'));
  const pool = createPool();
  await ensureSchema(pool);
  const ns = 'fixture-' + crypto.randomBytes(6).toString('hex');
  const couponStore = await createCouponStore({ pool, ns, environment: 'production', now });
  const admin = { id: 'administrator', role: 'admin' };
  const adminToken = crypto.randomBytes(32).toString('hex');
  const originalKey = crypto.randomBytes(32).toString('hex'), scarfKey = crypto.randomBytes(32).toString('hex');
  const centerId = (await couponStore.dispatch(admin, 'info')).centerId;
  const baseUrl = 'https://dual-coupons.invalid';
  const originalManagementUrl = 'https://dual-original-management.invalid/lottery';
  const scarfManagementUrl = 'https://dual-scarf-management.invalid/api/scarf-management';
  let originalManagement, scarfManagement, payments, closed = false;
  const counters = { couponRequests: 0, originalManagementRequests: 0, scarfManagementRequests: 0, blockedExternalRequests: 0 };
  const mockFetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.origin === baseUrl) {
      counters.couponRequests++;
      try {
        const headers = new Headers(options.headers || {});
        const supplied = headers.get('authorization')?.replace(/^Bearer /, '');
        const actor = supplied === adminToken ? admin : await couponStore.authenticate(supplied);
        const action = Object.entries(endpoints).find(([, [method, route]]) => method === (options.method || 'GET') && route === parsed.pathname)?.[0];
        if (!action) throw new Error('Unexpected isolated coupon route');
        const input = options.body ? JSON.parse(options.body) : Object.fromEntries(parsed.searchParams);
        if (!options.body && input.page) input.page = Number(input.page);
        return Response.json({ ok: true, data: await couponStore.dispatch(actor, action, input) });
      } catch (error) { return Response.json({ ok: false, code: error.code, error: error.message }, { status: error.status || 400 }); }
    }
    const handler = parsed.href === originalManagementUrl ? originalManagement : parsed.href === scarfManagementUrl ? scarfManagement : null;
    if (handler) {
      counters[parsed.href === originalManagementUrl ? 'originalManagementRequests' : 'scarfManagementRequests']++;
      const result = await handler({ httpMethod: options.method || 'POST', path: parsed.pathname, headers: options.headers || {}, body: options.body });
      return new Response(result.body, { status: result.statusCode, headers: result.headers });
    }
    counters.blockedExternalRequests++;
    throw new Error('双活动隔离演示已阻止外部网络请求');
  };
  const products = [
    ['cap', 'BB250005', '户外棒球帽', 39], ['bucket', 'BB250003', '户外渔夫帽', 39],
    ['waist', 'BB240011', '运动腰包', 59], ['tote', 'BB260057', '超大编织袋', 29],
    ['scarf', 'DEMO-SCARF', '黄橘拼色魔术头巾', 29], ['bottle', 'DEMO-BOTTLE', '赛事运动水壶', 49],
  ].map(([id, sku, name, price]) => ({ id: 'dual-demo-' + id, sku, barcode: sku, name, group: '双活动联动演示商品', productType: 'sale', price, originalPrice: price, stock: 200 }));
  try {
    const originalStore = memoryStore(), scarfStore = memoryStore();
    // Expired production dates are overridden only in this cloned fixture object.
    const campaign = { ...structuredClone(baseline.campaign), title: '此刻在地', enabled: false,
      startsAt: now() - 60000, endsAt: now() + 7 * 86400000, redeemEndsAt: now() + 8 * 86400000, redemptionEndsAt: undefined };
    const prizes = structuredClone(baseline.prizes);
    const centerConfig = { baseUrl, centerId, environment: 'production', prizes: {} };
    const physicalConfig = { baseUrl, centerId, environment: 'production', stage: 'active', handoffReadyAt: now() - 1000, prizes: {} };
    const catalogCenterConfig = { baseUrl, centerId, environment: 'production', adminToken, prizes: {} };
    for (const p of prizes) {
      const couponCampaign = await couponStore.dispatch(admin, 'create-campaign', { requestId: 'dual-original-campaign-' + p.id, name: '此刻在地 · ' + p.name, kind: p.kind,
        amountCents: Math.round((p.amount || 0) * 100), minimumCents: 0, quota: campaign.inventory.quantities[p.id],
        startsAt: new Date(campaign.startsAt).toISOString(), expiresAt: new Date(campaign.redeemEndsAt).toISOString(),
        ...(p.kind === 'physical' ? { physical: { prizeId: p.id, quantity: 1 } } : {}) });
      const credential = await couponStore.dispatch(admin, 'create-key', { requestId: 'dual-original-key-' + p.id, name: 'Isolated ' + p.id, role: 'lottery', campaignId: couponCampaign.id });
      (p.kind === 'physical' ? physicalConfig : centerConfig).prizes[p.id] = { campaignId: couponCampaign.id, token: credential.token, minimumCents: 0 };
      catalogCenterConfig.prizes[p.id] = couponCampaign.id;
    }
    const originalOptions = { store: originalStore, campaign, prizes, now, adminIds: [STAFF], catalogCenterConfig, physicalConfig,
      randomIndex, randomTicket: () => crypto.randomInt(100), makeCode: () => crypto.randomBytes(8).toString('hex').toUpperCase(),
      makeCouponCode: () => 'LJC1_' + crypto.randomBytes(16).toString('hex').toUpperCase(),
      entryId: id => crypto.createHash('sha256').update(campaign.id + ':' + id).digest('hex').slice(0, 32), fetchFn: mockFetch };
    const base = createCenterLottery({ ...originalOptions, createService: createOriginalService, centerConfig });
    const originalCall = createPhysicalCenter({ ...originalOptions, base });
    await originalCall('initializePool', {}, STAFF); campaign.enabled = true;
    originalManagement = createOriginalManagement({ store: originalStore, campaign, prizes, key: originalKey, centerConfig: catalogCenterConfig, fetchFn: mockFetch, now });

    scarfStore.seed(COLLECTIONS.campaigns, CAMPAIGN_ID, { enabled: false, startsAt: null, endsAt: null, redeemEndsAt: null });
    scarfStore.seed(COLLECTIONS.inventory, CAMPAIGN_ID, { total: 200, remaining: 200, awarded: 0, redeemed: 0 });
    const scarfCenter = createScarfCenter({ config: { baseUrl, centerId, adminToken, environment: 'production' }, fetchFn: mockFetch, now });
    scarfManagement = createScarfManagement({ store: scarfStore, center: scarfCenter, key: scarfKey, now });
    const scarfManage = createManagementService({ store: scarfStore, center: scarfCenter, now });
    const scarfCall = createScarfService({ store: scarfStore, center: scarfCenter, adminOpenIds: [STAFF], now, randomBps });
    const first = await scarfManage('snapshot', {}), scarfProduct = products.find(p => p.sku === 'DEMO-SCARF');
    await scarfManage('update', { operation: 'configure', revision: first.revision, requestId: crypto.randomUUID(), reason: '初始化双活动隔离演示，不操作正式数据', total: 200,
      campaign: { title: '山野有约', venue: '赛事现场 · Bubble 展位', startsAt: now() - 60000, endsAt: now() + 7 * 86400000, redeemEndsAt: now() + 8 * 86400000, winProbabilityBps: 5000 },
      prize: { id: 'dual-scarf-initial', name: '魔术头巾', imageUrl: '', product: { id: scarfProduct.id, name: scarfProduct.name, sku: scarfProduct.sku, barcode: scarfProduct.barcode } } });
    const configured = await scarfManage('snapshot', {});
    await scarfManage('update', { operation: 'resume', revision: configured.revision, requestId: crypto.randomUUID(), reason: '启动本机双活动演示' });

    payments = createPayments({ directory: path.join(directory, 'cashier'), fetchFn: mockFetch });
    await payments.dispatch('coupon-connect', { baseUrl, adminToken });
    await payments.dispatch('lottery-connect', { url: originalManagementUrl, campaignId: campaign.id, key: originalKey });
    await payments.dispatch('scarf-connect', { url: scarfManagementUrl, campaignId: CAMPAIGN_ID, key: scarfKey });
    await payments.dispatch('coupon-bind-physical-products', { products });

    function createGateways(origin = 'http://127.0.0.1:5211') {
      const parsedOrigin = new URL(origin);
      if (parsedOrigin.protocol !== 'http:' || parsedOrigin.hostname !== '127.0.0.1' || parsedOrigin.origin !== origin) throw new Error('演示网关只允许127.0.0.1本机来源');
      const { createGateway: originalGateway } = require(path.join(originalH5Root, 'server/cloudfunctions/bubble-h5-gateway/gateway.cjs'));
      const { createGateway: scarfGateway } = require(path.join(scarfBackend, 'gateway.cjs'));
      const codes = { original: new Map(), scarf: new Map() }, usedCodes={original:new Set(),scarf:new Set()};
      const make = (kind, factory, callLottery) => factory({ config: { enabled: true, appId: 'wx0000000000000001', tokenSecret: crypto.randomBytes(32).toString('hex'), sessionTtlMs: 30 * 60000, origins: [origin], basePath: '/' + kind + '-api' }, now,
        exchangeCode: async code => { const row = codes[kind].get(code); codes[kind].delete(code); if (!row || row.expiresAt <= now()) throw new Error('演示登录已失效，请从顶部入口重新进入'); return row.identity; },
        consumeCode:async code=>{if(usedCodes[kind].has(code))throw Object.assign(new Error('隔离登录码已使用'),{code:'UNAUTHENTICATED',status:401,gatewayFault:true});usedCodes[kind].add(code);},
        consumeRate: async () => {}, callLottery });
      const original = make('original', originalGateway, async (action, payload, identity) => {
        const data = await originalCall(action, payload, identity);
        const receipt = value => value?.prize?.kind === 'physical' ? { ...value, requiresPos: true } : value;
        return action === 'state' ? { ...data, entry: receipt(data.entry) } : receipt(data);
      });
      const scarf = make('scarf', scarfGateway, scarfCall);
      return { original, scarf, async enter(kind, { fresh = false } = {}) {
        if (!['original', 'scarf'].includes(kind)) throw new Error('未知活动');
        const identity = fresh ? 'oDual_Visitor_' + crypto.randomUUID() : VISITOR;
        let invitation;
        if (kind === 'scarf') { const state = await scarfCall('state', {}, identity); if (!state.entry && state.availability.canDraw) invitation = await scarfCall('grant', {}, STAFF); }
        // Local stand-in for the native wx.login and staff attention check, never a production identity.
        const code = 'preview_' + crypto.randomBytes(16).toString('hex');
        if (codes[kind].size > 100) codes[kind].clear();
        codes[kind].set(code, { identity, expiresAt: now() + 60000 });
        return '/' + kind + '/#/home?wx_code=' + code + (invitation ? '&inviteCode=' + invitation.inviteCode : '');
      } };
    }
    return { directory, couponStore, admin, payments, products, centerId, mockFetch, counters, now, createGateways, pool, ns,
      original: { call: originalCall, store: originalStore, campaign, prizes, h5Root: originalH5Root },
      scarf: { call: scarfCall, manage: scarfManage, store: scarfStore, campaignId: CAMPAIGN_ID, h5Root: scarfH5Root },
      async close() { if (closed) return; closed = true; payments.close(); couponStore.close(); await deleteNamespace(pool, ns); await pool.end(); } };
  } catch (error) { payments?.close(); couponStore.close(); await pool.end().catch(() => {}); throw error; }
}
module.exports = { createFixture, STAFF, VISITOR, originalH5Root, scarfH5Root };
