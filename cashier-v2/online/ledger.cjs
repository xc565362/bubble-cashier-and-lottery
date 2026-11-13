'use strict';
const crypto = require('node:crypto');
const { withTransaction } = require('./mysql.cjs');
const { ROLES, effectiveGrants, COMMAND_SECTION } = require('./sections.cjs');

const problem = (code, message, status = 409, data = undefined) => Object.assign(new Error(message), { code, status, statusCode: status, ...(data ? { data } : {}) });
const fail = (code, message, status, data) => { throw problem(code, message, status, data); };
const clone = value => structuredClone(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const stable = value => Array.isArray(value) ? value.map(stable) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const withoutImages = value => Array.isArray(value) ? value.map(withoutImages) : object(value)
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'imageUrl').map(([key, entry]) => [key, withoutImages(entry)])) : value;
const samePlan = (a, b) => fingerprint(withoutImages(a)) === fingerprint(withoutImages(b));
const id = (value, label = '编号') => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail('INVALID_INPUT', `${label}不正确`, 400);
  return value;
};
const text = (value, label, max = 200, empty = true) => {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f-\u009f]/.test(value) || (!empty && !value.trim())) fail('INVALID_INPUT', `${label}不正确`, 400);
  return value.trim();
};
const integer = (value, label, max = 100000000) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail('INVALID_INPUT', `${label}须为有效非负整数`, 400);
  return value;
};
const money = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000000 || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) fail('INVALID_INPUT', `${label}须为有效金额，最多两位小数`, 400);
  return value;
};
const businessTime = value => Date.parse(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value) ? `${value}+08:00` : value);
function image(value, label = '商品图片', allowData = false) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') fail('INVALID_INPUT', `${label}不正确`, 400);
  if (allowData && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length <= 2 * 1024 * 1024) return value;
  if (value.length > 2048) fail('INVALID_INPUT', `${label}地址过长`, 400);
  let url; try { url = new URL(value); } catch { fail('INVALID_INPUT', `${label}请使用HTTPS地址`, 400); }
  if (url.protocol !== 'https:' || url.username || url.password || /[\s\\]/.test(value)) fail('INVALID_INPUT', `${label}请使用HTTPS地址`, 400);
  return url.href;
}
function product(value) {
  if (!object(value)) fail('INVALID_INPUT', '商品资料不正确', 400);
  const productType = value.productType || 'sale';
  if (!['sale', 'gift', 'coupon'].includes(productType)) fail('INVALID_INPUT', '商品类型不正确', 400);
  const result = { id: id(value.id, '商品编号'), name: text(value.name, '商品名', 200, false), barcode: text(value.barcode || '', '条码', 128),
    sku: text(value.sku || '', '货品编码', 128), group: text(value.group || '未分组', '商品分组', 100), imageUrl: image(value.imageUrl, '商品图片', true), productType,
    giftEligible: productType === 'gift' || value.giftEligible === true, originalPrice: money(value.originalPrice ?? 0, '原价'),
    price: productType === 'sale' ? money(value.price, '售价') : 0, couponAmount: productType === 'coupon' ? money(value.couponAmount, '券面额') : 0,
    stock: productType === 'coupon' ? 0 : integer(value.stock ?? 0, '库存') };
  if (!result.barcode && !result.sku) fail('INVALID_INPUT', '商品需要条码或货品编码', 400);
  if (productType === 'sale' && !result.price || productType === 'coupon' && !result.couponAmount) fail('INVALID_INPUT', '售价或券面额须大于零', 400);
  return result;
}
function uniqueProducts(values) {
  if (!Array.isArray(values) || values.length > 20000) fail('INVALID_INPUT', '商品列表过大或无效', 400);
  const ids = new Set(), barcodes = new Set();
  for (const p of values) {
    if (ids.has(p.id) || p.barcode && barcodes.has(p.barcode)) fail('DUPLICATE_PRODUCT', '商品编号或条码重复', 400);
    ids.add(p.id); if (p.barcode) barcodes.add(p.barcode);
  }
  return values;
}
function promoRules(values, products) {
  if (!Array.isArray(values) || values.length > 1000) fail('INVALID_INPUT', '买赠规则列表不正确', 400);
  const seen = new Set();
  return values.map(value => {
    if (!object(value)) fail('INVALID_INPUT', '买赠规则不正确', 400);
    const key = id(value.id, '买赠规则编号'); if (seen.has(key)) fail('INVALID_INPUT', '买赠规则编号重复', 400); seen.add(key);
    if (!Array.isArray(value.mainProductIds) || !value.mainProductIds.length || !Array.isArray(value.gifts) || !value.gifts.length) fail('INVALID_INPUT', '买赠规则须有主品和赠品', 400);
    const mainProductIds = [...new Set(value.mainProductIds.map(key => id(key)))];
    if (mainProductIds.some(key => !products.some(p => p.id === key && p.productType === 'sale'))) fail('INVALID_INPUT', '买赠主品不存在', 400);
    const gifts = value.gifts.map(g => {
      const p = products.find(p => p.id === g.productId);
      if (!p || !(p.productType === 'gift' || p.giftEligible)) fail('INVALID_INPUT', '买赠赠品不存在或未启用赠送', 400);
      const qty = integer(g.qty, '赠品数量', 100000); if (!qty) fail('INVALID_INPUT', '赠品数量须大于零', 400);
      return { productId: p.id, qty };
    });
    if (new Set(gifts.map(g => g.productId)).size !== gifts.length) fail('INVALID_INPUT', '买赠赠品重复', 400);
    const startAt = text(value.startAt || '', '开始时间', 40), endAt = text(value.endAt || '', '结束时间', 40);
    if (startAt && !Number.isFinite(businessTime(startAt)) || endAt && !Number.isFinite(businessTime(endAt)) || startAt && endAt && businessTime(startAt) > businessTime(endAt)) fail('INVALID_INPUT', '买赠时间不正确', 400);
    return { id: key, enabled: value.enabled === true, mode: value.mode === 'choice' ? 'choice' : 'all', mainProductIds, stackable: value.stackable !== false, gifts, startAt, endAt };
  });
}
const emptyLedger = () => ({ products: [], orders: [], heldCarts: [], paymentQr: '', promoRules: [], pendingPayment: null, pendingAdjustment: null, pendingZero: null, pendingRestore: null, pendingCouponReservation: null });
const pending = ledger => Boolean(ledger.pendingPayment || ledger.pendingAdjustment || ledger.pendingZero || ledger.pendingRestore || ledger.pendingCouponReservation);
// The latch only cares about unresolved MONEY. pendingCouponReservation is a
// durable retry token for an idempotent coupon reserve — it self-guards with
// RESERVATION_PENDING and must not gray the till while a replay is pending.
const moneyPending = ledger => Boolean(ledger.pendingPayment || ledger.pendingAdjustment || ledger.pendingZero || ledger.pendingRestore);

