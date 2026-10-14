'use strict';
// Shared MySQL test fixture: one pool per test file's fixture call, a random
// `ns` namespace per test so parallel test files never collide on shared pos_*
// tables, and teardown that deletes only the rows this namespace created.
const crypto = require('node:crypto');
const { createPool, ensureSchema, deleteNamespace } = require('../../online/mysql.cjs');

async function createPosFixture(t) {
  const pool = createPool();
  await ensureSchema(pool);
  const ns = 't' + crypto.randomBytes(8).toString('hex');
  t.after(async () => {
    await deleteNamespace(pool, ns);
    await pool.end();
  });
  return { pool, ns };
}

module.exports = { createPosFixture };
