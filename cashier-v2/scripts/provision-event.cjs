'use strict';
// One-shot provisioning of a bubble-event/1 event connection. Reads
// EVENT_BASE_URL + EVENT_STAFF_KEY from the environment and runs the event
// bridge's own pair path (URL validation + manifest fetch + key probe), so
// the encrypted connection file is written with the server's own key —
// no UI key entry, no addresses typed into browsers.
// Usage: EVENT_BASE_URL=http://127.0.0.1:8787 EVENT_STAFF_KEY=... \
//   BUBBLE_ONLINE_DATA_DIR=/var/lib/bubble-online BUBBLE_ONLINE_KEY_FILE=/etc/... node scripts/provision-event.cjs
const path = require('node:path');
const { createServerProtector } = require('../online/secrets.cjs');
const { createEventBridge } = require('../payments/event-bridge.cjs');

const fail = message => { console.error('provision-event: ' + message); process.exit(1); };

const directory = process.env.BUBBLE_ONLINE_DATA_DIR;
const keyFile = process.env.BUBBLE_ONLINE_KEY_FILE;
if (!directory || !path.isAbsolute(directory)) fail('需要绝对路径 BUBBLE_ONLINE_DATA_DIR');
if (!keyFile || !path.isAbsolute(keyFile)) fail('需要绝对路径 BUBBLE_ONLINE_KEY_FILE');

const baseUrl = String(process.env.EVENT_BASE_URL || '').trim();
const key = String(process.env.EVENT_STAFF_KEY || '');
if (!baseUrl) fail('EVENT_BASE_URL 未填写');
if (!key) fail('EVENT_STAFF_KEY 未填写');

(async () => {
  const { protect, unprotect } = createServerProtector({ keyFile });
  const bridge = createEventBridge({ directory: path.join(directory, 'payments'), protect, unprotect });
  const entry = await bridge.dispatch('pair', { baseUrl, key }).catch(error => fail(error.message));
  console.log(`provision-event: 已连接「${entry.title}」(${entry.id}) @ ${entry.baseUrl}，支持：${entry.actions.join('/')}`);
})();
