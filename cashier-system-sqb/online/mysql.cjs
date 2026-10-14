'use strict';
// Shared MySQL access for the cashier server-side stores (online auth/ledger,
// coupon center). Same database and conventions as the lottery project:
// DB_* env vars, Beijing time per connection, dateStrings. All server tables
// carry the `pos_` prefix and are created/owned by ensureSchema() below.
//
// Every table has an `ns` (namespace) column included in its primary/unique
// keys. Production always uses ns = '' so unique constraints behave exactly
// like the former SQLite ones; tests use a random ns per run and delete only
// their own rows.
const mysql = require('mysql2/promise');

function createPool(env = process.env) {
  for (const key of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
    if (!env[key]) throw new Error(`缺少数据库配置 ${key}，请设置环境变量或 .env.local`);
  }
  const pool = mysql.createPool({
    host: env.DB_HOST,
    port: Number(env.DB_PORT) || 3306,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    dateStrings: true,
    charset: 'utf8mb4',
  });
  pool.on('connection', conn => conn.query("SET time_zone = '+08:00'"));
  return pool;
}

// Fail-fast probe used by service entry points at boot.
async function assertReachable(pool) {
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    throw new Error(`数据库连接失败（${error.code || error.message}），请检查 DB_* 配置`);
  }
}

