'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FINANCIAL = new Set(['pending', 'start', 'query', 'acknowledge', 'resolve-missing-payment',
  'preview-adjustment', 'start-adjustment', 'claim-payment-notification', 'coupon-reserve',
  'coupon-release', 'coupon-zero', 'coupon-zero-ack', 'coupon-sync', 'coupon-fulfilment', 'coupon-bind-physical-products']);
const STAFF_READ = new Set(['config', 'coupon-config', 'coupon-physical-bindings', 'coupon-pending']);
const ADMIN = new Set(['save-config', 'generate-key', 'import-credentials', 'export-credentials', 'check-connection', 'diagnostics',
  'coupon-connect', 'coupon-bind-physical-products', 'coupon-campaigns', 'coupon-create-campaign', 'coupon-set-campaign',
  'coupon-coupons', 'coupon-coupon', 'coupon-issue', 'coupon-keys', 'coupon-create-key', 'coupon-revoke-key', 'coupon-void', 'coupon-events',
  'lottery-config', 'lottery-snapshot', 'lottery-records', 'lottery-connect', 'lottery-update', 'lottery-increase-capacity', 'lottery-export-connection', 'lottery-import-connection',
  'scarf-config', 'scarf-snapshot', 'scarf-records', 'scarf-connect', 'scarf-update', 'scarf-export-connection', 'scarf-import-connection']);
