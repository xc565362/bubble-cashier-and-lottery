const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { endpoints } = require('./http.cjs');
const { createCouponStore, digest } = require('./store.cjs');
const { createPool } = require('../online/mysql.cjs');
const { selectors, resolvePhysicalProduct, resolveCatalogProduct, validatePhysicalLine } = require('./physical-products.cjs');

function createCouponBridge({ directory, protect = value => value, unprotect = value => value, fetchFn = fetch, getPayment = () => null, storeNs = '' }) {
  const configFile = path.join(directory, 'coupon-connection.json');
  const stateFile = path.join(directory, 'coupon-transactions.json');
  const bindingFile = path.join(directory, 'physical-product-bindings.json');
  const read = (file, fallback) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
  function write(file, value) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  }
  let config = read(configFile, { mode: 'local', deviceId: crypto.randomUUID() });
  let journal = read(stateFile, {});
  let bindings = read(bindingFile, {version:1,prizes:{}});
  let localPromise;
  let busy = false;
  // Local development coupon center now lives in the same MySQL (pos_coupon_*
  // tables, default namespace) instead of a per-machine SQLite file.
  const store = () => localPromise ||= (async () => {
    const pool = createPool();
    return { store: await createCouponStore({ pool, ns: storeNs }), pool };
  })();
  function saveJournal() { write(stateFile, journal); }
  function pendingSnapshot() {
    return structuredClone(Object.values(journal).filter(row => !row.finished).map(row => ({ ...row,
      canRelease: !row.zeroDraft && (!row.orderId || !getPayment(row.orderId) || ['failed', 'not-started'].includes(getPayment(row.orderId).state)) })));
  }
  async function request(action, input = {}, cashier = false, target = config) {
    if (target.mode === 'local') return (await store()).store.dispatch({ id: cashier ? config.deviceId : 'administrator', role: cashier ? 'cashier' : 'admin' }, action, input);
    const [method, route] = endpoints[action] || [];
    if (!method) throw new Error('不支持的券服务操作');
    const url = new URL(route, target.baseUrl);
    if (method === 'GET') for (const [key, value] of Object.entries(input)) if (value !== undefined && value !== '') url.searchParams.set(key, value);
    const response = await fetchFn(url, { method, redirect: 'error', signal: AbortSignal.timeout(12000), headers: {
      Authorization: `Bearer ${unprotect(cashier ? target.cashierToken : target.adminToken)}`, 'Content-Type': 'application/json',
    }, ...(method === 'POST' ? { body: JSON.stringify(input) } : {}) });
    let result;
    try { result = await response.json(); } catch { throw new Error('券服务响应不是 JSON，请核对接口地址'); }
    if (!response.ok || !result.ok) throw Object.assign(new Error(result.error || '券服务不可用'), { code: result.code });
    return result.data;
  }
  async function info() {
    const center = await request('info');
    return { mode: config.mode, baseUrl: config.baseUrl || '', centerId: center.centerId, environment: center.environment, deviceId: config.deviceId, connected: true,
      integrationReady: config.mode === 'remote' && center.environment === 'production',
      physicalSupported: center.capabilities?.includes('physical-prize-v1') === true,
      lotteryCatalogSupported: center.capabilities?.includes('lottery-catalog-v1') === true,
      openReservations: Object.values(journal).filter(row => !row.finished).length };
  }
  async function exclusive(fn) {
    if (busy) throw new Error('正在处理券操作，请稍后重试');
    busy = true; try { return await fn(); } finally { busy = false; }
  }
  async function settle(record) {
    const line = record?.draft?.items?.find(item => item.externalCoupon);
    if (!line) return null;
    const id = line.externalCoupon.reservationId;
    const row = journal[id];
    if (!row || row.finished) return row || null;
    try {
      if (record.state === 'paid') {
        const coupon = await request('commit', { id, orderId: record.id, paidCents: record.amount, paymentReference: record.orderSn,
          requestId: `commit:${record.id}` }, true);
        journal[id] = { ...row, finished: true, coupon, error: '' };
      } else if (['failed', 'not-started'].includes(record.state)) {
        const coupon = await request('release', { id, orderId: record.id, outcome: record.state, requestId: `failed:${record.id}` }, true);
        journal[id] = { ...row, finished: true, coupon, error: '' };
      } else return row;
    } catch { journal[id] = { ...row, error: '券状态同步未完成，请保持联网并重试核对' }; }
    saveJournal(); return journal[id];
  }
  async function prepareDraft(draft, paymentMode) {
    const awards = draft.items.filter(item => item.externalCoupon);
    if (awards.length > 1) throw new Error('每单只能使用一份抽奖奖品');
    const line = awards[0];
    if (!line) return;
    const row = journal[line.externalCoupon.reservationId];
    if (!row || row.finished || row.coupon.id !== line.externalCoupon.couponId) throw new Error('券占用记录失效，请移除并重新扫码');
    if (row.centerId !== line.externalCoupon.centerId || (row.coupon.kind === 'physical') !== (line.externalCoupon.kind === 'physical')) throw new Error('券信息已被修改，请重新扫码');
    if (row.coupon.kind === 'physical') {
      validatePhysicalLine(line,row.binding);
      if (row.coupon.physical.prizeId !== line.externalCoupon.prizeId || draft.items.some(item => item.productType === 'coupon')) throw new Error('实物奖品信息被修改或与其他券叠加');
      const {priceOrder} = await import('../src/orderLogic.js');
      const priced = priceOrder(draft.items);
      if (priced.total !== draft.total || priced.couponDiscount !== draft.couponDiscount) throw new Error('订单金额不一致，请重新结算');
    } else if (Math.round(line.couponAmount * 100) !== row.coupon.amountCents || line.minimumCents !== row.coupon.minimumCents) throw new Error('券信息已被修改，请重新扫码');
    if (row.coupon.environment !== 'production' && paymentMode === 'production') throw new Error('联调券不能用于正式商户收款');
    if (row.coupon.environment === 'production' && !['production', 'zero'].includes(paymentMode)) throw new Error('正式抵扣券不能用于测试支付，请先配置正式收款');
    const eligibleCents = Math.round((draft.total + draft.couponDiscount) * 100);
    const input = { id: row.id, orderId: draft.id, orderNo: draft.orderNo, eligibleCents, paidCents: Math.round(draft.total * 100), requestId: `prepare:${draft.id}` };
    if (row.orderId && row.orderId !== draft.id) throw new Error('此券已绑定其他订单，请先核对');
    // Persist intent before the remote call so a lost response cannot lose the lock.
    journal[row.id] = { ...row, orderId: draft.id, prepare: input }; saveJournal();
    const coupon = await request('prepare', input, true);
    journal[row.id] = { ...journal[row.id], coupon }; saveJournal();
  }
  async function zero(draft) {
    const { priceOrder } = await import('../src/orderLogic.js');
    for (const item of draft?.items || []) if (item.externalCoupon?.kind === 'physical') validatePhysicalLine(item,journal[item.externalCoupon.reservationId]?.binding);
    const priced = priceOrder(draft?.items || []);
    const line = priced.items.find(item => item.externalCoupon);
    if (!line || priced.total !== 0 || (priced.couponDiscount <= 0 && line.externalCoupon.kind !== 'physical') || draft.total !== 0 || draft.method !== '零元结算' || !/^[a-zA-Z0-9-]{1,64}$/.test(draft.id)) throw new Error('不是有效的中奖券零元结算订单');
    const row = journal[line.externalCoupon.reservationId];
    if (!row || row.finished) throw new Error('券占用记录已结束，请核对订单');
    const snapshot = { ...draft, ...priced, items: priced.items.map(({ imageUrl, ...item }) => item) };
    if (row.zeroDraft && digest(row.zeroDraft) !== digest(snapshot)) throw new Error('零元结算内容与原订单不一致');
    await prepareDraft(snapshot, 'zero');
    journal[row.id] = { ...journal[row.id], zeroDraft: snapshot }; saveJournal();
    const coupon = await request('commit', { id: row.id, orderId: draft.id, paidCents: 0, paymentReference: `ZERO:${draft.id}`, requestId: `commit:${draft.id}` }, true);
    journal[row.id] = { ...journal[row.id], coupon, error: '' }; saveJournal();
    return { draft: snapshot, coupon };
  }
  return {
    async dispatch(action, payload = {}) {
      if (action === 'config') return info();
      if (action === 'physical-bindings') return structuredClone(bindings);
      // Read-only recovery evidence. Unlike sync, this never settles a payment,
      // queries the center, or rewrites the journal.
      if (action === 'pending') return pendingSnapshot().map(row => ({ id: row.id, orderId: row.orderId || null,
        error: row.error || '', canRelease: row.canRelease, coupon: { name: row.coupon?.name || '抽奖奖品', state: row.coupon?.state || 'UNKNOWN' } }));
      if (action === 'bind-physical-products') return exclusive(async () => {
        if (Object.values(journal).some(row => !row.finished)) throw new Error('还有占用或待同步的券，请先处理后修改商品绑定');
        const prizes = Object.fromEntries(Object.keys(selectors).map(prizeId => [prizeId,{prizeId,product:resolvePhysicalProduct(prizeId,payload.products)}]));
        const next = {version:1,prizes,updatedAt:new Date().toISOString()};
        write(bindingFile,next); bindings = next; return structuredClone(bindings);
      });
      if (action === 'fulfilment') {
        const row = Object.values(journal).find(item => item.orderId === payload.orderId);
        return row ? {redeemed:row.coupon?.state === 'REDEEMED',error:row.error || '',prizeId:row.coupon?.physical?.prizeId} : {redeemed:false,error:'尚无对应核销记录'};
      }
      if (action === 'connect') return exclusive(async () => {
        if (Object.values(journal).some(row => !row.finished)) throw new Error('还有占用或待同步的券，请先处理后切换服务');
        if (payload.mode === 'local') { config = { mode: 'local', deviceId: config.deviceId }; write(configFile, config); return info(); }
        const url = new URL(payload.baseUrl);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('请输入券服务 HTTPS 域名，不含路径、账号或参数');
        if (!/^[A-Za-z0-9_.-]{32,300}$/.test(payload.adminToken || '')) throw new Error('请输入有效的券服务管理密钥');
        const target = { mode: 'remote', baseUrl: url.origin, adminToken: protect(payload.adminToken), deviceId: config.deviceId };
        const center = await request('info', {}, false, target);
        if (center.service !== 'stall-coupon-center' || center.version !== 1 || center.role !== 'admin') throw new Error('接口不是兼容的券管理服务，或密钥权限不正确');
        const key = await request('create-key', { role: 'cashier', name: `收银终端 ${config.deviceId.slice(0, 8)}`, requestId: `terminal:${config.deviceId}:${center.centerId}` }, false, target);
        target.cashierToken = protect(key.token);
        const check = await request('info', {}, true, target);
        if (check.role !== 'cashier') throw new Error('收银凭证无效');
        config = target; write(configFile, config); return info();
      });
      if (action === 'sync') return exclusive(async () => {
        for (const row of Object.values(journal).filter(item => !item.finished)) {
          if (row.zeroDraft) continue;
          const payment = row.orderId ? getPayment(row.orderId) : null;
          if (payment) await settle(payment);
          else {
            try {
              const coupon = await request('reservation', { id: row.id }, true);
              journal[row.id] = { ...journal[row.id], coupon };
            } catch (error) {
              if (error.code === 'RESERVATION_NOT_FOUND') journal[row.id] = { ...row, finished: true, error: '' };
              else journal[row.id] = { ...row, error: '券状态查询失败，请稍后重试' };
            }
          }
        }
        saveJournal(); return pendingSnapshot();
      });
      if (action === 'reserve') return exclusive(async () => {
        const center = await request('info');
        // The local product catalog is only for matching a trusted coupon. Never send
        // it to the coupon server or use caller-supplied physical data as entitlement.
        const {products, ...reserveInput} = payload;
        const coupon = await request('reserve', reserveInput, true);
        const id = coupon.reservation.id;
        const prior=journal[id];
        if(prior&&(prior.finished||prior.orderId||prior.zeroDraft))throw new Error('此券已进入或结束结算，请核对原订单');
        journal[id] = { ...prior, id, coupon, centerId: center.centerId, finished: false };
        write(configFile, config); saveJournal();
        if (coupon.kind === 'physical') {
          let binding, bindingError;
          try {
            binding = coupon.physical?.product
              ? {prizeId: coupon.physical.prizeId, product: resolveCatalogProduct(coupon.physical.product, products)}
              : bindings.prizes[coupon.physical?.prizeId];
            if (!binding) throw new Error('请先在券管理中绑定实物奖品对应商品');
          } catch (error) {bindingError = error;}
          if (bindingError) {
            try {
              const released = await request('release',{id,requestId:`unbound:${id}`},true);
              journal[id] = {...journal[id],coupon:released,finished:true};
            } catch { journal[id].error = '实物商品未绑定，释放未完成，请在券管理中核对'; }
            saveJournal(); throw bindingError;
          }
          journal[id] = {...journal[id],binding:structuredClone(binding)}; saveJournal();
          const {externalCoupon:ignored, imageUrl, ...product} = binding.product;
          return {...product,productType:'gift',price:0,qty:1,discount:0,lineKey:`lottery-gift:${coupon.id}`,
            externalCoupon:{kind:'physical',prizeId:coupon.physical.prizeId,couponId:coupon.id,reservationId:id,centerId:center.centerId,environment:coupon.environment}};
        }
        return { id: `external-${coupon.id}`, name: coupon.name, barcode: coupon.id, sku: '', group: '抽奖券', productType: 'coupon', price: 0,
          couponAmount: coupon.amountCents / 100, minimumCents: coupon.minimumCents, stock: 0, qty: 1, discount: 0,
          externalCoupon: { couponId: coupon.id, reservationId: id, centerId: center.centerId, environment: coupon.environment } };
      });
      if (action === 'release') return exclusive(async () => {
        const row = journal[payload.id];
        if (!row || row.finished) return { ok: true };
        if (row.zeroDraft) throw new Error('此券正在零元结算，不能释放，请完成订单恢复');
        const payment = row.orderId ? getPayment(row.orderId) : null;
        if (payment) {
          if (!['failed', 'not-started'].includes(payment.state)) throw new Error('此券已进入支付流程，请先核对交易');
          await settle(payment);
          if (!journal[payload.id].finished) throw new Error('释放券未成功，请保持联网后重试');
        } else {
          const current = await request('reservation', { id: row.id }, true).catch(error => {
            if (error.code === 'RESERVATION_NOT_FOUND') return null; throw error;
          });
          if (current) await request('release', { id: row.id, ...(row.orderId ? { orderId: row.orderId, outcome: 'not-started' } : {}), requestId: `release:${row.id}` }, true);
          journal[row.id] = { ...row, finished: true }; saveJournal();
        }
        return { ok: true };
      });
      if (action === 'zero') return exclusive(() => zero(payload.draft));
      if (action === 'zero-ack') return exclusive(async () => {
        const row = Object.values(journal).find(item => item.zeroDraft?.id === payload.id);
        if (!row || row.coupon.state !== 'REDEEMED') throw new Error('零元订单尚未核销完成');
        journal[row.id] = { ...row, finished: true }; saveJournal(); return { ok: true };
      });
      const allowed = new Set(['campaigns', 'create-campaign', 'set-campaign', 'coupons', 'coupon', 'issue', 'keys', 'create-key', 'revoke-key', 'void', 'events']);
      if (!allowed.has(action)) throw new Error('不支持的券管理操作');
      return request(action, payload);
    },
    prepareDraft: (draft, paymentMode) => exclusive(() => prepareDraft(draft, paymentMode)),
    validatePhysicalItems: items => {for (const line of items || []) if (line.externalCoupon?.kind === 'physical') validatePhysicalLine(line,journal[line.externalCoupon.reservationId]?.binding);},
    settle,
    // Internal recovery evidence; never a browser dispatch action.
    readOnlineState: () => structuredClone(Object.values(journal)),
    close: () => localPromise?.then(({ pool }) => pool.end()),
    hasPending: () => Object.values(journal).some(row => !row.finished),
    hasZeroPending: () => Object.values(journal).some(row => !row.finished && row.zeroDraft),
  };
}
module.exports = { createCouponBridge };
