'use strict';
// Minimal JSONL access log to stdout; pm2/docker/journald capture it.
// Never logs bodies or query strings (may carry secrets).
function accessLog(service, req, res, started) {
  try {
    console.log(JSON.stringify({
      ts: new Date().toISOString(), service, method: req.method,
      path: String(req.url || '').split('?')[0].slice(0, 200),
      status: res.statusCode, ms: Date.now() - started,
      ip: req.socket?.remoteAddress || '',
      terminal: String(req.headers['x-terminal-id'] || '').slice(0, 64),
    }));
  } catch {}
}
module.exports = { accessLog };
