import mysql from 'mysql2/promise';

// DATETIME columns carry Beijing wall time. dateStrings:true makes mysql2
// return them as raw 'YYYY-MM-DD HH:MM:SS.mmm' strings with no implicit
// conversion; these two helpers are the only places ms<->string conversion
// happens. The SET time_zone listener additionally pins functions like NOW().
export function msToDatetime(ms) {
  if (ms == null) return null;
  const d = new Date(ms + 8 * 3600 * 1000); // shift so UTC getters yield Beijing wall time
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`;
}

export function datetimeToMs(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  return Date.parse(String(value).replace(' ', 'T') + '+08:00');
}

export function createPool(env) {
  const pool = mysql.createPool({
    host: env.DB_HOST,
    port: Number(env.DB_PORT) || 3306,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    dateStrings: true,
  });
  pool.on('connection', conn => conn.query("SET time_zone = '+08:00'"));
  return pool;
}

// Boot-time / admin-update sync: the campaign config file is the source of
// truth. Upsert the campaign row, insert new prizes at full stock, and
// reconcile changed quantities: a raised qty tops up remaining by the
// difference, a lowered qty clamps remaining. Awarded stock is never reclaimed.
export async function syncCampaign(pool, config) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const now = msToDatetime(Date.now());
    await conn.query(
      `INSERT INTO hd_campaigns (id, name, active, starts_at, ends_at, redeem_ends_at, config, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), active = VALUES(active),
         starts_at = VALUES(starts_at), ends_at = VALUES(ends_at),
         redeem_ends_at = VALUES(redeem_ends_at), config = VALUES(config)`,
      [config.id, config.name, config.active ? 1 : 0, msToDatetime(config.startsAt),
       msToDatetime(config.endsAt), msToDatetime(config.redeemEndsAt), JSON.stringify(config), now],
    );
    const [rows] = await conn.query(
      'SELECT prize_id, qty_total, qty_remaining FROM hd_prizes WHERE campaign_id = ?', [config.id]);
    const existing = new Map(rows.map(r => [r.prize_id, r]));
    for (const prize of config.prizes) {
      const row = existing.get(prize.id);
      if (!row) {
        await conn.query(
          `INSERT INTO hd_prizes (campaign_id, prize_id, name, type, qty_total, qty_remaining, probability)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [config.id, prize.id, prize.name, prize.kind, prize.qty, prize.qty, prize.probability]);
      } else {
        const remaining = row.qty_total === prize.qty
          ? row.qty_remaining
          : Math.max(0, Math.min(prize.qty, row.qty_remaining + (prize.qty - row.qty_total)));
        await conn.query(
          `UPDATE hd_prizes SET name = ?, type = ?, probability = ?, qty_total = ?, qty_remaining = ?
           WHERE campaign_id = ? AND prize_id = ?`,
          [prize.name, prize.kind, prize.probability, prize.qty, remaining, config.id, prize.id]);
      }
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export async function inventoryTotals(pool, campaignId, queryable = pool) {
  const [rows] = await queryable.query(
    'SELECT COALESCE(SUM(qty_total),0) AS total, COALESCE(SUM(qty_remaining),0) AS remaining FROM hd_prizes WHERE campaign_id = ?',
    [campaignId]);
  return { total: Number(rows[0].total), remaining: Number(rows[0].remaining) };
}

export async function createSession(pool, tokenHash, openid, now, expiresAt) {
  await pool.query('DELETE FROM hd_sessions WHERE expires_at <= ?', [msToDatetime(now)]);
  await pool.query(
    'INSERT INTO hd_sessions (token_hash, openid, expires_at, created_at) VALUES (?, ?, ?, ?)',
    [tokenHash, openid, msToDatetime(expiresAt), msToDatetime(now)]);
}

export async function findSession(pool, tokenHash, now) {
  const [rows] = await pool.query(
    'SELECT openid, expires_at FROM hd_sessions WHERE token_hash = ?', [tokenHash]);
  if (!rows.length) return null;
  if (datetimeToMs(rows[0].expires_at) <= now) return null;
  return rows[0].openid;
}
