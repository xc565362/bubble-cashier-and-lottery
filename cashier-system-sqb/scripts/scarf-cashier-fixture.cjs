// Shared isolated fixture for the preview and integration tests. Never opens live data.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCouponStore } = require('../coupons/store.cjs');
const { createPool, ensureSchema } = require('../online/mysql.cjs');
const { deleteNamespace } = require('../online/mysql.cjs');
const { endpoints } = require('../coupons/http.cjs');
const { createService: createPayments } = require('../payments/service.cjs');
const h5Root = path.resolve(__dirname, '../../miniprogram/Bubble-H5-小红书头巾-50');
const backend = path.join(h5Root, 'server/cloudfunctions/bubble-scarf-gateway');

function memoryStore() {
  let rows = new Map(), queue = Promise.resolve();
  return {
    seed(table, id, value) { rows.set(table + '/' + id, structuredClone(value)); },
    get(table, id) { return structuredClone(rows.get(table + '/' + id) || null); },
    async readEntries({campaignId,mode,limit,after,outcome,participantRef}) {
      await queue;
      const prefix=(mode==='scarf'?'bubble_scarf_entries':'entries')+'/';
      const all=[...rows].filter(([key])=>key.startsWith(prefix)).map(([key,row])=>({...structuredClone(row),_id:key.slice(prefix.length)}))
        .filter(row=>row.campaignId===campaignId&&(!participantRef||row._id===participantRef)&&(outcome==='all'||(mode==='scarf'?row.outcome:row.prize?'won':'lost')===outcome))
        .sort((a,b)=>a._id.localeCompare(b._id));
      return {total:all.length,rows:all.filter(row=>row._id>after).slice(0,limit+1)};
    },
    transaction(fn) {
      const pending = queue.then(async () => {
        const copy = structuredClone(rows);
        const value = await fn({
          get: async (table, id) => structuredClone(copy.get(table + '/' + id) || null),
          set: async (table, id, data) => copy.set(table + '/' + id, structuredClone(data)),
        });
        rows = copy; return value;
      });
      queue = pending.catch(() => {}); return pending;
    },
  };
}

async function createFixture({ randomBps = () => crypto.randomInt(10000), now = Date.now } = {}) {
  const { createService, CAMPAIGN_ID, COLLECTIONS } = require(path.join(backend, 'service.cjs'));
  const { createScarfCenter } = require(path.join(backend, 'center.cjs'));
  const { createManagementHttp, createManagementService } = require(path.join(backend, 'management.cjs'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-scarf-cashier-'));
  const pool = createPool();
  await ensureSchema(pool);
  const ns = 'fixture-' + crypto.randomBytes(6).toString('hex');
  const couponStore = await createCouponStore({ pool, ns, environment: 'production' });
  const admin = { id: 'administrator', role: 'admin' };
  const token = crypto.randomBytes(32).toString('hex'), key = crypto.randomBytes(32).toString('hex');
  const info = await couponStore.dispatch(admin, 'info');
  const store = memoryStore();
  store.seed(COLLECTIONS.campaigns, CAMPAIGN_ID, { enabled: false, startsAt: null, endsAt: null, redeemEndsAt: null });
  store.seed(COLLECTIONS.inventory, CAMPAIGN_ID, { total: 200, remaining: 200, awarded: 0, redeemed: 0 });
  const products = [
    { id: 'demo-scarf', sku: 'DEMO-SCARF', barcode: 'DEMO-SCARF', name: '黄橘拼色魔术头巾', price: 29, originalPrice: 39, stock: 200 },
    { id: 'demo-bottle', sku: 'DEMO-BOTTLE', barcode: 'DEMO-BOTTLE', name: '赛事运动水壶', price: 49, originalPrice: 59, stock: 200 },
  ].map(p => ({ ...p, productType: 'sale', group: '头巾联动演示商品' }));
  const baseUrl = 'https://scarf-coupons.invalid', managementUrl = 'https://scarf-management.invalid/api/scarf-management';
  let management;
  const mockFetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.origin === baseUrl) {
      try {
        const supplied = options.headers?.Authorization?.replace(/^Bearer /, '');
        const actor = supplied === token ? admin : await couponStore.authenticate(supplied);
        const action = Object.entries(endpoints).find(([, [method, route]]) => method === (options.method || 'GET') && route === parsed.pathname)?.[0];
        if (!action) throw new Error('Unexpected isolated coupon route');
        const input = options.body ? JSON.parse(options.body) : Object.fromEntries(parsed.searchParams);
        if (!options.body && input.page) input.page = Number(input.page);
        const data = await couponStore.dispatch(actor, action, input);
        return Response.json({ ok: true, data });
      } catch (error) { return Response.json({ ok: false, code: error.code, error: error.message }, { status: error.status || 400 }); }
    }
    if (parsed.href === managementUrl && management) {
      const result = await management({ httpMethod: 'POST', path: '/api/scarf-management', headers: options.headers, body: options.body });
      return new Response(result.body, { status: result.statusCode, headers: result.headers });
    }
    throw new Error('隔离联动演示已阻止外部网络请求');
  };
  const center = createScarfCenter({ config: { baseUrl, centerId: info.centerId, adminToken: token, environment: 'production' }, fetchFn: mockFetch, now });
  management = createManagementHttp({ store, center, key, now });
  const manage = createManagementService({ store, center, now });
  const call = createService({ store, center, adminOpenIds: ['oScarf_PreviewStaff0001'], now, randomBps });
  const payments = createPayments({ directory: path.join(directory, 'cashier'), fetchFn: mockFetch });
  const snapshot = await manage('snapshot', {});
  await manage('update', { operation: 'configure', revision: snapshot.revision, requestId: crypto.randomUUID(), reason: '初始化隔离演示，不操作真实活动', total: 200,
    campaign: { title: '山野有约', venue: '赛事现场 · Bubble 展位', startsAt: now() - 60000, endsAt: now() + 7 * 86400000, redeemEndsAt: now() + 8 * 86400000, winProbabilityBps: 5000 },
    prize: { id: 'scarf-demo-v1', name: '魔术头巾', imageUrl: '', product: { id: products[0].id, name: products[0].name, sku: products[0].sku, barcode: products[0].barcode } },
  });
  const configured = await manage('snapshot', {});
  await manage('update', { operation: 'resume', revision: configured.revision, requestId: crypto.randomUUID(), reason: '启动本机隔离演示' });
  await payments.dispatch('coupon-connect', { baseUrl, adminToken: token });
  await payments.dispatch('scarf-connect', { url: managementUrl, campaignId: CAMPAIGN_ID, key });
  return { directory, store, couponStore, admin, call, manage, payments, products, h5Root, backend, now, pool, ns,
    async close() { payments.close(); couponStore.close(); await deleteNamespace(pool, ns); await pool.end(); },
  };
}
module.exports = { createFixture, memoryStore, h5Root, backend };