const DDL = [
  // online/auth.cjs
  `CREATE TABLE IF NOT EXISTS pos_users (
    ns VARCHAR(40) NOT NULL, id VARCHAR(64) NOT NULL, username VARCHAR(64) NOT NULL,
    display_name VARCHAR(100) NOT NULL, role VARCHAR(16) NOT NULL, disabled TINYINT NOT NULL DEFAULT 0,
    salt CHAR(32) NOT NULL, password_hash CHAR(64) NOT NULL,
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
    PRIMARY KEY (ns, id), UNIQUE KEY pos_users_username (ns, username)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS pos_sessions (
    ns VARCHAR(40) NOT NULL, id VARCHAR(64) NOT NULL, token_hash CHAR(64) NOT NULL,
    user_id VARCHAR(64) NOT NULL, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL,
    seq BIGINT NOT NULL AUTO_INCREMENT,
    PRIMARY KEY (ns, id), UNIQUE KEY pos_sessions_token (ns, token_hash), UNIQUE KEY pos_sessions_seq (seq),
    KEY pos_sessions_user (ns, user_id, created_at), KEY pos_sessions_expiry (ns, expires_at),
    CONSTRAINT pos_sessions_user_fk FOREIGN KEY (ns, user_id) REFERENCES pos_users (ns, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS pos_login_limits (
    ns VARCHAR(40) NOT NULL, bucket CHAR(64) NOT NULL, attempts INT NOT NULL, reset_at BIGINT NOT NULL,
    PRIMARY KEY (ns, bucket)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS pos_audit (
    id BIGINT NOT NULL AUTO_INCREMENT, ns VARCHAR(40) NOT NULL, at BIGINT NOT NULL,
    action VARCHAR(64) NOT NULL, actor_id VARCHAR(64) NULL, user_id VARCHAR(64) NULL, metadata TEXT NOT NULL,
    PRIMARY KEY (id), KEY pos_audit_ns (ns, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  // online/ledger.cjs
  `CREATE TABLE IF NOT EXISTS pos_ledger (
    ns VARCHAR(40) NOT NULL, id TINYINT NOT NULL, revision BIGINT NOT NULL, body LONGTEXT NOT NULL,
    PRIMARY KEY (ns, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS pos_lease (
    ns VARCHAR(40) NOT NULL, id TINYINT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY (ns, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS pos_commands (
    ns VARCHAR(40) NOT NULL, actor VARCHAR(128) NOT NULL, request_id VARCHAR(128) NOT NULL,
    fingerprint CHAR(64) NOT NULL, result TEXT NOT NULL,
    PRIMARY KEY (ns, actor, request_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS pos_ack (
    ns VARCHAR(40) NOT NULL, kind VARCHAR(32) NOT NULL, id VARCHAR(128) NOT NULL,
    PRIMARY KEY (ns, kind, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS pos_awards (
    ns VARCHAR(40) NOT NULL, id VARCHAR(128) NOT NULL, owner VARCHAR(128) NOT NULL, line TEXT NOT NULL,
    PRIMARY KEY (ns, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  // coupons/store.cjs. The former SQLite partial unique indexes become generated
  // columns: NULL when the state does not claim the value, and MySQL unique keys
  // allow multiple NULLs, which preserves the exact claim-once semantics.
  `CREATE TABLE IF NOT EXISTS pos_coupon_meta (
    ns VARCHAR(40) NOT NULL, id VARCHAR(64) NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (ns, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS pos_coupon_campaigns (
    ns VARCHAR(40) NOT NULL, id VARCHAR(64) NOT NULL, data JSON NOT NULL,
    seq BIGINT NOT NULL AUTO_INCREMENT,
    lottery_campaign VARCHAR(160) GENERATED ALWAYS AS (
      CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(data, '$.lotteryCatalog.campaignId')) IS NOT NULL
        THEN JSON_UNQUOTE(JSON_EXTRACT(data, '$.lotteryCatalog.campaignId')) END) VIRTUAL,
    lottery_prize VARCHAR(80) GENERATED ALWAYS AS (
      CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(data, '$.lotteryCatalog.campaignId')) IS NOT NULL
        THEN JSON_UNQUOTE(JSON_EXTRACT(data, '$.lotteryCatalog.prizeId')) END) VIRTUAL,
    PRIMARY KEY (ns, id), UNIQUE KEY pos_coupon_campaigns_seq (seq),
    UNIQUE KEY pos_coupon_campaigns_lottery (ns, lottery_campaign, lottery_prize)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS pos_coupons (
    ns VARCHAR(40) NOT NULL, id VARCHAR(64) NOT NULL, campaign VARCHAR(64) NOT NULL,
    owner VARCHAR(200) NOT NULL, issuer VARCHAR(200) NOT NULL, award VARCHAR(200) NOT NULL,
    data JSON NOT NULL, seq BIGINT NOT NULL AUTO_INCREMENT,
    checkout_claim VARCHAR(200) GENERATED ALWAYS AS (
      CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(data, '$.state')) IN ('RESERVED', 'PAYMENT_PENDING', 'REDEEMED')
        THEN JSON_UNQUOTE(JSON_EXTRACT(data, '$.reservation.checkoutId')) END) VIRTUAL,
    order_claim VARCHAR(200) GENERATED ALWAYS AS (
      CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(data, '$.state')) IN ('PAYMENT_PENDING', 'REDEEMED')
        THEN JSON_UNQUOTE(JSON_EXTRACT(data, '$.reservation.orderId')) END) VIRTUAL,
    payment_claim VARCHAR(200) GENERATED ALWAYS AS (
      CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(data, '$.state')) = 'REDEEMED'
        THEN JSON_UNQUOTE(JSON_EXTRACT(data, '$.paymentReference')) END) VIRTUAL,
    PRIMARY KEY (ns, id), UNIQUE KEY pos_coupons_seq (seq),
    UNIQUE KEY pos_coupons_award (ns, issuer, award),
    UNIQUE KEY pos_coupons_checkout (ns, checkout_claim),
    UNIQUE KEY pos_coupons_order (ns, order_claim),
    UNIQUE KEY pos_coupons_payment (ns, payment_claim),
    KEY pos_coupons_owner (ns, issuer, owner)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS pos_coupon_api_keys (
    ns VARCHAR(40) NOT NULL, id VARCHAR(64) NOT NULL, hash CHAR(64) NOT NULL, data TEXT NOT NULL,
    seq BIGINT NOT NULL AUTO_INCREMENT,
    PRIMARY KEY (ns, id), UNIQUE KEY pos_coupon_api_keys_hash (ns, hash), UNIQUE KEY pos_coupon_api_keys_seq (seq)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS pos_coupon_operations (
    ns VARCHAR(40) NOT NULL, scope VARCHAR(200) NOT NULL, id VARCHAR(128) NOT NULL,
    hash CHAR(64) NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (ns, scope, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS pos_coupon_events (
    ns VARCHAR(40) NOT NULL, id VARCHAR(64) NOT NULL, at VARCHAR(40) NOT NULL,
    actor VARCHAR(200) NOT NULL, \`action\` VARCHAR(64) NOT NULL, target VARCHAR(64) NOT NULL,
    seq BIGINT NOT NULL AUTO_INCREMENT,
    PRIMARY KEY (ns, id), UNIQUE KEY pos_coupon_events_seq (seq)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS pos_coupon_tokens (
    ns VARCHAR(40) NOT NULL, coupon_id VARCHAR(64) NOT NULL, token VARCHAR(200) NOT NULL,
    PRIMARY KEY (ns, coupon_id), UNIQUE KEY pos_coupon_tokens_token (ns, token),
    CONSTRAINT pos_coupon_tokens_fk FOREIGN KEY (ns, coupon_id) REFERENCES pos_coupons (ns, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
];

async function ensureSchema(pool) {
  for (const statement of DDL) await pool.query(statement);
}

// Runs fn(conn) inside a real transaction (BEGIN/COMMIT/ROLLBACK), mirroring
// the former BEGIN IMMEDIATE critical sections.
async function withTransaction(pool, fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

// All pos_* tables, ordered so foreign-key children come before parents.
const POS_TABLES = [
  'pos_sessions', 'pos_login_limits', 'pos_audit', 'pos_users',
  'pos_coupon_tokens', 'pos_coupon_events', 'pos_coupon_operations', 'pos_coupons',
  'pos_coupon_api_keys', 'pos_coupon_campaigns', 'pos_coupon_meta',
  'pos_awards', 'pos_ack', 'pos_commands', 'pos_lease', 'pos_ledger',
];

// Test/demo teardown: delete only the rows of one namespace, never whole tables.
async function deleteNamespace(pool, ns) {
  for (const table of POS_TABLES) await pool.query(`DELETE FROM ${table} WHERE ns = ?`, [ns]);
}

module.exports = { createPool, assertReachable, ensureSchema, withTransaction, deleteNamespace, POS_TABLES };
