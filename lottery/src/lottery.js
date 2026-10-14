import crypto from 'node:crypto';
import { BizError } from './errors.js';
import { inventoryTotals, msToDatetime, datetimeToMs } from './db.js';
import { maskOpenid } from './auth.js';

const CODE_PATTERN = /^[0-9A-F]{16}$/;
const DUP_USER = 'uq_hd_entry_user';   // UNIQUE(campaign_id, openid)
const DUP_CODE = 'uq_hd_entry_code';   // UNIQUE(code)

// hd_entries.prize_id is NOT NULL, so the persisted "no prize" outcome uses
// this sentinel id (with code NULL and status 'unavailable').
const NO_PRIZE = 'none';
const isNoPrize = row => !row.prize_id || row.prize_id === NO_PRIZE;

export function normalizeCode(value) {
  return String(value ?? '').replace(/\s+/g, '').toUpperCase();
}

function publicPrize(prize) {
  if (!prize) return null;
  const { qty, ...rest } = prize;
  return rest;
}

// Shape consumed by public/app.mjs + core.mjs safeEntry(). Statuses stay within
// core.mjs VALID_STATUSES: pending | redeemed | expired (derived) | unavailable
// (the persisted "no prize" outcome, when the pool was already empty).
function publicEntry(row, config, now) {
  if (!row) return null;
  if (isNoPrize(row)) {
    return {
      prize: { id: 'none', name: '奖品已发完', shortName: '奖品已发完', kind: 'physical', label: '', icon: '' },
      code: '', createdAt: datetimeToMs(row.created_at), status: 'unavailable', checkoutCoupon: false,
      expiresAt: config.redeemEndsAt, minimumGoodsAmountCents: null, redeemedAt: null,
    };
  }
  const prize = config.prizes.find(p => p.id === row.prize_id);
  const status = row.status === 'redeemed' ? 'redeemed'
    : (config.redeemEndsAt && now >= config.redeemEndsAt ? 'expired' : 'pending');
  return {
    prize: publicPrize(prize), code: row.code, createdAt: datetimeToMs(row.created_at), status,
    checkoutCoupon: false, expiresAt: config.redeemEndsAt, minimumGoodsAmountCents: null,
    redeemedAt: datetimeToMs(row.redeemed_at) || null,
  };
}

function drawError(config, remaining, now) {
  if (!config.active) return { code: 'PAUSED', message: '活动暂未开放，请留意现场通知' };
  if (now < config.startsAt) return { code: 'NOT_STARTED', message: '活动尚未开始' };
  if (now >= config.endsAt) return { code: 'ENDED', message: '抽奖已结束，已中奖礼品仍可在有效期内领取' };
  if (remaining <= 0) return { code: 'SOLD_OUT', message: '本次活动名额已发完，已中奖奖品仍可在有效期内使用' };
  return null;
}

// Read-only: never writes (no lazy re-issue like the old system).
export async function getState(pool, config, openid, now = Date.now()) {
  const [rows] = await pool.query(
    'SELECT * FROM hd_entries WHERE campaign_id = ? AND openid = ?', [config.id, openid]);
  const { total, remaining } = await inventoryTotals(pool, config.id);
  const error = drawError(config, remaining, now);
  return {
    campaign: {
      id: config.id, title: config.title, name: config.name, venue: config.venue,
      enabled: config.active, startsAt: config.startsAt, endsAt: config.endsAt,
      redeemEndsAt: config.redeemEndsAt, cashTerms: config.cashTerms, rulesText: config.rulesText,
      inventory: { version: 1, total },
    },
    prizes: config.prizes.map(p => ({ ...publicPrize(p), quantity: p.qty })),
    inventory: { total, remaining },
    drawError: rows.length ? null : (error ? error.message : null),
    entry: publicEntry(rows[0], config, now),
  };
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

function makeCode() {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

// Uniform double in [0,1) from 48 random bits.
function defaultRandomUnit() {
  return crypto.randomBytes(6).readUIntBE(0, 6) / 2 ** 48;
}

const INSERT_ENTRY =
  'INSERT INTO hd_entries (campaign_id, openid, prize_id, code, status, created_at) VALUES (?, ?, ?, ?, ?, ?)';

// One draw per user per campaign. Repeat calls return the stored entry
// unchanged, including the persisted "no prize" outcome. Concurrency safety
// comes from UNIQUE(campaign_id, openid) (a lost race re-reads and returns the
// winner's entry) and from the conditional stock decrement (a lost race retries
// with fresh stock).
export async function draw(pool, config, openid, now = Date.now(), randomUnit = defaultRandomUnit) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [existing] = await conn.query(
        'SELECT * FROM hd_entries WHERE campaign_id = ? AND openid = ?', [config.id, openid]);
      if (existing.length) {
        await conn.commit();
        return publicEntry(existing[0], config, now);
      }
      const { remaining } = await inventoryTotals(pool, config.id, conn);
      const blocked = drawError(config, remaining, now);
      if (blocked && blocked.code !== 'SOLD_OUT') throw new BizError(blocked.code, blocked.message);

      let prizeId = null, status = 'unavailable';
      if (!blocked) {
        const [stock] = await conn.query(
          'SELECT prize_id, qty_remaining FROM hd_prizes WHERE campaign_id = ? AND qty_remaining > 0 FOR UPDATE',
          [config.id]);
        const candidates = stock
          .map(row => ({ ...config.prizes.find(p => p.id === row.prize_id), remaining: row.qty_remaining }))
          .filter(p => p.id && p.probability > 0);
        if (candidates.length) {
          const picked = weightedPick(candidates, randomUnit);
          const [result] = await conn.query(
            'UPDATE hd_prizes SET qty_remaining = qty_remaining - 1 WHERE campaign_id = ? AND prize_id = ? AND qty_remaining > 0',
            [config.id, picked.id]);
          if (result.affectedRows !== 1) { // stock lost to a concurrent draw: retry with fresh stock
            await conn.rollback();
            continue;
          }
          prizeId = picked.id;
          status = 'pending';
        }
      }

      let inserted = false;
      for (let i = 0; i < 5 && !inserted; i++) {
        // hd_entries.code is NOT NULL + UNIQUE: no-prize entries get a sentinel
        // code that fails CODE_PATTERN, so it can never be looked up/redeemed.
        const code = prizeId ? makeCode() : ('NONE' + crypto.randomBytes(14).toString('hex').toUpperCase());
        try {
          await conn.query(INSERT_ENTRY, [config.id, openid, prizeId || NO_PRIZE, code, status, msToDatetime(now)]);
          inserted = true;
        } catch (error) {
          if (error.code === 'ER_DUP_ENTRY' && String(error.message).includes(DUP_CODE)) continue;
          throw error;
        }
      }
      if (!inserted) throw new BizError('RETRY', '系统繁忙，请重试', 503);

      const [rows] = await conn.query(
        'SELECT * FROM hd_entries WHERE campaign_id = ? AND openid = ?', [config.id, openid]);
      await conn.commit();
      return publicEntry(rows[0], config, now);
    } catch (error) {
      await conn.rollback().catch(() => {});
      // Concurrent draw by the same user: the next pass re-reads and returns it.
      if (error.code === 'ER_DUP_ENTRY' && String(error.message).includes(DUP_USER) && attempt < 3) continue;
      throw error;
    } finally {
      conn.release();
    }
  }
  throw new BizError('RETRY', '系统繁忙，请重试', 503);
}

