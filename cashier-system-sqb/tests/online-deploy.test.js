import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
const { nginxWithOnline, nginxSnippet, unit, probe } = createRequire(import.meta.url)('../online/install-linux.cjs');
const original = `server {\n  listen 80;\n  location / { return 404; }\n}\nserver {\n  listen 443 ssl;\n  location /v1/ { proxy_pass http://127.0.0.1:3910; }\n  location / { return 404; }\n}\n`;
test('online deployment inserts only an HTTPS include and preserves original coupon routes', () => {
  const changed = nginxWithOnline(original);
  assert.equal(changed.replace('    include /etc/nginx/snippets/bubble-online.conf;\n', ''), original);
  assert.ok(changed.indexOf('include ') > changed.indexOf('listen 443'));
  assert.equal(nginxWithOnline(changed), changed);
  assert.throws(() => nginxWithOnline(original.replace('3910', '4000')), /已变化/);
});
test('online service has independent user, directories and restricted loopback proxy', () => {
  const snippet = nginxSnippet();
  assert.match(snippet, /location \^~ \/cashier\//); assert.match(snippet, /127\.0\.0\.1:5175/);
  assert.ok(!snippet.includes('3910')); assert.ok(!snippet.includes('/v1/ {'));
  const config = unit('/opt/bubble/cashier-release', '/usr/local/bin/node');
  assert.match(config, /User=bubble-online/); assert.match(config, /ProtectSystem=strict/); assert.match(config, /UMask=0077/);
  assert.ok(!config.includes('bubble-coupons'));
});
test('deployment probe sends the public Host header over loopback', async () => {
  const server = http.createServer((req, res) => { res.statusCode = req.headers.host === 'example.test' ? 200 : 421; res.end(JSON.stringify({ host: req.headers.host })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { assert.deepEqual(await probe('/healthz', 'example.test', server.address().port), { status: 200, value: { host: 'example.test' } }); }
  finally { await new Promise(resolve => server.close(resolve)); }
});