const SENSITIVE_CONFIG = new Set(['save-config', 'generate-key', 'import-credentials', 'check-connection', 'coupon-connect', 'coupon-bind-physical-products']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webp': 'image/webp' };

function problem(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function equal(a, b) { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); }
async function rawBody(req, limit = 2 * 1024 * 1024) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw problem('CONTENT_TYPE', '请使用 JSON 请求', 415);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw problem('TOO_LARGE', '内容超过允许大小', 413); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
async function body(req, limit) {
  const raw = await rawBody(req, limit);
  let value;
  try { value = JSON.parse(raw); } catch { throw problem('INVALID_JSON', '请求内容格式不正确'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem('INVALID_JSON', '请求内容必须是对象');
  return value;
}
function cookieValue(req, name) {
  const parts = String(req.headers.cookie || '').split(';').map(s => s.trim()).filter(s => s.startsWith(name + '='));
  return parts.length === 1 ? parts[0].slice(name.length + 1) : '';
}
function business(ledger) {
  return { type: 'stall-cashier-backup', version: 1, exportedAt: new Date().toISOString(), products: ledger.products, orders: ledger.orders, heldCarts: ledger.heldCarts || [], paymentQr: ledger.paymentQr || {}, promoRules: ledger.promoRules || [] };
}

function createOnlineHandler({ auth, ledger, service, publicOrigin, staticRoot, setup, allowHttpLocal = false, trustProxy = false }) {
  const origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin || origin.username || origin.password ||
      (origin.protocol !== 'https:' && !(allowHttpLocal && origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname)))) {
    throw new Error('PUBLIC_ORIGIN 必须是正式 HTTPS 地址，或明确启用的本机测试地址');
  }
  const secure = origin.protocol === 'https:';
  const cookieName = secure ? '__Host-bubble-online' : 'bubble-online-dev';
  const root = staticRoot && fs.realpathSync(staticRoot);
  function setSession(res, token, expiresAt) {
    const remaining = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
    res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${remaining}${secure ? '; Secure' : ''}`);
  }
  function clearSession(res) { res.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`); }
  function send(res, value, status = 200) { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)); }
  function admin(session) { if (session.user.role !== 'admin') throw problem('FORBIDDEN', '此操作需要管理员账号', 403); }
  function sameOrigin(req) {
    if (req.headers.origin !== publicOrigin) throw problem('ORIGIN_DENIED', '请从本系统页面发起操作', 403);
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw problem('ORIGIN_DENIED', '不允许跨站操作', 403);
  }
  function remoteIp(req) {
    const peer = req.socket.remoteAddress || '';
    if (trustProxy && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)) {
      const forwarded = req.headers['x-real-ip'];
      if (typeof forwarded === 'string' && /^[a-fA-F0-9:.]{3,45}$/.test(forwarded)) return forwarded;
    }
    return peer;
  }
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    let sqb = false;
    try {
      if (req.headers.host !== origin.host) throw problem('HOST_DENIED', '访问地址不匹配', 421);
      const url = new URL(req.url, publicOrigin), route = url.pathname;
      sqb = route.startsWith('/api/sqb/');
      if (req.method === 'GET' && route === '/healthz') return send(res, { ok: true, service: 'bubble-online-cashier' });
      if (setup && req.method === 'GET' && ['/setup', '/cashier/setup', '/api/online/setup-client.js'].includes(route)) {
        if (!setup.setupEnabled()) throw problem('SETUP_DISABLED', '管理员已设置或初始化链接已过期', 404);
        const page = require('./setup-page.cjs'), isScript = route.endsWith('.js');
        res.setHeader('Content-Type', isScript ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8');
        res.end(isScript ? page.script : page.html); return;
      }
      if (setup && route === '/api/online/setup' && req.method === 'POST') {
        sameOrigin(req);
        const input = await body(req, 8192);
        await setup.accept({ token: req.headers['x-setup-token'], username: input.username, password: input.password, displayName: input.displayName });
        return send(res, { ok: true });
      }
      if (route === '/api/sqb/notify') {
        if (req.method !== 'POST') throw problem('METHOD', '不支持此请求方式', 405);
        const input = await rawBody(req);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        // Only the existing gateway verifier can authenticate payment notifications.
        res.end(await service.notification(input)); return;
      }
      if (!route.startsWith('/api/')) {
        if (!root || !['GET', 'HEAD'].includes(req.method)) throw problem('NOT_FOUND', '页面不存在', 404);
        let decoded; try { decoded = decodeURIComponent(route.startsWith('/cashier/') ? route.slice('/cashier'.length) : route); } catch { throw problem('NOT_FOUND', '页面不存在', 404); }
        if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(part => part.startsWith('.'))) throw problem('NOT_FOUND', '页面不存在', 404);
        const file = path.resolve(root, `.${decoded === '/' ? '/index.html' : decoded}`);
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw problem('NOT_FOUND', '页面不存在', 404);
        const real = fs.realpathSync(file);
        if (!real.startsWith(root + path.sep) || real.endsWith('.map') || !MIME[path.extname(file)]) throw problem('NOT_FOUND', '页面不存在', 404);
        res.setHeader('Content-Type', MIME[path.extname(file)]);
        if (route.startsWith('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        if (req.method === 'HEAD') { res.end(); return; }
        const stream = fs.createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res); return;
      }
      if (route === '/api/online/login' && req.method === 'POST') {
        sameOrigin(req);
        const input = await body(req, 8192);
        const session = await auth.authenticate(input.username, input.password, { ip: remoteIp(req), userAgent: String(req.headers['user-agent'] || '').slice(0, 300) });
        setSession(res, session.token, session.expiresAt);
        return send(res, { online: true, user: session.user, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
      }
      const token = cookieValue(req, cookieName), session = await auth.getSession(token);
      if (!session) { clearSession(res); return send(res, { online: true, ok: false, code: 'AUTH_REQUIRED', error: '请先登录' }, 401); }
      const terminalId = req.headers['x-terminal-id'];
      if (!/^[a-f0-9-]{36}$/i.test(terminalId || '')) throw problem('TERMINAL_REQUIRED', '请刷新页面以识别当前收银终端', 400);
      const actor = { userId: session.user.id, sessionId: session.sessionId + '_' + terminalId, role: session.user.role, displayName: session.user.displayName || session.user.username };
      if (!['GET', 'HEAD'].includes(req.method)) {
        sameOrigin(req);
        if (!equal(req.headers['x-csrf-token'], session.csrfToken)) throw problem('CSRF_DENIED', '登录状态已更新，请刷新页面重试', 403);
      } else if (req.headers.origin && req.headers.origin !== publicOrigin) throw problem('ORIGIN_DENIED', '不允许跨站读取', 403);
      if (route === '/api/online/session' && req.method === 'GET') return send(res, { online: true, user: session.user, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
      if (route === '/api/online/logout' && req.method === 'POST') { await auth.logout(token); clearSession(res); return send(res, { ok: true }); }
      if (route === '/api/online/password' && req.method === 'POST') {
        const input = await body(req, 8192); await auth.changePassword(session.user.id, input.currentPassword, input.password); clearSession(res); return send(res, { ok: true });
      }
      if (route === '/api/online/users') {
        admin(session);
        if (req.method === 'GET') return send(res, { users: await auth.listUsers() });
        if (req.method === 'POST') return send(res, { user: await auth.createUser(await body(req, 8192), session.user) }, 201);
      }
      const userRoute = /^\/api\/online\/users\/([a-zA-Z0-9-]{1,64})(\/password)?$/.exec(route);
      if (userRoute) {
        admin(session); const input = await body(req, 8192);
        if (userRoute[2] && req.method === 'POST') return send(res, { user: await auth.updateUser(userRoute[1], { password: input.password }, session.user) });
        if (!userRoute[2] && req.method === 'PATCH') return send(res, { user: await auth.updateUser(userRoute[1], Object.fromEntries(['displayName', 'role', 'disabled'].filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]])), session.user) });
      }
      if (route === '/api/online/ledger' && req.method === 'GET') return send(res, await ledger.snapshot(actor));
      if (route === '/api/online/lease/acquire' && req.method === 'POST') return send(res, await ledger.acquireLease(actor, await body(req, 8192)));
      if (route === '/api/online/lease/release' && req.method === 'POST') return send(res, await ledger.releaseLease(actor));
      if (route === '/api/online/command' && req.method === 'POST') return send(res, await ledger.command(await body(req, 32 * 1024 * 1024), actor));
      if (route === '/api/online/import' && req.method === 'POST') {
        admin(session); const input = await body(req, 32 * 1024 * 1024);
        return send(res, await ledger.command({ type: 'initial-import', payload: { bundle: input.bundle }, expectedRevision: input.expectedRevision, requestId: input.requestId }, actor));
      }
      if (route === '/api/online/export' && req.method === 'GET') {
        admin(session); const snapshot = await ledger.snapshot(actor);
        if (snapshot.ledger.pendingPayment || snapshot.ledger.pendingAdjustment || snapshot.ledger.pendingRestore) throw problem('BUSY', '请先处理未完成交易再导出');
        const bundle = await service.dispatch('export-backup', { business: business(snapshot.ledger) });
        res.setHeader('Content-Disposition', 'attachment; filename="bubble-online-backup.json"'); return send(res, bundle);
      }
      if (sqb) {
        if (req.method !== 'POST') throw problem('METHOD', '不支持此请求方式', 405);
        const action = route.slice('/api/sqb/'.length);
        if (!FINANCIAL.has(action) && !STAFF_READ.has(action) && !ADMIN.has(action)) throw problem('NOT_FOUND', '此操作不可在线调用', 404);
        if (ADMIN.has(action)) admin(session);
        const payload = await body(req, 32 * 1024 * 1024);
        if (SENSITIVE_CONFIG.has(action)) await ledger.assertLease(actor);
        let data;
        if (FINANCIAL.has(action)) data = await ledger.paymentDispatch(action, payload, actor);
        else {
          if (action === 'coupon-bind-physical-products') payload.products = (await ledger.snapshot(actor)).ledger.products;
          data = await service.dispatch(action, payload);
        }
        if (action === 'config') { data = { ...data }; delete data.directory; }
        return send(res, { ok: true, data });
      }
      throw problem('NOT_FOUND', '接口不存在', 404);
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 400;
      // Do not return SQL errors, file paths, key material or internal exception details.
      const internal = error instanceof TypeError || error instanceof SyntaxError || /^(?:SQLITE|ERR_|EACCES|ENOENT|EPERM|ENOSPC|EIO|EBUSY|EISDIR|ENOTDIR)/.test(error.code || '');
      const safeMessage = !internal && typeof error.message === 'string' && /[\u3400-\u9fff]/u.test(error.message) ? error.message : '操作未完成，请刷新核对后重试';
      return send(res, { ok: false, code: error.code && /^[A-Z_]{2,60}$/.test(error.code) ? error.code : 'REQUEST_FAILED', error: safeMessage }, status);
    }
  };
}
module.exports = { createOnlineHandler, FINANCIAL, ADMIN, STAFF_READ, business };
