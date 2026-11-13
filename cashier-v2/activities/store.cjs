'use strict';
// In-process marketing activities (folded-in lottery-v2). Public participant
// flow (session/state/draw/identity + staff lookup/redeem) keeps lottery-v2's
// response shapes so the H5 only needs a base-URL change; admin CRUD/records/
// redeem/export ride the cashier session dispatcher. Prizes are pool-based:
// cash prizes reference coupon-center campaigns and physical prizes reference
// gift products from the ledger product pool; terms are snapshotted at save
// time. Cash-prize draws insert the entry and mint the pinned coupon in ONE
// transaction via the coupon store's optional connection (both sides roll back
// together on any failure).
const crypto = require('node:crypto');
const { withTransaction } = require('../online/mysql.cjs');
const { problem } = require('../coupons/store.cjs');
const { validateActivityConfig, validateWx, validateStaffKey, validateState } = require('./config.cjs');

const SESSION_TTL = 24 * 60 * 60 * 1000;
// Booth-issued invite codes live briefly: long enough to hand a participant the
// phone, short enough that leaked codes die quickly.
const GRANT_TTL = 10 * 60 * 1000;
const CODE_PATTERN = /^[0-9A-F]{16}$/;
const INVITE_PATTERN = /^[0-9A-F]{16}$/;
// The persisted "no prize" outcome uses this sentinel prize id; its code never
// matches CODE_PATTERN, so it can never be looked up or redeemed.
const NO_PRIZE = 'none';
const CONFIG_KEYS = ['name', 'title', 'venue', 'cashTerms', 'rulesText', 'startsAt', 'endsAt', 'redeemEndsAt', 'prizes', 'requireInvite'];

const parseData = value => typeof value === 'string' ? JSON.parse(value) : value;
const iso = ms => new Date(ms).toISOString();

// Ported from lottery-v2/src/auth.js.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}
const isStaffKey = (presented, expected) => typeof expected === 'string' && expected.length > 0 &&
  typeof presented === 'string' && presented.length > 0 && safeEqual(presented, expected);
function maskOpenid(openid) {
  const s = String(openid || '');
  if (s.length <= 8) return s.slice(0, 2) + '…';
  return s.slice(0, 4) + '…' + s.slice(-4);
}

// Ported from lottery-v2/src/wechat.js: without a secret the activity runs in
// mock mode (each distinct code maps to a stable distinct local user).
async function defaultCode2session(code, { appid, secret, fetchImpl = fetch } = {}) {
  if (!secret) {
    return { openid: 'mock_' + crypto.createHash('sha256').update(String(code)).digest('hex').slice(0, 16) };
  }
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.searchParams.set('appid', appid);
  url.searchParams.set('secret', secret);
  url.searchParams.set('js_code', code);
  url.searchParams.set('grant_type', 'authorization_code');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let data;
  try {
    const response = await fetchImpl(url, { redirect: 'error', signal: controller.signal });
    data = await response.json();
  } catch {
    throw problem('WX_LOGIN_FAILED', '微信登录暂不可用，请稍后重试', 502);
  } finally {
    clearTimeout(timeout);
  }
  // The response may carry session_key; never log it, only forward the openid.
  if (!data || typeof data.openid !== 'string' || !data.openid) {
    throw problem('WX_LOGIN_FAILED', '微信登录失败，请返回小程序重新进入', 502);
  }
  return { openid: data.openid };
}

function weightedPick(candidates, randomUnit) {
  const total = candidates.reduce((sum, c) => sum + c.probability, 0);
  let ticket = randomUnit() * total;
  for (const c of candidates) {
    if (ticket < c.probability) return c;
    ticket -= c.probability;
  }
  return candidates[candidates.length - 1];
}