async function findByCode(pool, config, code, queryable = pool) {
  if (!CODE_PATTERN.test(code)) throw new BizError('INVALID_CODE', '核销码格式不正确，请核对后重试');
  const [rows] = await queryable.query(
    'SELECT * FROM hd_entries WHERE campaign_id = ? AND code = ?', [config.id, code]);
  const entry = rows[0];
  if (!entry || isNoPrize(entry)) throw new BizError('NOT_FOUND', '未找到此活动的核销码，请核对', 404);
  return entry;
}

export async function lookup(pool, config, rawCode, now = Date.now()) {
  const entry = await findByCode(pool, config, normalizeCode(rawCode));
  return { ...publicEntry(entry, config, now), winner: maskOpenid(entry.openid) };
}

// Redeem rule: any pending code may be redeemed until redeemEndsAt; after that
// it is rejected as EXPIRED (matching the "已过期" status the winner already
// sees in the H5). The conditional UPDATE makes redemption single-use even
// under concurrent requests: the loser sees affectedRows 0 -> ALREADY_REDEEMED.
export async function redeem(pool, config, rawCode, staffId, now = Date.now()) {
  const code = normalizeCode(rawCode);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const entry = await findByCode(pool, config, code, conn);
    if (entry.status === 'redeemed') throw new BizError('ALREADY_REDEEMED', '此奖品已核销，请勿重复发放', 409);
    if (config.redeemEndsAt && now >= config.redeemEndsAt) throw new BizError('EXPIRED', '该奖品已超过核销期限', 410);
    const [result] = await conn.query(
      "UPDATE hd_entries SET status = 'redeemed', redeemed_at = ?, redeemed_by = ? WHERE campaign_id = ? AND code = ? AND status = 'pending'",
      [msToDatetime(now), staffId, config.id, code]);
    if (result.affectedRows !== 1) throw new BizError('ALREADY_REDEEMED', '此奖品已核销，请勿重复发放', 409);
    const [rows] = await conn.query(
      'SELECT * FROM hd_entries WHERE campaign_id = ? AND code = ?', [config.id, code]);
    await conn.commit();
    return { ...publicEntry(rows[0], config, now), winner: maskOpenid(rows[0].openid) };
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

export async function listRecords(pool, config) {
  const [rows] = await pool.query(
    'SELECT * FROM hd_entries WHERE campaign_id = ? ORDER BY created_at DESC, id DESC', [config.id]);
  const byPrize = {};
  let pending = 0, redeemed = 0, none = 0;
  const records = rows.map(row => {
    const prize = isNoPrize(row) ? null : config.prizes.find(p => p.id === row.prize_id);
    const name = prize ? prize.name : '（未中奖）';
    byPrize[name] = (byPrize[name] || 0) + 1;
    if (row.status === 'redeemed') redeemed++;
    else if (isNoPrize(row)) none++;
    else pending++;
    return {
      code: isNoPrize(row) ? '' : (row.code || ''), prize: name, status: isNoPrize(row) ? 'none' : row.status,
      openid: maskOpenid(row.openid), createdAt: datetimeToMs(row.created_at),
      redeemedAt: datetimeToMs(row.redeemed_at) || null, redeemedBy: row.redeemed_by || '',
    };
  });
  const { total, remaining } = await inventoryTotals(pool, config.id);
  return { summary: { entries: rows.length, pending, redeemed, noPrize: none, stockTotal: total, stockRemaining: remaining, byPrize }, records };
}
