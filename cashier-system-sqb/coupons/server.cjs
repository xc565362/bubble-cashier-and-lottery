const http = require('node:http');
const { createPool, assertReachable, ensureSchema } = require('../online/mysql.cjs');
const { createCouponStore } = require('./store.cjs');
const { couponHttp } = require('./http.cjs');

async function main() {
  const adminToken = process.env.COUPON_ADMIN_TOKEN;
  if (!adminToken || !/^[A-Za-z0-9_.-]{32,300}$/.test(adminToken)) throw new Error('Set COUPON_ADMIN_TOKEN to a private random token of at least 32 characters.');
  const environment = process.env.COUPON_ENV || 'development';
  if (!['production', 'development'].includes(environment)) throw new Error('COUPON_ENV must be production or development.');
  const pool = createPool();
  await assertReachable(pool);
  await ensureSchema(pool);
  const store = await createCouponStore({ pool, environment });
  const catalogAggregateRateLimit = process.env.COUPON_CATALOG_RATE_LIMIT === undefined ? 6000 : Number(process.env.COUPON_CATALOG_RATE_LIMIT);
  const server = http.createServer(couponHttp(store, { adminToken, catalogAggregateRateLimit }));
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.listen(Number(process.env.PORT || 3910), process.env.HOST || '127.0.0.1', () => console.log(`Coupon API ${environment}; port ${server.address().port}; HTTPS reverse proxy required for production.`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => pool.end(() => process.exit(0))));
}
main().catch(error => { console.error(error.message); process.exit(1); });