const makeCode = () => crypto.randomBytes(8).toString('hex').toUpperCase();
// Uniform double in [0,1) from 48 random bits.
const defaultRandomUnit = () => crypto.randomBytes(6).readUIntBE(0, 6) / 2 ** 48;

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function createActivityStore({ pool, ns = '', couponStore, protect = value => value, unprotect = value => value,
  code2session = defaultCode2session, now = () => Date.now(), randomUnit = defaultRandomUnit, fetchFn = fetch } = {}) {
  if (!pool || typeof pool.getConnection !== 'function') throw problem('INVALID_STORE', '需要活动数据库连接池', 500);
  if (!couponStore || typeof couponStore.dispatch !== 'function') throw problem('INVALID_STORE', '需要券中心存储实例', 500);

  async function load(id, q = pool) {
    const [rows] = await q.query('SELECT * FROM pos_activities WHERE ns = ? AND id = ?', [ns, id]);
    return rows[0] || null;
  }
  function assertId(id) {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw problem('INVALID_INPUT', '活动编号不正确');
    return id;
  }
  const inventory = config => ({
    total: config.prizes.filter(p => p.kind !== 'none').reduce((sum, p) => sum + p.qty, 0),
    remaining: config.prizes.filter(p => p.kind !== 'none').reduce((sum, p) => sum + (p.remaining || 0), 0),
  });
  const publicPrize = prize => {
    if (!prize) return null;
    const { qty, remaining, couponCampaignId, product, ...rest } = prize;
    return rest;
  };
  const isNoPrize = data => !data || !data.prizeId || data.prizeId === NO_PRIZE;

  function publicEntry(row, config, nowMs) {
    if (!row) return null;
    const data = parseData(row.data);
    if (isNoPrize(data)) {
      return {
        prize: { id: 'none', name: '奖品已发完', shortName: '奖品已发完', kind: 'physical', label: '', icon: '' },
        code: '', createdAt: data?.createdAt ?? null, status: 'unavailable', outcome: 'lost', fulfillment: '', checkoutCoupon: false,
        expiresAt: config.redeemEndsAt, minimumGoodsAmountCents: null, redeemedAt: null,
      };
    }
    const prize = data.prize;
    const checkoutCoupon = !!prize?.checkoutCoupon;
    const status = data.status === 'redeemed' ? 'redeemed'
      : (config.redeemEndsAt && nowMs >= config.redeemEndsAt ? 'expired' : 'pending');
    return {
      prize, code: row.code, createdAt: data.createdAt, status,
      outcome: 'won', fulfillment: checkoutCoupon ? 'cashier' : 'staff',
      checkoutCoupon, expiresAt: config.redeemEndsAt,
      minimumGoodsAmountCents: checkoutCoupon ? (prize.minimumCents ?? 0) : null,
      redeemedAt: data.redeemedAt || null,
    };
  }

  // State gate + time window. Paused/ended answer 410 (participation is over);
  // session/state/identity stay available so winners can still reach their codes.
  function drawError(state, config, remaining, nowMs) {
    if (state === 'paused') return { code: 'PAUSED', message: '活动暂未开放，请留意现场通知', status: 410 };
    if (state === 'ended') return { code: 'ENDED', message: '抽奖已结束，已中奖礼品仍可在有效期内领取', status: 410 };
    if (nowMs < config.startsAt) return { code: 'NOT_STARTED', message: '活动尚未开始', status: 400 };
    if (nowMs >= config.endsAt) return { code: 'ENDED', message: '抽奖已结束，已中奖礼品仍可在有效期内领取', status: 410 };
    if (remaining <= 0) return { code: 'SOLD_OUT', message: '本次活动名额已发完，已中奖奖品仍可在有效期内使用', status: 400 };
    return null;
  }

  function issueToken(id, openid, nowMs) {
    const expiresAt = nowMs + SESSION_TTL;
    const token = protect(JSON.stringify({ v: 1, a: id, o: openid, e: expiresAt, n: crypto.randomBytes(8).toString('hex') }));
    return { token, expiresAt };
  }
  function readToken(id, token, nowMs) {
    let payload;
    try { payload = JSON.parse(unprotect(String(token || ''))); } catch { return null; }
    if (!payload || payload.v !== 1 || payload.a !== id || typeof payload.o !== 'string' || !payload.o) return null;
    if (!Number.isSafeInteger(payload.e) || payload.e <= nowMs) return null;
    return payload.o;
  }

  async function session(id, code) {
    const row = await load(id);
    if (!row || row.type !== 'lottery' || row.state === 'draft') throw problem('NOT_FOUND', '活动不存在或未发布', 404);
    const config = parseData(row.data);
    const wx = { appid: config.wx?.appid || '', secret: config.wx?.secretProtected ? unprotect(config.wx.secretProtected) : '', fetchImpl: fetchFn };
    const { openid } = await code2session(code, wx);
    if (typeof openid !== 'string' || !openid || openid.length > 200) throw problem('WX_LOGIN_FAILED', '微信登录失败，请返回小程序重新进入', 502);
    return issueToken(id, openid, now());
  }

  async function getState(row, openid, nowMs) {
    const config = parseData(row.data);
    const [rows] = await pool.query('SELECT * FROM pos_activity_entries WHERE ns = ? AND activity = ? AND owner = ?', [ns, row.id, openid]);
    const { total, remaining } = inventory(config);
    const error = drawError(row.state, config, remaining, nowMs);
    const entry = rows[0] || null;
    // Display-only overall win chance: the real prizes' weight share of the
    // total wheel weight (thanks cells are kind 'none' and carry weight too).
    const winBps = (() => {
      const weighted = config.prizes.filter(p => p.probability > 0);
      const totalWeight = weighted.reduce((sum, p) => sum + p.probability, 0);
      if (!totalWeight) return 0;
      const winWeight = weighted.filter(p => p.kind !== 'none').reduce((sum, p) => sum + p.probability, 0);
      return Math.round(Math.min(1, winWeight / totalWeight) * 10000);
    })();
    return {
      campaign: {
        id: row.id, title: config.title, name: config.name, venue: config.venue,
        enabled: row.state === 'active', startsAt: config.startsAt, endsAt: config.endsAt,
        redeemEndsAt: config.redeemEndsAt, cashTerms: config.cashTerms, rulesText: config.rulesText,
        winProbabilityBps: winBps,
        inventory: { version: 1, total },
      },
      prizes: config.prizes.map(p => ({ ...publicPrize(p), quantity: p.qty })),
      // The single prize the H5 hero/wheel advertises: the first real prize.
      prize: publicPrize(config.prizes.find(p => p.kind !== 'none')) || null,
      inventory: { total, remaining },
      drawError: entry ? null : (error ? error.message : null),
      drawsRemaining: entry || error ? 0 : 1,
      availability: { canDraw: !entry && !error, reason: entry ? 'ALREADY_DRAWN' : (error ? error.code : 'READY') },
      entry: publicEntry(entry, config, nowMs),
    };
  }

  // One draw per participant per activity. The activity row lock (FOR UPDATE)
  // serializes draws, so the repeat-draw re-read, the stock decrement and the
  // entry insert are race-free; a cash prize additionally mints its coupon on
  // the same connection, so entry and coupon commit or roll back together.
  // Gated activities (requireInvite) additionally burn a booth-issued one-time
  // invite code inside the same transaction — a code is spent exactly when the
  // draw attempt is recorded, and a rollback returns it to the pool.
  async function draw(id, openid, payload = {}, nowMs) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [rows] = await conn.query('SELECT * FROM pos_activities WHERE ns = ? AND id = ? FOR UPDATE', [ns, id]);
        const row = rows[0];
        if (!row || row.type !== 'lottery' || row.state === 'draft') throw problem('NOT_FOUND', '活动不存在或未发布', 404);
        const config = parseData(row.data);
        const [existing] = await conn.query('SELECT * FROM pos_activity_entries WHERE ns = ? AND activity = ? AND owner = ?', [ns, id, openid]);
        if (existing.length) {
          const entry = existing[0];
          await conn.commit();
          return publicEntry(entry, config, nowMs);
        }
        if (config.requireInvite) {
          const inviteCode = normalizeCode(payload.inviteCode ?? '');
          if (!INVITE_PATTERN.test(inviteCode)) throw problem('INVALID_INVITE', '请输入工作人员提供的完整参与码', 400);
          const [invites] = await conn.query('SELECT * FROM pos_activity_invites WHERE ns = ? AND activity = ? AND code = ? FOR UPDATE', [ns, id, inviteCode]);
          const invite = invites[0];
          if (!invite) throw problem('INVALID_INVITE', '参与码不正确，请核对后重新输入', 400);
          const inviteData = parseData(invite.data);
          if (inviteData.status === 'used') throw problem('INVITE_USED', '该参与码已被使用，请向工作人员索取新的参与码', 409);
          if (!Number.isSafeInteger(inviteData.expiresAt) || nowMs >= inviteData.expiresAt) {
            throw problem('INVITE_EXPIRED', '参与码已过期，请工作人员重新生成', 410);
          }
          await conn.query('UPDATE pos_activity_invites SET data = ? WHERE ns = ? AND activity = ? AND code = ?',
            [JSON.stringify({ ...inviteData, status: 'used', usedBy: openid }), ns, id, inviteCode]);
        }
        const { remaining } = inventory(config);
        const blocked = drawError(row.state, config, remaining, nowMs);
        if (blocked && blocked.code !== 'SOLD_OUT') throw problem(blocked.code, blocked.message, blocked.status);

        let picked = null;
        if (!blocked) {
          // A cash prize whose campaign is exhausted outside this activity (a
          // shared coupon pool) must not be picked — the mint would fail
          // SOLD_OUT mid-draw. issue() below stays as the final atomic guard.
          let campaignStock = null;
          const cashAvailable = async prize => {
            if (!campaignStock) {
              const list = await couponStore.dispatch({ id: `activity-draw:${id}`, role: 'admin' }, 'campaigns', {}, conn);
              campaignStock = new Map(list.map(c => [c.id, c]));
            }
            const campaign = campaignStock.get(prize.couponCampaignId);
            return !!campaign && campaign.issued < campaign.quota;
          };
          const candidates = [];
          for (const prize of config.prizes) {
            if (!(prize.probability > 0)) continue;
            // Thanks cells (kind 'none') never run out; real prizes need stock.
            if (prize.kind !== 'none' && !(prize.remaining > 0)) continue;
            if (prize.kind === 'cash' && prize.couponCampaignId && !(await cashAvailable(prize))) continue;
            candidates.push(prize);
          }
          if (candidates.length) picked = weightedPick(candidates, randomUnit);
          // Landing on a thanks cell is a no-prize outcome, same as empty stock.
          if (picked?.kind === 'none') picked = null;
        }
        if (picked) picked.remaining -= 1;

        let entryRow = null;
        for (let i = 0; i < 5 && !entryRow; i++) {
          const code = picked ? makeCode() : ('NONE' + crypto.randomBytes(10).toString('hex').toUpperCase());
          const data = {
            prizeId: picked ? picked.id : NO_PRIZE,
            prize: picked ? { ...publicPrize(picked), checkoutCoupon: picked.kind === 'cash' && !!picked.couponCampaignId && picked.amount > 0 } : null,
            status: picked ? 'pending' : 'unavailable',
            createdAt: nowMs, redeemedAt: null, redeemedBy: '',
          };
          try {
            await conn.query('INSERT INTO pos_activity_entries (ns, activity, code, owner, data) VALUES (?,?,?,?,?)', [ns, id, code, openid, JSON.stringify(data)]);
            entryRow = { activity: id, code, owner: openid, data };
          } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') continue;
            throw error;
          }
        }
        if (!entryRow) throw problem('RETRY', '系统繁忙，请重试', 503);

        if (picked && entryRow.data.prize.checkoutCoupon) {
          const campaignId = picked.couponCampaignId;
          const requestId = 'award:' + crypto.createHash('sha256').update(JSON.stringify([campaignId, openid, entryRow.code])).digest('hex');
          await couponStore.dispatch({ id: `activity:${id}`, role: 'lottery', campaignId }, 'issue',
            { requestId, campaignId, owner: openid, awardId: entryRow.code, trustedCode: entryRow.code }, conn);
        }

        if (picked) {
          await conn.query('UPDATE pos_activities SET data = ?, updated_at = ? WHERE ns = ? AND id = ?', [JSON.stringify(config), iso(now()), ns, id]);
        }
        await conn.commit();
        return publicEntry(entryRow, config, nowMs);
      } catch (error) {
        await conn.rollback().catch(() => {});
        if (error.code === 'ER_LOCK_DEADLOCK' && attempt < 3) continue;
        throw error;
      } finally {
        conn.release();
      }
    }
    throw problem('RETRY', '系统繁忙，请重试', 503);
  }

  const normalizeCode = value => String(value ?? '').replace(/\s+/g, '').toUpperCase();

  async function findEntry({ id, code }, q = pool) {
    if (!CODE_PATTERN.test(code)) throw problem('INVALID_CODE', '核销码格式不正确，请核对后重试');
    const [rows] = id
      ? await q.query('SELECT * FROM pos_activity_entries WHERE ns = ? AND activity = ? AND code = ?', [ns, id, code])
      : await q.query('SELECT * FROM pos_activity_entries WHERE ns = ? AND code = ?', [ns, code]);
    if (rows.length > 1) throw problem('AMBIGUOUS_CODE', '该核销码属于多个活动，请同时提供活动编号', 409);
    const entry = rows[0];
    if (!entry || isNoPrize(parseData(entry.data))) throw problem('NOT_FOUND', '未找到此活动的核销码，请核对', 404);
    return entry;
  }

  async function lookup({ id, code }, nowMs) {
    const entry = await findEntry({ id: id || null, code: normalizeCode(code) });
    const row = await load(entry.activity);
    if (!row) throw problem('NOT_FOUND', '未找到此活动的核销码，请核对', 404);
    return { ...publicEntry(entry, parseData(row.data), nowMs), winner: maskOpenid(entry.owner), activityId: row.id, activityTitle: row.title };
  }

  // POS prize scan (收银台扫码): tells the till how to handle a 16-hex win code.
  // Cash prizes answer {kind:'cash'} so the POS runs its existing coupon-reserve
  // path unchanged; pending physical prizes answer with the gift product
  // snapshot so the till can add a ¥0 cart line that redeems on payment.
  async function prizeCheck({ code }, nowMs) {
    const entry = await findEntry({ id: null, code: normalizeCode(code) });
    const row = await load(entry.activity);
    if (!row) throw problem('NOT_FOUND', '未找到此活动的核销码，请核对', 404);
    const config = parseData(row.data);
    const data = parseData(entry.data);
    if (data.prize?.checkoutCoupon) return { kind: 'cash' };
    if (data.status === 'redeemed') throw problem('ALREADY_REDEEMED', '此奖品已核销，请勿重复发放', 409);
    if (config.redeemEndsAt && nowMs >= config.redeemEndsAt) throw problem('EXPIRED', '该奖品已超过核销期限', 410);
    // Entry snapshots do not pin the product (publicPrize strips it), so the
    // gift product reference is resolved from the stored prize pool config.
    const prize = (config.prizes || []).find(p => p.id === data.prizeId);
    const product = prize?.product;
    if (!product?.id) throw problem('PRIZE_PRODUCT_MISSING', '该奖品缺少关联赠品，请在活动管理中核对', 409);
    return { kind: 'physical', entryCode: entry.code, prizeName: data.prize?.name || prize?.name || '', product: { id: product.id, name: product.name, sku: product.sku || '', barcode: product.barcode || '' } };
  }

  // Physical-prize redemption. The conditional UPDATE keeps redemption single-
  // use under concurrency; cash-prize coupons are redeemed at the cashier till
  // (coupon commit on payment), never here — otherwise a win could be spent twice.
  async function redeem({ id, code, staffId }, nowMs) {
    const normalized = normalizeCode(code);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const entry = await findEntry({ id: id || null, code: normalized }, conn);
      const row = await load(entry.activity, conn);
      if (!row) throw problem('NOT_FOUND', '未找到此活动的核销码，请核对', 404);
      const config = parseData(row.data);
      const data = parseData(entry.data);
      if (data.prize?.checkoutCoupon) throw problem('CHECKOUT_COUPON', '立减金需在收银台结算时扫码抵扣，不能在此核销', 409);
      if (data.status === 'redeemed') throw problem('ALREADY_REDEEMED', '此奖品已核销，请勿重复发放', 409);
      if (config.redeemEndsAt && nowMs >= config.redeemEndsAt) throw problem('EXPIRED', '该奖品已超过核销期限', 410);
      const [result] = await conn.query(
        `UPDATE pos_activity_entries SET data = JSON_SET(data, '$.status', 'redeemed', '$.redeemedAt', ?, '$.redeemedBy', ?)
         WHERE ns = ? AND activity = ? AND code = ? AND data->>'$.status' = 'pending'`,
        [nowMs, String(staffId || ''), ns, entry.activity, entry.code]);
      if (result.affectedRows !== 1) throw problem('ALREADY_REDEEMED', '此奖品已核销，请勿重复发放', 409);
      await conn.commit();
      const fresh = { ...entry, data: { ...data, status: 'redeemed', redeemedAt: nowMs, redeemedBy: String(staffId || '') } };
      return { ...publicEntry(fresh, config, nowMs), winner: maskOpenid(entry.owner), activityId: row.id, activityTitle: row.title };
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  // Scratch-to-redeem: the participant's own physical prize, revealed by
  // scratching the foil on the result page while staff watches. Reuses the
  // single-use conditional flip from redeem() (a scratched code can never
  // also be till-scanned), then decrements the bound gift product's ledger
  // stock so booth handouts hit inventory exactly like till redemptions.
  async function scratchRedeem(row, config, openid, nowMs) {
    const [rows] = await pool.query('SELECT * FROM pos_activity_entries WHERE ns = ? AND activity = ? AND owner = ?', [ns, row.id, openid]);
    const entry = rows[0];
    if (!entry) throw problem('NOT_FOUND', '未找到参与记录', 404);
    const data = parseData(entry.data);
    if (isNoPrize(data)) throw problem('NOT_FOUND', '本次参与未中奖，无需核销', 404);
    const redeemed = await redeem({ id: row.id, code: entry.code, staffId: 'scratch:self' }, nowMs);
    const prize = (config.prizes || []).find(p => p.id === data.prizeId);
    if (prize?.product?.id) {
      try { await decrementLedgerStock(prize.product.id); }
      catch (error) { console.error(`[activity] 刮开核销库存扣减失败 activity=${row.id} product=${prize.product.id}:`, error?.message || error); }
    }
    return redeemed;
  }

  // Guarded row-locked stock decrement on the ledger product pool. Booth
  // scratch redemptions hand out real goods without a till order, so without
  // this the gift count would drift from reality. The ledger revision is
  // intentionally not bumped: the till reads the row fresh on every command,
  // and a surprise bump would only force a pointless refresh conflict.
  async function decrementLedgerStock(productId) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query('SELECT body FROM pos_ledger WHERE ns = ? AND id = 1 FOR UPDATE', [ns]);
      const body = rows[0] && parseData(rows[0].body);
      const products = body?.products;
      if (!Array.isArray(products)) throw new Error('ledger products missing');
      const index = products.findIndex(p => p.id === productId);
      if (index < 0) throw new Error(`product ${productId} not in ledger`);
      if (Number(products[index].stock) > 0) products[index] = { ...products[index], stock: Number(products[index].stock) - 1 };
      await conn.query('UPDATE pos_ledger SET body = ? WHERE ns = ? AND id = 1', [JSON.stringify(body), ns]);
      await conn.commit();
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  // Booth grant: staff (staff key, or an admin-identified wechat session)
  // issues a one-time invite code. The H5 shows it plus a client-rendered QR;
  // draw() consumes the code inside its own transaction. Codes die after
  // GRANT_TTL whether used or not.
  async function grantInvite(id, staffId, nowMs) {
    const row = await load(id);
    if (!row || row.type !== 'lottery' || row.state === 'draft') throw problem('NOT_FOUND', '活动不存在或未发布', 404);
    const code = makeCode();
    const expiresAt = nowMs + GRANT_TTL;
    const data = { status: 'pending', createdBy: String(staffId || ''), createdAt: nowMs, expiresAt, usedBy: '' };
    await pool.query('INSERT INTO pos_activity_invites (ns, activity, code, data) VALUES (?,?,?,?)', [ns, id, code, JSON.stringify(data)]);
    return { inviteCode: code, expiresAt };
  }

  // Public /call dispatcher (lottery-v2 handleCall parity).
  async function publicCall(id, action, payload, { token, staffKey } = {}, nowMs = now()) {
    const row = await load(id);
    if (!row || row.type !== 'lottery' || row.state === 'draft') throw problem('NOT_FOUND', '活动不存在或未发布', 404);
    const config = parseData(row.data);
    const openid = token ? readToken(id, token, nowMs) : null;
    const staffOk = isStaffKey(staffKey, config.staffKey || '');

    if (action === 'state' || action === 'draw' || action === 'identity' || action === 'scratch-redeem') {
      if (!openid) throw problem('AUTH_REQUIRED', '登录已失效，请返回小程序重新进入活动', 401);
      if (action === 'state') return getState(row, openid, nowMs);
      if (action === 'draw') return draw(id, openid, payload, nowMs);
      if (action === 'scratch-redeem') return scratchRedeem(row, config, openid, nowMs);
      return { openId: openid, isAdmin: staffOk };
    }

    if (action === 'lookup' || action === 'redeem' || action === 'grant' || action === 'retry-coupon-issue') {
      if (!staffOk) {
        if (openid) throw problem('FORBIDDEN', '当前账号没有核销权限', 403);
        if (typeof staffKey === 'string' && staffKey.length > 0) throw problem('UNAUTHORIZED', '工作人员密钥不正确', 401);
        throw problem('AUTH_REQUIRED', '需要工作人员密钥或已授权的工作人员账号', 401);
      }
      if (action === 'retry-coupon-issue') {
        // Coupon minting is atomic with the draw here, so there is nothing to sweep.
        return { enabled: true, checked: 0, confirmed: 0, failed: 0, pending: 0 };
      }
      const staffId = openid ? 'wx:' + maskOpenid(openid) : 'staff-key';
      if (action === 'grant') return grantInvite(id, staffId, nowMs);
      return action === 'lookup' ? lookup({ id, code: payload.code }, nowMs) : redeem({ id, code: payload.code, staffId }, nowMs);
    }

    throw problem('INVALID_ACTION', '不支持的操作', 400);
  }

  // Prize pool resolution, replacing the old ad-hoc coupon provisioning. For
  // each cash prize the referenced coupon-center campaign must exist and be
  // enabled; its terms (name/amount/minimumCents) are COPIED into the prize
  // snapshot, and the campaign quota is raised (increase-only, audited) when
  // the remaining quota cannot cover this activity's allocation. Physical
  // prizes must reference a gift product from the ledger product pool and get
  // {id,name,sku,barcode} snapshotted, defaulting imageUrl from the product.
  // Runs on the caller's connection so it commits or rolls back with the
  // activity write.
  async function resolvePrizePools(conn, activityId, prizes, actor) {
    const adminActor = { id: `activity-admin:${actor?.userId || 'system'}`, role: 'admin' };
    const campaigns = new Map();
    let products = null;
    const campaignById = async campaignId => {
      if (!campaigns.has(campaignId)) {
        const [rows] = await conn.query('SELECT data FROM pos_coupon_campaigns WHERE ns = ? AND id = ?', [ns, campaignId]);
        const campaign = rows.length ? parseData(rows[0].data) : null;
        if (!campaign) throw problem('CAMPAIGN_MISSING', '所选优惠券不存在，请先在券中心创建');
        if (campaign.kind !== 'cash') throw problem('CAMPAIGN_KIND', '奖池只能选择现金券活动');
        if (campaign.enabled !== true) throw problem('CAMPAIGN_DISABLED', '所选优惠券已停用，请先在券中心启用');
        campaigns.set(campaignId, campaign);
      }
      return campaigns.get(campaignId);
    };
    const productById = async productId => {
      if (!products) {
        const [rows] = await conn.query('SELECT body FROM pos_ledger WHERE ns = ? AND id = 1', [ns]);
        const body = rows.length ? parseData(rows[0].body) : null;
        products = Array.isArray(body?.products) ? body.products : [];
      }
      return products.find(p => p.id === productId) || null;
    };
    for (const prize of prizes) {
      if (prize.kind === 'none') {
        // Thanks cells have no pool reference; the name is fixed server-side.
        prize.name = '谢谢惠顾';
        prize.shortName = '谢谢惠顾';
        continue;
      }
      if (prize.kind === 'cash') {
        const campaign = await campaignById(prize.couponCampaignId);
        prize.name = campaign.name;
        prize.shortName = campaign.name;
        prize.amount = campaign.amountCents / 100;
        prize.minimumCents = campaign.minimumCents ?? 0;
        const needed = campaign.issued + prize.qty;
        if (needed > campaign.quota) {
          await couponStore.dispatch(adminActor, 'increase-quota', {
            requestId: `activity-quota:${activityId}:${prize.id}:${prize.qty}`,
            id: campaign.id, quota: needed, reason: '活动名额配置',
          }, conn);
          campaign.quota = needed;
        }
      } else {
        const product = await productById(prize.product?.id);
        if (!product) throw problem('PRODUCT_MISSING', '所选赠品不存在，请先在商品管理中添加赠品');
        const promoGift = ['true', '1', 'yes', '是', '可赠送', '可参与买赠'].includes(String(product.giftEligible ?? '').trim().toLowerCase());
        if (product.productType !== 'gift' && !(product.productType === 'sale' && promoGift)) throw problem('PRODUCT_KIND', '奖品只能从赠品中选择，或选择已启用“可参与买赠”的售卖品');
        prize.name = product.name;
        prize.shortName = product.name;
        prize.product = { id: product.id, name: product.name, sku: product.sku || '', barcode: product.barcode || '' };
        if (!prize.imageUrl && product.imageUrl) prize.imageUrl = product.imageUrl;
      }
    }
  }

  function adminView(row, stats = null, opts = {}) {
    const config = parseData(row.data);
    return {
      id: row.id, type: row.type, title: row.title, name: config.name, state: row.state,
      venue: config.venue, startsAt: config.startsAt, endsAt: config.endsAt, redeemEndsAt: config.redeemEndsAt,
      cashTerms: config.cashTerms, rulesText: config.rulesText,
      prizes: config.prizes.map(p => ({
        ...publicPrize(p), quantity: p.qty, remaining: p.remaining || 0,
        ...(p.couponCampaignId ? { couponCampaignId: p.couponCampaignId } : {}),
        ...(p.product ? { product: p.product } : {}),
      })),
      wx: { appid: config.wx?.appid || '', secretSet: !!config.wx?.secretProtected },
      staffKeySet: !!config.staffKey,
      requireInvite: !!config.requireInvite,
      // The raw key is admin-only: cashiers get staffKeySet (boolean) only.
      ...(opts.revealStaffKey ? { staffKey: config.staffKey || '' } : {}),
      inventory: inventory(config),
      stats: { entries: Number(stats?.entries || 0), pending: Number(stats?.pending || 0), redeemed: Number(stats?.redeemed || 0) },
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  async function createActivity(input, actor) {
    if (input?.type !== undefined && input.type !== 'lottery') throw problem('INVALID_INPUT', '活动类型不正确');
    const config = validateActivityConfig(input?.config || {});
    const wx = validateWx(input?.config?.wx);
    const staffKey = validateStaffKey(input?.config?.staffKey);
    const state = input?.state === undefined ? 'draft' : validateState(input.state);
    if (!['draft', 'active'].includes(state)) throw problem('INVALID_STATE', '新活动只能创建为草稿或进行中');
    const id = crypto.randomUUID();
    const nowIso = iso(now());
    const prizes = config.prizes.map(p => ({ ...p, remaining: p.qty }));
    await withTransaction(pool, async conn => {
      await resolvePrizePools(conn, id, prizes, actor);
      const data = { ...config, prizes, wx: { appid: wx.appid, secretProtected: wx.secret ? protect(wx.secret) : '' }, staffKey };
      await conn.query('INSERT INTO pos_activities (ns, id, type, title, state, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [ns, id, 'lottery', config.title, state, JSON.stringify(data), nowIso, nowIso]);
    });
    return adminView(await load(id), null, { revealStaffKey: true });
  }

  // Partial config patch over the stored config (same key allowlist as
  // lottery-v2's admin config endpoint). Prize stock reconciles like
  // syncCampaign: a raised qty tops up remaining by the difference, a lowered
  // qty clamps remaining, awarded stock is never reclaimed. Dates are freely
  // editable again: prizes only REFERENCE coupon campaigns now, so nothing is
  // pinned by an entitlement fingerprint, and drawn entries keep their
  // snapshots regardless of later edits.
  // Stored prizes carry server-copied snapshots (name/amount/...). Reduce them
  // back to their pool reference before re-validation: validatePrizes rejects
  // client-supplied cash amounts, and terms are re-copied from the pool on
  // every save anyway.
  const toPoolRefs = prizes => (prizes || []).map(p => ({
    id: p.id, kind: p.kind, qty: p.qty, probability: p.probability,
    ...(p.imageUrl ? { imageUrl: p.imageUrl } : {}),
    ...(typeof p.label === 'string' && p.label ? { label: p.label } : {}),
    ...(typeof p.icon === 'string' && p.icon ? { icon: p.icon } : {}),
    ...(p.kind === 'cash' ? { couponCampaignId: p.couponCampaignId } : {}),
    ...(p.kind === 'physical' && p.product ? { product: { id: p.product.id } } : {}),
  }));

  async function updateActivity(input, actor) {
    const id = assertId(input?.id);
    const patch = input?.config && typeof input.config === 'object' && !Array.isArray(input.config) ? input.config : {};
    return withTransaction(pool, async conn => {
      const [rows] = await conn.query('SELECT * FROM pos_activities WHERE ns = ? AND id = ? FOR UPDATE', [ns, id]);
      const row = rows[0];
      if (!row) throw problem('NOT_FOUND', '活动不存在', 404);
      const current = parseData(row.data);
      const merged = {};
      for (const key of CONFIG_KEYS) merged[key] = Object.hasOwn(patch, key) ? patch[key] : (key === 'prizes' ? toPoolRefs(current.prizes) : current[key]);
      const config = validateActivityConfig(merged);
      let wx = current.wx || { appid: '', secretProtected: '' };
      if (Object.hasOwn(patch, 'wx')) {
        const rawWx = patch.wx;
        if (rawWx === null) wx = { appid: '', secretProtected: '' };
        else {
          if (typeof rawWx !== 'object' || Array.isArray(rawWx)) throw problem('INVALID_CONFIG', 'wx 配置格式错误');
          let appid = wx.appid || '', secretProtected = wx.secretProtected || '';
          if (Object.hasOwn(rawWx, 'appid')) {
            appid = typeof rawWx.appid === 'string' ? rawWx.appid.trim() : '';
            if (appid && !/^[A-Za-z0-9_-]{1,64}$/.test(appid)) throw problem('INVALID_CONFIG', 'wx.appid 格式错误');
          }
          if (typeof rawWx.secret === 'string' && rawWx.secret) {
            if (rawWx.secret.length > 128 || /[\u0000-\u001f]/.test(rawWx.secret)) throw problem('INVALID_CONFIG', 'wx.secret 格式错误');
            secretProtected = protect(rawWx.secret);
          }
          if (!appid) secretProtected = '';
          wx = { appid, secretProtected };
        }
      }
      const staffKey = Object.hasOwn(patch, 'staffKey') ? validateStaffKey(patch.staffKey) : (current.staffKey || '');
      const previous = new Map((current.prizes || []).map(p => [p.id, p]));
      const prizes = config.prizes.map(p => {
        const old = previous.get(p.id);
        const remaining = old ? Math.max(0, Math.min(p.qty, (old.remaining || 0) + (p.qty - old.qty))) : p.qty;
        return { ...p, remaining };
      });
      await resolvePrizePools(conn, id, prizes, actor);
      const data = { ...config, prizes, wx, staffKey };
      await conn.query('UPDATE pos_activities SET title = ?, data = ?, updated_at = ? WHERE ns = ? AND id = ?', [config.title, JSON.stringify(data), iso(now()), ns, id]);
      return adminView({ ...row, title: config.title, data }, null, { revealStaffKey: true });
    });
  }

  async function setStatus(input) {
    const id = assertId(input?.id);
    const state = validateState(input?.state);
    const [result] = await pool.query('UPDATE pos_activities SET state = ?, updated_at = ? WHERE ns = ? AND id = ?', [state, iso(now()), ns, id]);
    if (result.affectedRows !== 1) throw problem('NOT_FOUND', '活动不存在', 404);
    return adminView(await load(id), null, { revealStaffKey: true });
  }

  async function list(revealStaffKey = false) {
    const [rows] = await pool.query('SELECT * FROM pos_activities WHERE ns = ? ORDER BY seq DESC LIMIT 200', [ns]);
    const [stats] = await pool.query(
      `SELECT activity, COUNT(*) AS entries,
        SUM(CASE WHEN data->>'$.status' = 'redeemed' THEN 1 ELSE 0 END) AS redeemed,
        SUM(CASE WHEN data->>'$.status' = 'pending' THEN 1 ELSE 0 END) AS pending
       FROM pos_activity_entries WHERE ns = ? GROUP BY activity`, [ns]);
    const byActivity = new Map(stats.map(s => [s.activity, s]));
    return { activities: rows.map(row => adminView(row, byActivity.get(row.id), { revealStaffKey })) };
  }

  function recordRow(entry) {
    const data = parseData(entry.data);
    const none = isNoPrize(data);
    return {
      code: none ? '' : entry.code, rawCode: entry.code, prize: none ? '（未中奖）' : (data.prize?.name || data.prizeId),
      // Records are an admin-only view: the full openid is the identifying
      // handle staff use to find one person's exact record (no phone number
      // is collected by the H5 — WeChat login yields openid only). Exports
      // stay masked.
      status: none ? 'none' : data.status, openid: entry.owner, maskedOpenid: maskOpenid(entry.owner),
      createdAt: data.createdAt ?? null, redeemedAt: data.redeemedAt || null, redeemedBy: data.redeemedBy || '',
    };
  }

  // Reset an activity to a factory-fresh state: every participation record
  // and invite is wiped and each prize pool is restored to its full quantity,
  // so every participant can draw again. Already-minted coupons are NOT
  // recalled — reset is meant for physical-prize activities (or pre-launch).
  async function reset(input) {
    const id = assertId(input?.id);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query('SELECT * FROM pos_activities WHERE ns = ? AND id = ? FOR UPDATE', [ns, id]);
      if (!rows[0]) throw problem('NOT_FOUND', '活动不存在', 404);
      const config = parseData(rows[0].data);
      for (const prize of config.prizes || []) prize.remaining = prize.qty;
      await conn.query('UPDATE pos_activities SET data = ?, updated_at = ? WHERE ns = ? AND id = ?', [JSON.stringify(config), iso(now()), ns, id]);
      await conn.query('DELETE FROM pos_activity_entries WHERE ns = ? AND activity = ?', [ns, id]);
      await conn.query('DELETE FROM pos_activity_invites WHERE ns = ? AND activity = ?', [ns, id]);
      await conn.commit();
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
    return records(id, {});
  }

  // Delete one participant's record so that person can draw again. The drawn
  // unit returns to its prize pool (capped at qty). Redeemed records are
  // refused: the goods already left, and the audit trail must stay intact.
  async function deleteRecord(input) {
    const id = assertId(input?.id);
    const code = String(input?.code || '').replace(/\s+/g, '').toUpperCase();
    if (!/^(?:[0-9A-F]{16}|NONE[0-9A-F]{20})$/.test(code)) throw problem('INVALID_INPUT', '核销码格式不正确', 400);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query('SELECT * FROM pos_activity_entries WHERE ns = ? AND activity = ? AND code = ? FOR UPDATE', [ns, id, code]);
      const entry = rows[0];
      if (!entry) throw problem('NOT_FOUND', '记录不存在', 404);
      const data = parseData(entry.data);
      if (data.status === 'redeemed') throw problem('ALREADY_REDEEMED', '该记录已核销，为保留发放凭证不能删除', 409);
      await conn.query('DELETE FROM pos_activity_entries WHERE ns = ? AND activity = ? AND code = ?', [ns, id, code]);
      const [arows] = await conn.query('SELECT data FROM pos_activities WHERE ns = ? AND id = ? FOR UPDATE', [ns, id]);
      const config = parseData(arows[0].data);
      const prize = (config.prizes || []).find(p => p.id === data.prizeId);
      if (prize && !isNoPrize(data)) prize.remaining = Math.min(prize.qty, Number(prize.remaining || 0) + 1);
      await conn.query('UPDATE pos_activities SET data = ?, updated_at = ? WHERE ns = ? AND id = ?', [JSON.stringify(config), iso(now()), ns, id]);
      await conn.commit();
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
    return records(id, {});
  }

  async function records(id, input = {}) {
    assertId(id);
    const row = await load(id);
    if (!row) throw problem('NOT_FOUND', '活动不存在', 404);
    const page = Number.isSafeInteger(input.page) && input.page >= 1 ? Math.min(input.page, 100000) : 1;
    const pageSize = Number.isSafeInteger(input.pageSize) && input.pageSize >= 1 ? Math.min(input.pageSize, 200) : 50;
    const [countRows] = await pool.query('SELECT COUNT(*) AS n FROM pos_activity_entries WHERE ns = ? AND activity = ?', [ns, id]);
    const [rows] = await pool.query('SELECT * FROM pos_activity_entries WHERE ns = ? AND activity = ? ORDER BY seq DESC LIMIT ? OFFSET ?', [ns, id, pageSize, (page - 1) * pageSize]);
    const [statusRows] = await pool.query(`SELECT data->>'$.status' AS s, COUNT(*) AS n FROM pos_activity_entries WHERE ns = ? AND activity = ? GROUP BY s`, [ns, id]);
    const [prizeRows] = await pool.query(`SELECT COALESCE(data->>'$.prize.name', '（未中奖）') AS p, COUNT(*) AS n FROM pos_activity_entries WHERE ns = ? AND activity = ? GROUP BY p`, [ns, id]);
    const count = name => Number(statusRows.find(s => s.s === name)?.n || 0);
    const config = parseData(row.data);
    const { total, remaining } = inventory(config);
    const byPrize = {};
    for (const p of prizeRows) byPrize[p.p] = Number(p.n);
    return {
      summary: {
        entries: Number(countRows[0].n), pending: count('pending'), redeemed: count('redeemed'), noPrize: count('unavailable'),
        stockTotal: total, stockRemaining: remaining, couponIssuesPending: 0, byPrize,
      },
      records: rows.map(recordRow), page, pageSize, total: Number(countRows[0].n),
    };
  }

  async function exportCsv(id) {
    assertId(id);
    const row = await load(id);
    if (!row) throw problem('NOT_FOUND', '活动不存在', 404);
    const [rows] = await pool.query('SELECT * FROM pos_activity_entries WHERE ns = ? AND activity = ? ORDER BY seq DESC', [ns, id]);
    const fmt = ms => (ms ? new Date(ms).toISOString() : '');
    const lines = ['code,prize,status,openid,createdAt,redeemedAt,redeemedBy'];
    for (const entry of rows) {
      const r = recordRow(entry);
      lines.push([r.code, r.prize, r.status, r.maskedOpenid, fmt(r.createdAt), fmt(r.redeemedAt), r.redeemedBy].map(csvEscape).join(','));
    }
    return { filename: `activity-${id}-records.csv`, csv: '﻿' + lines.join('\r\n') + '\r\n' };
  }

  async function dispatch(action, payload = {}, actor = null) {
    if (action === 'activity-list') return list(actor?.role === 'admin');
    if (action === 'activity-create') return { activity: await createActivity(payload, actor) };
    if (action === 'activity-update') return { activity: await updateActivity(payload, actor) };
    if (action === 'activity-set-status') return { activity: await setStatus(payload) };
    if (action === 'activity-records') return records(assertId(payload?.id), payload);
    if (action === 'activity-lookup') return lookup({ id: payload?.id ? assertId(payload.id) : null, code: payload?.code }, now());
    if (action === 'activity-prize-check') return prizeCheck({ code: payload?.code }, now());
    if (action === 'activity-redeem') return redeem({ id: payload?.id ? assertId(payload.id) : null, code: payload?.code, staffId: `cashier:${actor?.displayName || actor?.userId || 'unknown'}` }, now());
    if (action === 'activity-reset') {
      if (actor?.role !== 'admin') throw problem('FORBIDDEN', '需要管理员权限', 403);
      return reset(payload);
    }
    if (action === 'activity-record-delete') {
      if (actor?.role !== 'admin') throw problem('FORBIDDEN', '需要管理员权限', 403);
      return deleteRecord(payload);
    }
    if (action === 'activity-export') return exportCsv(payload?.id);
    throw problem('NOT_FOUND', '不支持的活动操作', 404);
  }

  return { session, publicCall, dispatch, getState, draw, lookup, redeem, records, exportCsv, list };
}

// Redeem-on-paid hook factory wired into the payment service by the online
// server. Runs after an order is already durable, so failures are logged
// loudly and never thrown into the response path. ALREADY_REDEEMED is the
// expected outcome of an idempotent re-fire (payment re-sync, recovery) and
// is swallowed; every other failure means a physical prize was handed over
// without its entry flipping — that must surface in the logs.
function createPrizeRedeemOnPaid(redeem, { log = console.error, nowMs = () => Date.now() } = {}) {
  if (typeof redeem !== 'function') throw problem('INVALID_STORE', '需要活动核销方法', 500);
  return async (order, actor) => {
    const staffId = 'cashier:' + (actor?.displayName || actor?.userId || 'unknown');
    for (const line of order?.items || []) {
      const code = line?.prize?.code;
      if (!code) continue;
      try { await redeem({ code, staffId }, nowMs()); }
      catch (error) {
        if (error?.code === 'ALREADY_REDEEMED') continue;
        log(`[activity] 订单奖品核销失败：order=${order?.id || ''} code=${code} staff=${staffId}：${error?.message || error}`);
      }
    }
  };
}

module.exports = { createActivityStore, createPrizeRedeemOnPaid, defaultCode2session, CODE_PATTERN, NO_PRIZE };