async function createOnlineLedger({ pool, ns = '', service, now = Date.now, leaseMs = 20000 }) {
  if (!pool || typeof pool.query !== 'function' || !service || typeof service.dispatch !== 'function') throw new Error('Online ledger requires a database pool and payment service');
  await pool.query('INSERT IGNORE INTO pos_ledger(ns, id, revision, body) VALUES(?, 1, 0, ?)', [ns, JSON.stringify(emptyLedger())]);
  let tail = Promise.resolve(), closed = false, executing = false;
  const serialized = fn => { const next = tail.then(async () => { if (closed) throw new Error('Ledger closed'); executing = true; try { return await fn(); } finally { executing = false; } }); tail = next.catch(() => {}); return next; };
  const logic = Promise.all([import('../src/orderLogic.js'), import('../src/afterSales.js')]).then(([order, after]) => ({ ...order, ...after }));
  const COUPON_TASK_KEY = 'pendingCouponReservation';
  const couponTask = async (q = pool) => { const [rows] = await q.query('SELECT data FROM pos_coupon_meta WHERE ns = ? AND id = ?', [ns, COUPON_TASK_KEY]); if (!rows.length) return null; try { return JSON.parse(rows[0].data); } catch { return null; } };
  const saveCouponTask = async (task, q = pool) => { if (task) await q.query('REPLACE INTO pos_coupon_meta(ns, id, data) VALUES(?,?,?)', [ns, COUPON_TASK_KEY, JSON.stringify(task)]); else await q.query('DELETE FROM pos_coupon_meta WHERE ns = ? AND id = ?', [ns, COUPON_TASK_KEY]); };
  // The pending coupon-scan task lives in a small meta row, NOT the multi-MB
  // ledger blob: reserve/reserve-clear used to cost two full blob commits per
  // scan. read() overlays the task so every consumer keeps working unchanged.
  const read = async (q = pool) => {
    const [rows] = await q.query('SELECT revision, body FROM pos_ledger WHERE ns = ? AND id = 1', [ns]);
    const ledger = JSON.parse(rows[0].body);
    const task = await couponTask(q);
    if (task) ledger.pendingCouponReservation = task;
    else if (ledger.pendingCouponReservation) {
      // One-time migration of an in-flight task written by the pre-split code.
      await saveCouponTask(ledger.pendingCouponReservation, q);
      const cleaned = { ...ledger, pendingCouponReservation: null };
      await q.query('UPDATE pos_ledger SET body = ? WHERE ns = ? AND id = 1 AND revision = ?', [JSON.stringify(cleaned), ns, rows[0].revision]).catch(() => {});
    }
    return { revision: Number(rows[0].revision), ledger };
  };
  const lease = async (q = pool) => { const [rows] = await q.query('SELECT body FROM pos_lease WHERE ns = ? AND id = 1', [ns]); return rows.length ? JSON.parse(rows[0].body) : null; };
  const outbox = async (q = pool) => { const [rows] = await q.query('SELECT kind, id FROM pos_ack WHERE ns = ?', [ns]); return rows; };
  const awards = async (q = pool) => { const [rows] = await q.query('SELECT id, owner, line FROM pos_awards WHERE ns = ?', [ns]); return rows; };
  // Coupon-journal rows count toward the recovery latch only when DEAD: a live
  // reservation is a healthy checkout in progress, not a recovery case, and
  // must not gray the product grid on every till. snapshot() runs the sweeper
  // first, so expired rows are already finished; anything still unfinished
  // with a future TTL is a live checkout. Award rows backed by a live journal
  // row are live too — only orphans and dead residue latch.
  const couponRows = () => service.readOnlineState?.().couponRecords || [];
  const liveJournalIds = () => new Set(couponRows()
    .filter(row => !row.finished && Date.parse(row.coupon?.reservation?.expiresAt || '') > now())
    .map(row => row.id));
  const unfinishedCouponRows = () => couponRows()
    .filter(row => !row.finished && Date.parse(row.coupon?.reservation?.expiresAt || '') <= now());
  const hasAwards = async () => (await awards()).some(row => !liveJournalIds().has(row.id)) || unfinishedCouponRows().length > 0;
  const hasForeignAwards = async who => {
    const local = await awards(), live = liveJournalIds();
    return local.some(row => !live.has(row.id) && row.owner !== who?.sessionId) || unfinishedCouponRows().some(row => !local.some(a => a.id === row.id && a.owner === who?.sessionId));
  };
  const saveLease = async (value, q = pool) => value
    ? q.query('REPLACE INTO pos_lease(ns, id, body) VALUES(?, 1, ?)', [ns, JSON.stringify(value)])
    : q.query('DELETE FROM pos_lease WHERE ns = ?', [ns]);
  function actor(value) {
    if (!object(value) || !ROLES.includes(value.role)) fail('FORBIDDEN', '没有收银操作权限', 403);
    return { userId: id(value.userId, '账号'), sessionId: id(value.sessionId, '登录会话'), role: value.role, displayName: text(value.displayName || value.userId, '账号名称', 100),
      grants: effectiveGrants(value.role, Array.isArray(value.grants) ? value.grants : null) };
  }
  // Non-admin actors may only run commands mapped to a granted module section.
  function section(who, key) {
    if (who.role !== 'admin' && !who.grants.includes(key)) fail('FORBIDDEN', '没有该模块权限', 403);
  }
  // orderLimit trims the orders list to the newest N entries for hot paths
  // (command responses during checkout): those only ever concern current
  // orders, and shipping 3MB of history per action kills slow networks.
  // Responses say so via ordersComplete:false and the client merges.
  async function snapshot(who, { orderLimit = null, freshRow = null } = {}) {
    // Close coupon-journal rows whose reservations already died server-side
    // before computing the latch, so an abandoned checkout cannot freeze the
    // till until someone hand-edits the journal file.
    try { await service.sweepCoupons?.(); } catch { /* sweep is best-effort */ }
    const row = freshRow || await read(), lock = await lease(), owned = !!lock && lock.userId === who?.userId && lock.sessionId === who?.sessionId && lock.expiresAt > now();
    const recoveryRequired = Boolean(lock?.recoveryRequired || moneyPending(row.ledger) || (await outbox()).length || await hasForeignAwards(who));
    // Non-admin staff only see their own orders and held carts; legacy rows
    // without an owner stay visible to admins alone.
    let ledger = who && who.role !== 'admin'
      ? { ...row.ledger, orders: row.ledger.orders.filter(order => order.operatorId === who.userId), heldCarts: (row.ledger.heldCarts || []).filter(cart => cart.ownerId === who.userId) }
      : row.ledger;
    let ordersComplete = true;
    if (Number.isInteger(orderLimit) && orderLimit >= 0 && ledger.orders.length > orderLimit) {
      ledger = { ...ledger, orders: ledger.orders.slice(-orderLimit) };
      ordersComplete = false;
    }
    return { revision: row.revision, ledger, ordersComplete, recoveryRequired, lease: { held: !!lock && lock.expiresAt > now(), owned, mine: owned, userId: lock?.userId || '', displayName: lock?.displayName || '', expiresAt: lock?.expiresAt || 0, recoveryRequired } };
  }
  async function assertLease(who, { allowRecovery = false, allowAwards = false } = {}) {
    who = actor(who); const lock = await lease();
    if (!lock || lock.userId !== who.userId || lock.sessionId !== who.sessionId || lock.expiresAt <= now()) fail('LEASE_REQUIRED', '请先取得收银使用权；可能由其他账号或标签页占用');
    if (!allowRecovery && (lock.recoveryRequired || pending((await read()).ledger) || (await outbox()).length)) fail('RECOVERY_REQUIRED', '请先完成未决收退款、核销或账务恢复');
    if (!allowRecovery && (!allowAwards && await hasAwards() || await hasForeignAwards(who))) fail('AWARD_RESERVED', '请先完成或释放当前领奖券占用');
    return who;
  }
  async function acquireLease(who, { takeover = false } = {}) {
    who = actor(who);
    await withTransaction(pool, async q => {
      const old = await lease(q), mine = old?.userId === who.userId && old?.sessionId === who.sessionId;
      if (!mine && executing) fail('LEASE_BUSY', '收银正在处理请求，请稍后再接管');
      if (takeover && who.role !== 'admin') fail('FORBIDDEN', '只有管理员可以明确接管收银', 403);
      if (old && !mine && !takeover && (old.expiresAt > now() || pending((await read(q)).ledger) || (await outbox(q)).length || await hasAwards())) fail('LEASE_HELD', `收银由${old.displayName || '另一账号'}占用${old.expiresAt <= now() ? '，存在未决记录，请管理员接管并恢复' : '，请等待释放或联系管理员接管'}`);
      // Owner re-acquire: recompute from live residue instead of inheriting
      // the old flag (a stale true otherwise latches the till forever).
      // Takeover keeps the original full-pending semantics.
      const liveResidue = pending((await read(q)).ledger) || !!(await outbox(q)).length || await hasForeignAwards(who);
      await saveLease({ userId: who.userId, sessionId: who.sessionId, role: who.role, displayName: who.displayName, startedAt: mine && old?.startedAt ? old.startedAt : now(), expiresAt: now() + leaseMs, recoveryRequired: mine ? liveResidue : liveResidue || await hasAwards(q) || takeover }, q);
    });
    return snapshot(who);
  }
  async function releaseLease(who) { who = await assertLease(who); if (executing) fail('LEASE_BUSY', '收银正在处理请求，请稍后释放'); await withTransaction(pool, async q => { await assertLease(who); await saveLease(null, q); }); return snapshot(who); }
  // First-come-first-served transaction pipe: payment-pipe commands take the
  // lock implicitly instead of requiring a manual lease step. A valid lock
  // held by someone else yields PIPE_BUSY; an absent or expired lock is taken
  // for this session with the same recoveryRequired semantics as acquireLease.
  async function ensurePipe(who, { allowRecovery = false, allowAwards = false } = {}) {
    who = actor(who);
    await withTransaction(pool, async q => {
      const old = await lease(q), mine = old?.userId === who.userId && old?.sessionId === who.sessionId;
      if (mine && old.expiresAt > now()) {
        // Refresh the crash-backstop TTL. Never RAISE the latch here (a live
        // checkout's own prepared state is normal business); only recompute to
        // CLEAR a stale flag once its residue is gone — the no-lease v2 UI
        // never re-acquires, so this refresh is the only mutation the row gets.
        const still = old.recoveryRequired && (moneyPending((await read(q)).ledger) || !!(await outbox(q)).length || await hasForeignAwards(who));
        if (old.recoveryRequired && !still) console.log(`[lease-latch] refresh cleared stale flag (residue gone) who=${who.displayName || who.userId}`);
        await saveLease({ ...old, recoveryRequired: Boolean(still), expiresAt: now() + leaseMs }, q);
        return;
      }
      if (old && old.expiresAt > now()) {
        const row = await read(q);
        fail('PIPE_BUSY', '另一位同事正在收款，请稍候', 409, { holder: {
          displayName: old.displayName || '',
          orderId: row.ledger.pendingPayment?.draft.id || row.ledger.pendingAdjustment?.id || null,
          since: old.startedAt || old.expiresAt - leaseMs,
        } });
      }
      const money = moneyPending((await read(q)).ledger), outboxFull = !!(await outbox(q)).length, awardResidue = await hasAwards();
      const recoveryRequired = money || outboxFull || awardResidue;
      if (recoveryRequired) console.log(`[lease-latch] fresh-take raised: money=${money} outbox=${outboxFull} awards=${awardResidue} who=${who.displayName || who.userId}`);
      await saveLease({ userId: who.userId, sessionId: who.sessionId, role: who.role, displayName: who.displayName, startedAt: now(), expiresAt: now() + leaseMs, recoveryRequired }, q);
    });
    if (!allowRecovery) {
      const lock = await lease();
      if (lock?.recoveryRequired || pending((await read()).ledger) || (await outbox()).length) fail('RECOVERY_REQUIRED', '请先完成未决收退款、核销或账务恢复');
    }
    if (!allowRecovery && (!allowAwards && await hasAwards() || await hasForeignAwards(who))) fail('AWARD_RESERVED', '请先完成或释放当前领奖券占用');
    return who;
  }
  // Auto-release: once a pipe command leaves no unfinished business for this
  // session, the pipe frees immediately instead of waiting for the TTL. The
  // compare-and-delete guard never removes a lock another session just took.
  async function releasePipeIfClean(who) {
    const [rows] = await pool.query('SELECT body FROM pos_lease WHERE ns = ? AND id = 1', [ns]);
    if (!rows.length) return false;
    const raw = rows[0].body;
    let lock; try { lock = JSON.parse(raw); } catch { return false; }
    if (lock.userId !== who.userId || lock.sessionId !== who.sessionId) return false;
    const row = await read(), myAwards = (await awards()).some(entry => entry.owner === who.sessionId);
    if (pending(row.ledger) || (await outbox()).length || myAwards) return false;
    const [result] = await pool.query('DELETE FROM pos_lease WHERE ns = ? AND id = 1 AND body = ?', [ns, raw]);
    return result.affectedRows === 1;
  }
  function admin(who) { if (who.role !== 'admin') fail('FORBIDDEN', '此操作需要管理员账号', 403); }
  const previousCommand = async (who, requestId) => { const [rows] = await pool.query('SELECT fingerprint, result FROM pos_commands WHERE ns = ? AND actor = ? AND request_id = ?', [ns, who.userId, requestId]); return rows[0]; };
  async function commit(next, revision, command, extra = {}, ack = [], releasedAwards = [], reservedAwards = []) {
    await withTransaction(pool, async q => {
      // Optimistic locking: the revision guard in UPDATE enforces the CAS even if
      // another connection slipped in between our read and this write.
      const [result] = await q.query('UPDATE pos_ledger SET revision = revision + 1, body = ? WHERE ns = ? AND id = 1 AND revision = ?', [JSON.stringify(next), ns, revision]);
      if (result.affectedRows !== 1) fail('REVISION_CONFLICT', '账本已更新，请刷新后重试');
      for (const item of ack) await q.query('INSERT IGNORE INTO pos_ack(ns, kind, id) VALUES(?,?,?)', [ns, item.kind, item.id]);
      for (const key of releasedAwards) await q.query('DELETE FROM pos_awards WHERE ns = ? AND id = ?', [ns, key]);
      for (const row of reservedAwards) await q.query('REPLACE INTO pos_awards(ns, id, owner, line) VALUES(?,?,?,?)', [ns, row.id, row.owner, JSON.stringify(row.line)]);
      // One batched DELETE instead of one round trip per coupon line: order
      // history accumulates hundreds of external-coupon lines, and a per-line
      // await loop here once added ~4s to every single command commit.
      const reservationIds = [...new Set(next.orders.flatMap((order) => (order.items || []).map((line) => line.externalCoupon?.reservationId).filter(Boolean)))];
      if (reservationIds.length) await q.query('DELETE FROM pos_awards WHERE ns = ? AND id IN (?)', [ns, reservationIds]);
      if (command) await q.query('REPLACE INTO pos_commands(ns, actor, request_id, fingerprint, result) VALUES(?,?,?,?,?)', [ns, command.who.userId, command.requestId, command.hash, JSON.stringify({ status: command.status || 'done', extra })]);
    });
  }
  async function flushAcks() {
    for (const entry of await outbox()) {
      try { await service.dispatch(entry.kind === 'zero' ? 'coupon-zero-ack' : 'acknowledge', { id: entry.id }); await pool.query('DELETE FROM pos_ack WHERE ns = ? AND kind = ? AND id = ?', [ns, entry.kind, entry.id]); }
      catch { /* The committed ledger is authoritative; recovery retries this durable outbox. */ }
    }
  }
  async function journal() {
    if (typeof service.readOnlineState === 'function') return service.readOnlineState();
    return { records: await service.dispatch('pending'), restoreStage: null };
  }
  async function trustedRecord(key, query = false) {
    if (query) await service.dispatch('query', { id: key });
    return (await journal()).records.find(row => row.id === key) || null;
  }
  async function syncAwards() {
    const rows = await service.dispatch('coupon-sync', {});
    if (!Array.isArray(rows)) fail('UNTRUSTED_RESULT', '核销占用结果不正确');
    const active = new Set(rows.map(row => row.id));
    for (const row of await awards()) if (!active.has(row.id)) await pool.query('DELETE FROM pos_awards WHERE ns = ? AND id = ?', [ns, row.id]);
    return rows;
  }
  async function requireNoPending(who, allowAwards = false) { await assertLease(who, { allowAwards }); }
  // Lease-free commands still require a clean financial state: no catalog or
  // basket mutations while payments, outbox syncs or award reservations pend.
  async function requireClearState(who, { allowAwards = false, row = null } = {}) {
    who = actor(who); const lock = await lease();
    if (lock?.recoveryRequired || pending((row || await read()).ledger) || (await outbox()).length) fail('RECOVERY_REQUIRED', '请先完成未决收退款、核销或账务恢复');
    if ((!allowAwards && await hasAwards()) || await hasForeignAwards(who)) fail('AWARD_RESERVED', '请先完成或释放当前领奖券占用');
  }
  async function reserveCoupon(payload, who, recovering = false) {
    let task = await couponTask();
    if (!task) {
      await assertLease(who, { allowAwards: true });
      const input = { code: text(payload.code, '券码', 200, false), checkoutId: id(payload.checkoutId, '结算编号'), requestId: id(payload.requestId, '请求编号'), eligibleCents: integer(payload.eligibleCents ?? 0, '可用金额', 10000000000) };
      task = { input, ownerId: who.userId, sessionId: who.sessionId };
      // Persist intent before the center call so a lost response cannot lose the lock.
      await saveCouponTask(task);
    } else if (!recovering && (task.sessionId !== who.sessionId || fingerprint(task.input) !== fingerprint({ code: payload.code, checkoutId: payload.checkoutId, requestId: payload.requestId, eligibleCents: payload.eligibleCents ?? 0 }))) fail('RESERVATION_PENDING', '请先恢复原扫码占用请求');
    let line;
    try { line = await service.dispatch('coupon-reserve', { ...task.input, products: clone((await read()).ledger.products) }); }
    catch (error) {
      const settled = (await journal()).couponRecords?.find(r => r.coupon?.reservation?.checkoutId === task.input.checkoutId && r.finished && !r.zeroDraft && r.coupon?.state !== 'REDEEMED');
      if (settled || ['INVALID_CODE','NOT_FOUND','NOT_AVAILABLE','CHECKOUT_CONFLICT','MINIMUM_NOT_MET','REDEMPTION_PAUSED','EXPIRED','INVALID_INPUT','FORBIDDEN'].includes(error.code)) {
        await saveCouponTask(null);
      }
      throw error;
    }
    if (!line?.externalCoupon?.reservationId) fail('UNTRUSTED_RESULT', '核销中心未返回有效占用，请恢复原扫码请求');
    await saveCouponTask(null);
    await pool.query('REPLACE INTO pos_awards(ns, id, owner, line) VALUES(?,?,?,?)', [ns, line.externalCoupon.reservationId, task.sessionId, JSON.stringify(line)]);
    return line;
  }
  async function canonicalItems(input, ledger, { zero = false, awards = true, stock = true } = {}) {
    if (!Array.isArray(input) || !input.length || input.length > 500) fail('INVALID_INPUT', '商品明细为空或过多', 400);
    const rows = [];
    for (const value of input) {
      if (!object(value)) fail('INVALID_INPUT', '商品明细不正确', 400);
      const qty = integer(value.qty, '商品数量', 100000); if (!qty) fail('INVALID_INPUT', '商品数量须大于零', 400);
      if (value.externalCoupon) {
        if (!awards || zero) fail('INVALID_INPUT', '此操作不接受抽奖凭证', 400);
        const key = id(value.externalCoupon.reservationId, '核销占用编号'), [savedRows] = await pool.query('SELECT line, owner FROM pos_awards WHERE ns = ? AND id = ?', [ns, key]), saved = savedRows[0];
        if (!saved) fail('AWARD_NOT_RESERVED', '请在当前收银系统重新扫描领奖凭证');
        if (saved.owner !== (await lease())?.sessionId) fail('AWARD_OWNER_CHANGED', '请释放此前账号的领奖占用，再重新扫码');
        const line = JSON.parse(saved.line);
        if (fingerprint(value.externalCoupon) !== fingerprint(line.externalCoupon) || value.id !== line.id || qty !== 1) fail('INVALID_INPUT', '领奖商品或凭证被修改', 400);
        if (line.externalCoupon.kind === 'physical') {
          const current = ledger.products.find(p => p.id === line.id);
          if (!current || ['name', 'sku', 'barcode'].some(k => current[k] !== line[k])) fail('PRODUCT_CHANGED', '奖品绑定商品已变更，请先重新核对');
        }
        rows.push(clone(line)); continue;
      }
      const p = ledger.products.find(p => p.id === value.id); if (!p) fail('PRODUCT_MISSING', '商品已删除，请刷新购物车');
      const discount = money(Number(value.discount || 0), '优惠金额');
      let prize = null;
      if (value.prize !== undefined && value.prize !== null) {
        // Activity-prize tag scanned at the till: one free gift line that flips
        // the lottery entry to redeemed when the order commits. Shape-checked
        // here; the redeem itself re-validates the code at payment time.
        if (!object(value.prize)) fail('INVALID_INPUT', '奖品信息不正确', 400);
        const code = text(value.prize.code, '奖品核销码', 16, false).toUpperCase();
        if (!/^[0-9A-F]{16}$/.test(code)) fail('INVALID_INPUT', '奖品核销码不正确', 400);
        prize = { code, prizeName: text(value.prize.prizeName || '', '奖品名称', 100) };
      }
      if (prize && value.source === 'promo') fail('INVALID_INPUT', '买赠赠品不能作为抽奖奖品，请重新扫码', 400);
      if (value.source === 'promo') {
        const rule = ledger.promoRules.find(rule => rule.id === value.promoRuleId && rule.enabled && (!rule.startAt || businessTime(rule.startAt) <= now()) && (!rule.endAt || businessTime(rule.endAt) >= now()));
        if (!rule || !(p.productType === 'gift' || p.giftEligible) || !rule.gifts.some(g => g.productId === p.id)) fail('INVALID_PROMO', '买赠规则已失效，请重新选择商品');
        rows.push({ ...p, qty, productType: 'gift', price: 0, discount: 0, source: 'promo', promoRuleId: rule.id, lineKey: `promo-gift:${rule.id}:${p.id}`, catalogProduct: { productType: p.productType, price: p.price, giftEligible: p.giftEligible } }); continue;
      }
      if (prize) {
        // A prize line is always one free gift, whatever the catalog type of
        // the backing product — same eligibility as the promo-gift path, so
        // 可售可赠 (sale + giftEligible) products work as activity prizes too.
        // Runs before the price re-check because the till legitimately sends
        // a hacked gift/¥0 line for a product whose catalog price is non-zero.
        const eligible = p.productType === 'gift' || (p.productType === 'sale' && p.giftEligible);
        if (!eligible || qty !== 1) fail('INVALID_INPUT', '抽奖奖品固定为一件赠品，请重新扫码', 400);
        rows.push({ ...p, qty, productType: 'gift', price: 0, discount: 0, source: 'gift', lineKey: `prize:${prize.code}`, prize, catalogProduct: { productType: p.productType, price: p.price, giftEligible: p.giftEligible } });
        continue;
      }
      // Buy-X-get-Y promo gift lines keep their own canonical identity: the
      // free gift and a manually added unit of the same product must stay
      // separate lines (distinct lineKeys), otherwise the duplicate-line
      // check below rejects the basket and the order cannot settle.
      if (value.source === 'promo' && value.promoRuleId) {
        const rule = ledger.promoRules.find((r) => r.id === value.promoRuleId);
        const gift = rule?.gifts.find((g) => g.productId === value.id);
        if (!rule || !gift) fail('INVALID_PROMO', '买赠规则已失效，请移除赠品后重新选择');
        if (!rule.enabled || rule.startAt && businessTime(rule.startAt) > now() || rule.endAt && businessTime(rule.endAt) < now()) fail('INVALID_PROMO', '买赠规则不在有效期内');
        rows.push({ ...p, qty, price: 0, discount: 0, productType: 'gift', source: 'promo', promoRuleId: rule.id,
          lineKey: `promo-gift:${rule.id}:${p.id}`,
          catalogProduct: { productType: p.productType, price: p.price, giftEligible: p.productType === 'gift' || Boolean(p.giftEligible) } });
        continue;
      }
      if (!zero && (Number(value.price) !== p.price || value.productType !== p.productType || p.productType === 'coupon' && Number(value.couponAmount) !== p.couponAmount)) fail('PRICE_CHANGED', `${p.name}售价或类型已变化，请重新选择`);
      if (discount > p.price * qty) fail('INVALID_INPUT', '优惠不能超过商品金额', 400);
      rows.push({ ...p, qty, discount: zero || p.productType !== 'sale' ? 0 : discount, source: p.productType, lineKey: p.productType === 'gift' ? `gift:${p.id}` : p.id });
    }
    const keys = new Set(); for (const line of rows) { const key = line.lineKey || line.id; if (keys.has(key)) fail('INVALID_INPUT', '购物车明细重复', 400); keys.add(key); }
    for (const rule of ledger.promoRules) {
      const selected = rows.filter(row => row.source === 'promo' && row.promoRuleId === rule.id); if (!selected.length) continue;
      const mains = rows.filter(row => row.source !== 'promo' && row.productType === 'sale' && rule.mainProductIds.includes(row.id)).reduce((n, row) => n + row.qty, 0);
      const count = rule.stackable ? mains : Math.min(1, mains); if (!count) fail('INVALID_PROMO', '缺少买赠主品');
      let choices = 0;
      for (const line of selected) { const gift = rule.gifts.find(g => g.productId === line.id); if (line.qty > gift.qty * count) fail('INVALID_PROMO', '赠品数量超出买赠规则'); choices += line.qty / gift.qty; }
      if (rule.mode === 'choice' && choices > count) fail('INVALID_PROMO', '任选赠品超出可选数量');
    }
    if (stock) {
      const used = new Map(); for (const line of rows) if (line.productType !== 'coupon') used.set(line.id, (used.get(line.id) || 0) + line.qty);
      for (const [key, qty] of used) if ((ledger.products.find(p => p.id === key)?.stock ?? -1) < qty) fail('INSUFFICIENT_STOCK', '商品库存不足，请重新选择');
    }
    return rows;
  }
  async function draft(value, ledger, method) {
    const lib = await logic;
    if (!object(value) || !/^[A-Za-z0-9-]{1,64}$/.test(value.id || '') || !/^[A-Za-z0-9_-]{1,64}$/.test(value.orderNo || '')) fail('INVALID_INPUT', '订单编号不正确', 400);
    const items = await canonicalItems(value.items, ledger, { zero: method === '0元出库' });
    const priced = lib.priceOrder(items, method === '0元出库');
    if (value.total !== undefined && Number(value.total) !== priced.total) fail('PRICE_CHANGED', '订单金额已变化，请重新确认');
    return { id: value.id, orderNo: value.orderNo, method, createdAt: new Date(now()).toISOString(), day: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now()), status: '待收款', ...priced };
  }
  async function adjustmentInput(payload, ledger) {
    const lib = await logic, original = ledger.orders.find(o => o.id === payload.parentId); if (!original) fail('ORDER_MISSING', '原订单不存在');
    if (original.payment?.provider !== 'sqb') fail('INVALID_INPUT', '普通订单请使用订单修改或取消', 400);
    if (!object(payload.request)) fail('INVALID_INPUT', '退换货请求不正确', 400);
    const request = { id: id(payload.request.id, '退换货编号'), type: payload.request.type, returns: clone(payload.request.returns), reason: text(payload.request.reason || '', '退换货原因', 200),
      newItems: payload.request.type === 'exchange' ? await canonicalItems(payload.request.newItems, ledger, { awards: false, stock: false }) : [] };
    const plan = lib.adjustmentPlan(original, request); lib.validateAdjustmentStock(ledger.products, plan);
    return { original, request, plan };
  }
  // Activity-prize lines (lottery physical wins scanned at the till) redeem
  // their entry once the order is durable. Fires only for orders carrying a
  // prize tag; failures are logged, never thrown — the order is committed and
  // must not be left half-done.
  async function notifyOrderPrizes(order, who) {
    if (!order?.items?.some(item => item.prize?.code)) return;
    try { await service.notifyOrderPaid?.(order, who); }
    catch (error) { console.error(`[activity] 奖品核销通知失败 order=${order?.id ?? ''}:`, error?.message || error); }
  }
  async function syncRecord(key, who, clearOnly = false, op = null) {
    const lib = await logic, record = await trustedRecord(key, true), row = await read(); let next = row.ledger;
    const isAdjustment = next.pendingAdjustment?.id === key, isPayment = next.pendingPayment?.draft.id === key;
    const saved = next.orders.find(o => o.id === key || o.afterSales?.some(a => a.id === key));
    // A paid payment record whose checkout was abandoned (network loss, closed
    // modal) has no pendingPayment and no saved order — but the money is real.
    // Let it through so the orphan branch below can commit the verified draft.
    const orphanPaid = !record?.kind && record?.state === 'paid' && !saved;
    if (!isAdjustment && !isPayment && !saved && !orphanPaid) fail('TRANSACTION_MISMATCH', '未找到当前待处理交易');
    if (!record) {
      if (!clearOnly) fail('NOT_STARTED', '尚未产生支付记录，可确认关闭未发起订单');
      if (isAdjustment) next.pendingAdjustment = null; if (isPayment) next.pendingPayment = null;
      await commit(next, row.revision, op); return;
    }
    const succeeded = ['paid', 'refunded', 'completed'].includes(record.state);
    if (succeeded) {
      if (clearOnly) fail('PAYMENT_SUCCEEDED', '资金已成功，请先完成入账');
      if (record.kind) {
        if (!isAdjustment && !saved) fail('TRANSACTION_MISMATCH', '退换货归属不一致');
        if (isAdjustment && (next.pendingAdjustment.parentId !== record.parentId || !samePlan(next.pendingAdjustment.preview.plan, record.plan))) fail('TRANSACTION_MISMATCH', '退款记录与预留计划不一致');
        if (isAdjustment) next = lib.applyAdjustment(next, record);
        else { const entry = saved.afterSales.find(a => a.id === key); if (!entry || entry.orderSn !== (record.orderSn || '') || !samePlan(entry.plan, record.plan)) fail('TRANSACTION_MISMATCH', '已保存退换货与支付日志不一致'); }
      } else if (isPayment) {
        next = lib.completeSqbOrder(next, record);
        if (who?.userId) next = { ...next, orders: next.orders.map(o => o.id === record.id && !o.operatorId ? { ...o, operatorId: who.userId } : o) };
      }
      else if (orphanPaid) {
        // Orphaned paid payment: money arrived after the owning checkout was
        // discarded. The record's draft is the server-verified snapshot —
        // commit it so revenue, stock and prize redemption actually land.
        next = lib.completeSqbOrder(next, record);
        next = { ...next, orders: next.orders.map(o => o.id === record.id && !o.operatorId ? { ...o, operatorId: 'system', operatorName: '系统自动核对' } : o) };
      }
      else if (saved.payment?.orderSn !== record.orderSn) fail('TRANSACTION_MISMATCH', '已保存订单与支付日志不一致');
      await commit(next, row.revision, op, {}, [{ kind: 'payment', id: key }]);
      await notifyOrderPrizes(next.orders.find(o => o.id === key), who);
      await flushAcks(); return;
    }
    if (record.state === 'failed') {
      if (isAdjustment) next.pendingAdjustment = null; if (isPayment) next.pendingPayment = null;
      await commit(next, row.revision, op, {}, [{ kind: 'payment', id: key }]); await flushAcks(); return;
    }
    if (clearOnly) fail('PAYMENT_UNRESOLVED', '资金结果未确定，不能关闭待处理任务');
    if (isAdjustment) next.pendingAdjustment.record = clone(record); if (isPayment) next.pendingPayment.record = clone(record);
    await commit(next, row.revision, op);
  }
  // Orphan observatory: one admin-only read that surfaces everything which can
  // latch the till (hanging orders, unresolved payment records, unfinished
  // coupon transactions, stale award reservations, outbox/lease state) plus
  // the surgical removers. These intentionally bypass the clean-state guards:
  // they exist precisely for the residue the guards refuse to touch.
  async function maintenanceScan() {
    const row = await read(), lock = await lease();
    const journalState = typeof service.readOnlineState === 'function' ? service.readOnlineState() : { records: [], couponRecords: [] };
    const [ackRows] = await pool.query('SELECT kind, id FROM pos_ack WHERE ns = ?', [ns]);
    const [awardRows] = await pool.query('SELECT id, owner, line FROM pos_awards WHERE ns = ?', [ns]);
    const hangingOrders = row.ledger.orders.filter((o) => o.status !== '已收款').map((o) => ({ id: o.id, orderNo: o.orderNo, status: o.status, method: o.method, total: o.total, createdAt: o.createdAt, paymentOrderSn: o.payment?.orderSn || '', afterSales: (o.afterSales || []).length }));
    const unresolvedPayments = (journalState.records || []).filter((r) => r && !r.acknowledged && r.state !== 'failed')
      .map((r) => ({ id: r.id, state: r.state, orderNo: r.identity?.check_sn || '', amount: r.amount, updatedAt: r.updatedAt, message: r.message || '' }));
    const failedPayments = (journalState.records || []).filter((r) => r && r.state === 'failed').slice(-10)
      .map((r) => ({ id: r.id, orderNo: r.identity?.check_sn || '', amount: r.amount, acknowledged: r.acknowledged, updatedAt: r.updatedAt, message: r.message || '' }));
    const couponTx = (journalState.couponRecords || []).filter((r) => r && !r.finished)
      .map((r) => ({ id: r.id, name: r.coupon?.name || '抽奖奖品', state: r.coupon?.state || '', orderId: r.orderId || '', zeroDraft: Boolean(r.zeroDraft), updatedAt: r.updatedAt || '' }));
    const awardReservations = awardRows.map((r) => {
      let name = '';
      try { const line = typeof r.line === 'string' ? JSON.parse(r.line) : r.line; name = line.name || (line.externalCoupon?.kind === 'physical' ? '实物奖品' : '') || ''; } catch { /* keep blank */ }
      return { id: r.id, owner: r.owner, name };
    });
    return {
      latch: {
        recoveryRequired: Boolean(lock?.recoveryRequired || moneyPending(row.ledger) || ackRows.length || await hasAwards()),
        pendingPayment: row.ledger.pendingPayment?.draft.id || null,
        pendingAdjustment: row.ledger.pendingAdjustment?.id || null,
        pendingZero: row.ledger.pendingZero?.draft.id || null,
        outbox: ackRows.map((a) => `${a.kind}:${a.id}`),
        lease: lock && lock.expiresAt > now() ? { displayName: lock.displayName || '', userId: lock.userId, recoveryRequired: Boolean(lock.recoveryRequired), expiresInMs: lock.expiresAt - now() } : null,
      },
      hangingOrders, unresolvedPayments, failedPayments, couponTx, awardReservations,
    };
  }
  async function maintenanceRemoveOrder(key, who) {
    const row = await read();
    const order = row.ledger.orders.find((o) => o.id === key);
    if (!order) fail('NOT_FOUND', '订单不存在', 404);
    if (order.status !== '已取消') fail('INVALID_INPUT', '只能移除「已取消」的订单；其他状态请走正常收退款流程', 400);
    if ((order.afterSales || []).length) fail('INVALID_INPUT', '该订单存在售后记录，不能移除', 400);
    if (order.payment?.orderSn) fail('INVALID_INPUT', '该订单存在支付流水，不能移除', 400);
    const next = { ...row.ledger, orders: row.ledger.orders.filter((o) => o.id !== key) };
    await commit(next, row.revision, { who, requestId: `maintenance-remove-order:${key}`, hash: '' });
    console.log(`[maintenance] 已移除悬挂订单 ${order.orderNo} (${key}) by ${who.displayName || who.userId}`);
    return maintenanceScan();
  }
  async function maintenanceReleaseAward(key) {
    let release;
    try { release = { ok: true, result: await service.dispatch('coupon-release', { id: key }) }; }
    catch (error) { release = { ok: false, error: error.message || String(error) }; }
    const [del] = await pool.query('DELETE FROM pos_awards WHERE ns = ? AND id = ?', [ns, key]);
    console.log(`[maintenance] 释放领奖占用 ${key}: remote=${release.ok ? 'ok' : release.error} awardRows=${del.affectedRows}`);
    return { release, awardRowsRemoved: del.affectedRows };
  }
  async function zeroComplete(input, who, command) {
    const lib = await logic; let row = await read(), saved = row.ledger.pendingZero;
    if (!saved) {
      await assertLease(who, { allowAwards: true }); const prepared = await draft(input.draft, row.ledger, '零元结算');
      if (!prepared.items.some(p => p.externalCoupon) || prepared.total !== 0) fail('INVALID_INPUT', '不是中奖券零元结算订单', 400);
      row.ledger.pendingZero = { draft: prepared, owner: who.userId, command: command ? { ...command, who: { userId: who.userId } } : null };
      await commit(row.ledger, row.revision, command && { ...command, status: 'pending' }); row = await read(); saved = row.ledger.pendingZero;
    } else if (input.draft && input.draft.id !== saved.draft.id) fail('TRANSACTION_MISMATCH', '请先恢复原零元核销');
    let result;
    try { result = await service.dispatch('coupon-zero', { draft: saved.draft }); }
    catch (error) {
      // A zeroDraft is fsynced by the trusted coupon bridge before any commit
      // request. Its presence means the redemption outcome must be recovered.
      const key = saved.draft.items.find(i => i.externalCoupon)?.externalCoupon.reservationId;
      let releasable = false;
      try {
        const rows = await service.dispatch('coupon-sync', {}), active = rows.find(r => r.id === key);
        const internal = (await journal()).couponRecords?.find(r => r.id === key);
        releasable = !internal?.zeroDraft && internal?.coupon?.state !== 'REDEEMED' && (active && !active.zeroDraft && active.canRelease === true || internal?.finished === true);
        if (releasable) await service.dispatch('coupon-release', { id: key });
      } catch { releasable = false; }
      if (releasable) {
        const issue = { code: 'ZERO_CANCELLED', message: '核销未完成，原券占用已释放，请重新扫码后再试。' };
        row = await read(); row.ledger.pendingZero = null;
        await commit(row.ledger, row.revision, { ...(saved.command || command), status: 'failed' }, { error: issue }, [], [key]);
        throw problem(issue.code, issue.message);
      }
      throw error;
    }
    if (!result?.coupon || result.coupon.state !== 'REDEEMED' || result.draft?.id !== saved.draft.id || fingerprint(result.draft.items.map(({ imageUrl, ...p }) => p)) !== fingerprint(saved.draft.items.map(({ imageUrl, ...p }) => p))) fail('UNTRUSTED_RESULT', '核销结果与原订单不一致');
    row = await read(); let next = row.ledger;
    if (!next.orders.some(o => o.id === saved.draft.id)) next = lib.completeOrder(next, { ...saved.draft, physicalFulfilled: saved.draft.items.some(lib.isExternalPhysical), operatorId: who.userId }, result.coupon.redeemedAt || new Date(now()).toISOString());
    next.pendingZero = null;
    await commit(next, row.revision, saved.command || command, {}, [{ kind: 'zero', id: saved.draft.id }]);
    await notifyOrderPrizes(next.orders.find(o => o.id === saved.draft.id), who);
    await flushAcks();
  }
  async function initialImport(payload, who, command) {
    admin(who); let row = await read(), task = row.ledger.pendingRestore;
    if (!task) {
      await assertLease(who);
      if (row.ledger.products.length || row.ledger.orders.length || row.ledger.heldCarts.length) fail('IMPORT_NOT_EMPTY', '线上已有商品或流水，禁止初始化覆盖');
      row.ledger.pendingRestore = { phase: 'preparing', bundle: clone(payload.bundle), command: command ? { ...command, who: { userId: who.userId } } : null };
      await commit(row.ledger, row.revision, command && { ...command, status: 'pending' }); task = (await read()).ledger.pendingRestore;
    }
    if (task.phase === 'preparing') {
      try {
        const state = await journal();
        const prepared = state.restoreStage || await service.dispatch('prepare-restore', { bundle: task.bundle });
        if (!prepared?.token || !prepared.business) fail('RESTORE_UNAVAILABLE', '恢复准备未完成，请重试');
        const business = prepared.business, products = uniqueProducts((business.products || []).map(product));
        if (!Array.isArray(business.orders) || !Array.isArray(business.heldCarts || [])) fail('INVALID_INPUT', '备份账本不正确', 400);
        const normalized = { ...emptyLedger(), products, orders: clone(business.orders), heldCarts: clone(business.heldCarts || []), paymentQr: image(business.paymentQr || '', '收款码', true), promoRules: promoRules(business.promoRules || [], products) };
        row = await read(); row.ledger.pendingRestore = { phase: 'committing', token: prepared.token, business: normalized, command: task.command };
        await commit(row.ledger, row.revision); task = (await read()).ledger.pendingRestore;
      } catch (error) {
        // No payment journal has been replaced while preparing. Abort any durable
        // service stage before clearing the intent; if abort fails recovery retains it.
        const stage = (await journal()).restoreStage;
        if (stage) await service.dispatch('abort-restore', { token: stage.token });
        row = await read(); row.ledger.pendingRestore = null; await commit(row.ledger, row.revision);
        if (task.command) await pool.query('DELETE FROM pos_commands WHERE ns = ? AND actor = ? AND request_id = ?', [ns, task.command.who.userId, task.command.requestId]);
        throw error;
      }
    }
    await service.dispatch('commit-restore', { token: task.token });
    row = await read(); await commit(task.business, row.revision, task.command || command);
  }
  async function recovery(who) {
    await assertLease(who, { allowRecovery: true }); await flushAcks();
    let row = await read();
    if (row.ledger.pendingCouponReservation) { await reserveCoupon({}, who, true); row = await read(); }
    if (row.ledger.pendingRestore) { await initialImport({}, who); row = await read(); }
    if (row.ledger.pendingZero) { await zeroComplete({}, who); row = await read(); }
    const state = await journal();
    for (const record of state.records.filter(r => !r.acknowledged)) {
      row = await read();
      if (record.state === 'failed' && row.ledger.pendingPayment?.draft.id !== record.id && row.ledger.pendingAdjustment?.id !== record.id) {
        // Signed backups may legitimately contain failed attempts with no sale.
        // The trusted journal proves no funds moved; retain an ack outbox without
        // fabricating a business order or disturbing another prepared operation.
        await commit(row.ledger, row.revision, null, {}, [{ kind: 'payment', id: record.id }]); await flushAcks(); continue;
      }
      if (record.kind) {
        const stored = row.ledger.orders.find(o => o.afterSales?.some(a => a.id === record.id));
        if (!row.ledger.pendingAdjustment && !stored) fail('RECOVERY_MISMATCH', '退换货日志缺少云端预留记录，请管理员核对');
      } else if (!row.ledger.pendingPayment && !row.ledger.orders.some(o => o.id === record.id)) {
        fail('RECOVERY_MISMATCH', '支付日志缺少云端预留订单，请管理员核对，不可重新收款');
      }
      await syncRecord(record.id, who);
    }
    if (await hasAwards()) await syncAwards();
    row = await read();
    const lock = await lease(); if (lock && lock.sessionId === who.sessionId && !pending(row.ledger) && !(await outbox()).length && !(await hasForeignAwards(who))) await saveLease({ ...lock, recoveryRequired: false, expiresAt: now() + leaseMs });
  }
  async function forceReleaseLease(who) {
    who = actor(who); admin(who);
    if (executing) fail('LEASE_BUSY', '收银正在处理请求，请稍后操作');
    await withTransaction(pool, async q => {
      const old = await lease(q);
      if (!old) return;
      if (pending((await read(q)).ledger) || (await outbox(q)).length || await hasAwards()) fail('LEASE_HAS_PENDING', '存在未决收退款或券占用，不能强制释放；请使用接管并恢复', 409);
      await saveLease(null, q);
    });
    return snapshot(who);
  }
  // Pipe scope: money-mutating commands occupy the first-come-first-served
  // transaction pipe (implicit acquire + auto-release on terminal state).
  // 'recovery' and 'initial-import' keep the explicit lease requirement.
  const PIPE_COMMANDS = new Set(['payment-prepare', 'payment-sync', 'payment-clear', 'payment-review',
    'adjustment-prepare', 'adjustment-sync', 'adjustment-clear', 'zero-complete', 'manual-complete',
    'order-revise', 'legacy-confirm', 'physical-sync']);
  const EXPLICIT_LEASE_COMMANDS = new Set(['recovery', 'initial-import']);
  async function command(input, who) {
    return serialized(async () => {
      const PROF = process.env.BUBBLE_PROFILE === '1';
      let pt = PROF ? Date.now() : 0;
      const mark = (label) => { if (PROF) { const t2 = Date.now(); console.log(`[prof] ${label}: ${t2 - pt}ms`); pt = t2; } };
      who = actor(who);
      if (!object(input) || typeof input.type !== 'string' || !object(input.payload || {}) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail('INVALID_INPUT', '账本操作不正确', 400);
      const requestId = id(input.requestId, '请求编号'), payload = input.payload || {}, hash = fingerprint({ type: input.type, payload }), prior = await previousCommand(who, requestId);
      const sectionKey = COMMAND_SECTION[input.type];
      if (sectionKey) section(who, sectionKey);
      const piped = PIPE_COMMANDS.has(input.type);
      if (piped) await ensurePipe(who, { allowRecovery: true });
      else if (EXPLICIT_LEASE_COMMANDS.has(input.type)) await assertLease(who, { allowRecovery: true });
      mark('pipe/lease');
      if (prior && prior.fingerprint !== hash) fail('REQUEST_CONFLICT', '同一请求编号不能更改内容');
      if (prior && JSON.parse(prior.result).status === 'failed') { const issue = JSON.parse(prior.result).extra.error; fail(issue.code, issue.message); }
      if (prior && JSON.parse(prior.result).status === 'done') { await flushAcks(); if (piped) await releasePipeIfClean(who); return { ...(await snapshot(who, { orderLimit: 30 })), extra: JSON.parse(prior.result).extra }; }
      // Reconciliation and preparation commands re-validate their payload
      // against the freshly read ledger (draft() re-prices from server state
      // and rejects mismatched totals; syncRecord verifies payment truth), so
      // the client's expectedRevision is meaningless for them and only blocks
      // real work whenever another till bumped the revision mid-flight.
      const revisionFreeTypes = new Set(['payment-prepare', 'adjustment-prepare',
        'payment-sync','payment-clear','payment-review','adjustment-sync','adjustment-clear','physical-sync','recovery']);
      let row = await read(); if (!prior && !revisionFreeTypes.has(input.type) && row.revision !== input.expectedRevision) fail('REVISION_CONFLICT', '账本已更新，请刷新后重试');
      const op = { who, requestId, hash }, lib = await logic; let next = row.ledger, extra = {};
      let orderPaid = null;
      const recoveryTypes = revisionFreeTypes;
      if (!recoveryTypes.has(input.type) && !(prior && ['zero-complete','initial-import'].includes(input.type))) {
        if (piped) await requireNoPending(who, ['payment-prepare','zero-complete'].includes(input.type));
        else await requireClearState(who, { row });
      }
      mark('clear-state');
      switch (input.type) {
        case 'product-save': { const p = product(payload.product); next.products = uniqueProducts(next.products.some(old => old.id === p.id) ? next.products.map(old => old.id === p.id ? p : old) : [p, ...next.products]); break; }
        case 'product-delete': { const key = id(payload.id); if ((await awards()).some(row => JSON.parse(row.line).id === key)) fail('AWARD_RESERVED', '商品存在领奖占用，请先完成或释放'); next.products = next.products.filter(p => p.id !== key); next.promoRules = next.promoRules.filter(r => !r.mainProductIds.includes(key) && !r.gifts.some(g => g.productId === key)); break; }
        case 'products-import': {
          if (!Array.isArray(payload.products) || !payload.products.length || payload.products.length > 20000) fail('INVALID_INPUT', '导入商品列表不正确', 400);
          next.products = [...next.products]; for (const entry of payload.products) { const p = product(entry); const index = next.products.findIndex(old => old.id === p.id || p.barcode && old.barcode === p.barcode || !p.barcode && old.sku === p.sku); if (index < 0) next.products.unshift(p); else next.products[index] = { ...p, id: next.products[index].id }; } uniqueProducts(next.products); break;
        }
        case 'settings-save': { if (Object.hasOwn(payload, 'paymentQr')) next.paymentQr = image(payload.paymentQr, '收款码', true); if (Object.hasOwn(payload, 'promoRules')) next.promoRules = promoRules(payload.promoRules, next.products); break; }
        case 'hold': { const b = payload.basket; if (!object(b)) fail('INVALID_INPUT', '挂单不正确', 400); if (b.giftChoiceQueue?.length) fail('GIFT_CHOICE_REQUIRED', '请完成赠品选择后再挂单'); const basket = { id: id(b.id), name: text(b.name || b.label || '挂单', '挂单名称', 100), createdAt: new Date(now()).toISOString(), ownerId: who.userId, items: await canonicalItems(b.items, next, { awards: false }) }; if (next.heldCarts.some(x => x.id === basket.id)) fail('DUPLICATE_ORDER', '挂单编号已存在'); next = lib.suspendBasket(next, basket); break; }
        case 'retrieve': { if (payload.currentBasket?.giftChoiceQueue?.length) fail('GIFT_CHOICE_REQUIRED', '请完成当前赠品选择后再取单'); const heldKey = id(payload.id); const held = next.heldCarts.find(cart => cart.id === heldKey); if (held && who.role !== 'admin' && held.ownerId !== who.userId) fail('FORBIDDEN', '只能取出自己的挂单', 403); const currentBasket = payload.currentBasket?.items?.length ? { id: id(payload.currentBasket.id), name: text(payload.currentBasket.name || '挂单', '挂单名称', 100), createdAt: new Date(now()).toISOString(), ownerId: who.userId, items: await canonicalItems(payload.currentBasket.items, next, { awards: false }) } : null; const result = lib.retrieveBasket(next, heldKey, currentBasket); result.basket.items = await canonicalItems(result.basket.items, next, { awards: false }); next = result.ledger; extra.basket = result.basket; break; }
        case 'held-delete': { const heldKey = id(payload.id); const held = next.heldCarts.find(cart => cart.id === heldKey); if (held && who.role !== 'admin' && held.ownerId !== who.userId) fail('FORBIDDEN', '只能删除自己的挂单', 403); next.heldCarts = next.heldCarts.filter(b => b.id !== heldKey); break; }
        case 'manual-complete': { if (!['扫码收款','0元出库','零元结算'].includes(payload.draft?.method)) fail('INVALID_INPUT', '不可手工确认收钱吧或其他资金记录', 400); const prepared = await draft(payload.draft, next, payload.draft.method); if (prepared.items.some(p => p.externalCoupon)) fail('INVALID_INPUT', '中奖券必须走专用核销', 400); if (prepared.method === '零元结算' && prepared.total !== 0) fail('INVALID_INPUT', '零元订单金额必须为零', 400); next = lib.completeOrder(next, { ...prepared, operatorId: who.userId }, new Date(now()).toISOString()); orderPaid = next.orders.find(o => o.id === prepared.id); break; }
        case 'order-revise': { const original = next.orders.find(o => o.id === payload.id); if (!original) fail('ORDER_MISSING', '原订单不存在'); const items = payload.cancel === true ? [] : await canonicalItems(payload.items, { ...next, products: lib.reconcileStock(next.products, original.items, []) }, { zero: original.method === '0元出库', awards: false }); next = lib.reviseOrder(next, payload.id, items, payload.cancel === true, new Date(now()).toISOString()); break; }
        case 'legacy-confirm': { admin(who); const original = next.orders.find(o => o.id === payload.id); if (!original || original.status !== '待收款' || original.payment?.provider === 'sqb' || original.items.some(p => p.externalCoupon)) fail('INVALID_INPUT', '这笔订单不能手工确认', 400); next.orders = next.orders.map(o => o.id === original.id ? { ...o, status: '已收款', paidAt: new Date(now()).toISOString(), operatorId: who.userId } : o); break; }
        case 'payment-prepare': { const prepared = await draft(payload.draft, next, '收钱吧'); if (prepared.total <= 0 || next.orders.some(o => o.id === prepared.id)) fail('INVALID_INPUT', '订单金额或编号不可发起支付', 400); next.pendingPayment = { draft: prepared, started: true, ownerId: who.userId, operatorId: who.userId }; break; }
        case 'payment-sync': case 'adjustment-sync': await syncRecord(id(payload.id), who, false, op); if (piped) await releasePipeIfClean(who); return snapshot(who, { orderLimit: 30 });
        case 'payment-clear': case 'adjustment-clear': await syncRecord(id(payload.id), who, true, op); if (piped) await releasePipeIfClean(who); return snapshot(who, { orderLimit: 30 });
        case 'payment-review': { const record = await trustedRecord(id(payload.id), true); if (record?.state !== 'paid' || next.pendingPayment?.draft.id !== record.id) fail('TRANSACTION_MISMATCH', '待核对付款不一致'); next.pendingPayment = { ...next.pendingPayment, record, review: { dismissed: payload.dismissed === true, message: '收款已确认，订单尚待云端入账；核对完成前不能继续收银。' } }; break; }
        case 'adjustment-prepare': { const validated = await adjustmentInput(payload, next), preview = await service.dispatch('preview-adjustment', { parentId: validated.original.id, request: validated.request }); if (!samePlan(preview.plan, validated.plan)) fail('TRANSACTION_MISMATCH', '支付日志与云端退换货计划不一致'); next.pendingAdjustment = { id: validated.request.id, parentId: validated.original.id, request: validated.request, preview, ownerId: who.userId, operatorId: who.userId }; break; }
        case 'physical-sync': { const key = id(payload.orderId), status = await service.dispatch('coupon-fulfilment', { orderId: key }); if (status?.redeemed) next.orders = next.orders.map(o => o.id === key ? { ...o, physicalFulfilled: true } : o); break; }
        case 'zero-complete': await zeroComplete(payload, who, op); if (piped) await releasePipeIfClean(who); return snapshot(who, { orderLimit: 30 });
        case 'initial-import': await initialImport(payload, who, op); return snapshot(who);
        case 'recovery': await recovery(who); row = await read(); next = row.ledger; break;
        default: fail('INVALID_COMMAND', '不支持此账本操作', 400);
      }
      await commit(next, row.revision, op, extra); await flushAcks();
      mark('commit');
      if (orderPaid) await notifyOrderPrizes(orderPaid, who);
      if (piped) await releasePipeIfClean(who);
      // Respond from the in-memory post-commit state when no other writer
      // bumped the revision in the meantime (one cheap integer read instead
      // of re-downloading and re-parsing the multi-MB ledger row).
      let freshRow = null;
      const [revCheck] = await pool.query('SELECT revision FROM pos_ledger WHERE ns = ? AND id = 1', [ns]);
      if (revCheck.length && revCheck[0].revision === row.revision + 1) freshRow = { revision: row.revision + 1, ledger: next };
      const respond = { ...(await snapshot(who, { orderLimit: 30, freshRow })), extra };
      mark('snapshot');
      return respond;
    });
  }
  async function paymentDispatch(action, payload = {}, who) {
    return serialized(async () => {
      who = actor(who); await ensurePipe(who, { allowRecovery: ['query','pending','acknowledge','claim-payment-notification','resolve-missing-payment','coupon-sync','coupon-release','coupon-reserve','coupon-fulfilment','coupon-zero-ack','activity-prize-check','maintenance-scan','maintenance-remove-order','maintenance-release-award'].includes(action) || action === 'start' || action === 'start-adjustment' });
      const row = await read(), current = row.ledger;
      if (action === 'start') {
        if ((await lease())?.recoveryRequired) fail('RECOVERY_REQUIRED', '接管后须先查单恢复，不能重新发起收款');
        const task = current.pendingPayment;
        if (!task || payload.draft?.id !== task.draft.id) fail('PAYMENT_NOT_PREPARED', '请先在云端校验并预留订单');
        return service.dispatch('start', { draft: clone(task.draft), code: payload.code, confirmTestPayment: payload.confirmTestPayment === true });
      }
      if (action === 'start-adjustment') {
        if ((await lease())?.recoveryRequired) fail('RECOVERY_REQUIRED', '接管后须先查单恢复，不能重新发起退换货');
        const task = current.pendingAdjustment;
        if (!task || payload.request?.id !== task.id || payload.parentId !== task.parentId) fail('ADJUSTMENT_NOT_PREPARED', '请先在云端校验并预留退换货');
        return service.dispatch('start-adjustment', { parentId: task.parentId, request: clone(task.request), digest: task.preview.digest, confirm: payload.confirm === true, confirmTestPayment: payload.confirmTestPayment === true, code: payload.code });
      }
      if (action === 'preview-adjustment') { const validated = await adjustmentInput(payload, current); return service.dispatch(action, { parentId: validated.original.id, request: validated.request }); }
      if (action === 'acknowledge') {
        const key = id(payload.id), record = await trustedRecord(key);
        if (!record) fail('TRANSACTION_MISMATCH', '支付记录不存在');
        const saved = record.kind ? current.orders.some(o => o.afterSales?.some(a => a.id === key && a.orderSn === (record.orderSn || ''))) : current.orders.some(o => o.id === key && o.payment?.orderSn === record.orderSn);
        if (!saved && !(record.state === 'failed' && current.pendingPayment?.draft.id !== key && current.pendingAdjustment?.id !== key)) fail('LEDGER_NOT_COMMITTED', '云端账本尚未保存，不能结束资金记录');
        return service.dispatch(action, { id: key });
      }
      if (action === 'coupon-reserve') {
        if ((await lease())?.recoveryRequired) fail('RECOVERY_REQUIRED', '接管后请先恢复原扫码占用');
        return reserveCoupon(payload, who);
      }
      if (action === 'activity-prize-check') {
        // Till-side prize scan; the service applies the same unresolved-payment
        // guard as coupon-reserve before the stateless activity lookup.
        if ((await lease())?.recoveryRequired) fail('RECOVERY_REQUIRED', '接管后请先恢复，再扫描领奖码');
        return service.dispatch('activity-prize-check', { code: text(payload.code ?? '', '领奖码', 200, false) });
      }
      if (action === 'coupon-release') { if (pending(current) || (await outbox()).length) fail('RECOVERY_REQUIRED', '请先完成未决收退款或零元核销'); const key = id(payload.id), result = await service.dispatch(action, { id: key }); await pool.query('DELETE FROM pos_awards WHERE ns = ? AND id = ?', [ns, key]); return result; }
      if (action === 'coupon-zero') fail('USE_LEDGER_COMMAND', '请通过云端零元核销命令提交订单', 400);
      if (action === 'coupon-zero-ack') { const key = id(payload.id); if (!current.orders.some(o => o.id === key && o.items.some(i => i.externalCoupon) && o.total === 0)) fail('LEDGER_NOT_COMMITTED', '零元订单未入账，不能确认核销'); return service.dispatch(action, { id: key }); }
      if (action === 'coupon-bind-physical-products') { admin(who); return service.dispatch(action, { ...payload, products: clone(current.products) }); }
      if (action === 'maintenance-scan') { admin(who); return maintenanceScan(); }
      if (action === 'maintenance-remove-order') { admin(who); return maintenanceRemoveOrder(id(payload.id), who); }
      if (action === 'maintenance-release-award') { admin(who); return maintenanceReleaseAward(id(payload.id)); }
      if (action === 'export-backup') { admin(who); return service.dispatch(action, { business: { type: 'stall-cashier-backup', version: 3, exportedAt: new Date(now()).toISOString(), products: current.products, orders: current.orders, heldCarts: current.heldCarts, paymentQr: current.paymentQr, promoRules: current.promoRules } }); }
      if (['query','pending','claim-payment-notification','resolve-missing-payment','coupon-sync','coupon-fulfilment'].includes(action)) {
        if (action === 'pending') return service.dispatch(action, {});
        if (action === 'coupon-sync') return syncAwards();
        const key = id(payload.id || payload.orderId);
        if (!current.orders.some(o => o.id === key || o.afterSales?.some(a => a.id === key)) && current.pendingPayment?.draft.id !== key && current.pendingAdjustment?.id !== key && current.pendingZero?.draft.id !== key) fail('TRANSACTION_MISMATCH', '不能操作其他交易记录');
        return service.dispatch(action, action === 'coupon-fulfilment' ? { orderId: key } : { id: key, ...(action === 'resolve-missing-payment' ? { confirmNotCharged: payload.confirmNotCharged === true } : {}) });
      }
      fail('INVALID_ACTION', '此支付操作没有云端账本授权', 400);
    });
  }
  // Orphan sweep: a checkout can die after `start` reached 收钱吧 (timeout,
  // closed modal, dead tab). The payment record survives on disk with the
  // customer potentially paying after we stopped polling — that money must
  // land in the ledger, not vanish. Every couple of minutes, re-query
  // unowned, un-acknowledged records against SQB and commit any that paid.
  let sweepingOrphans = false;
  async function sweepOrphans() {
    if (sweepingOrphans || closed) return false;
    sweepingOrphans = true;
    const systemWho = { userId: 'system', sessionId: 'orphan-sweep', role: 'admin', displayName: '系统自动核对' };
    try {
      const records = (service.readOnlineState?.().records || []).filter((entry) => entry && !entry.acknowledged);
      if (!records.length) return false;
      const owned = async (id) => {
        const row = await read();
        return row.ledger.pendingPayment?.draft.id === id || row.ledger.pendingAdjustment?.id === id;
      };
      // Pass 1: refresh still-unresolved orphans against SQB so a late
      // customer payment flips the record to paid.
      for (const record of records) {
        if (['failed', 'not-started', 'refunded', 'paid'].includes(record.state)) continue;
        if (await owned(record.id)) continue; // a live checkout polls it itself
        try { await service.dispatch('query', { id: record.id }); } catch { /* SQB unreachable; retry next round */ }
      }
      // Pass 2: commit any paid record that no live checkout owns.
      const fresh = (service.readOnlineState?.().records || []).filter((entry) => entry && entry.state === 'paid' && !entry.acknowledged);
      for (const record of fresh) {
        if (await owned(record.id)) continue;
        // settle coupons first (service.query settles on terminal records)
        await service.dispatch('query', { id: record.id }).catch(() => null);
        await serialized(() => syncRecord(record.id, systemWho, false, null));
      }
      return true;
    } catch (error) { console.error('[orphan-sweep]', error?.message || error); return false; }
    finally { sweepingOrphans = false; }
  }
  const orphanTimer = setInterval(() => { sweepOrphans().catch(() => {}); }, 120000);
  const orphanBootTimer = setTimeout(() => { sweepOrphans().catch(() => {}); }, 20000);
  orphanTimer.unref?.(); orphanBootTimer.unref?.();
  return { snapshot, acquireLease, releaseLease, forceReleaseLease, assertLease, command, paymentDispatch, sweepOrphans, close: () => { closed = true; clearInterval(orphanTimer); clearTimeout(orphanBootTimer); } };
}
module.exports = { createOnlineLedger };
