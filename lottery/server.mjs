import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, syncCampaign, createSession, findSession } from './src/db.js';
import { loadConfig, saveConfig } from './src/config.js';
import { code2session } from './src/wechat.js';
import { BizError } from './src/errors.js';
import { newToken, hashToken, isStaffKey, maskOpenid } from './src/auth.js';
import * as lottery from './src/lottery.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const BODY_LIMIT = 16 * 1024;
const SESSION_TTL = 24 * 60 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new BizError('BODY_TOO_LARGE', '请求体过大', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new BizError('INVALID_JSON', '请求格式错误', 400);
  }
}

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(404).end();
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(PUBLIC_DIR, 'index.html');
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  fs.createReadStream(file).pipe(res);
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export async function createApp({ configPath, env = process.env } = {}) {
  for (const key of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
    if (!env[key]) throw new Error(`缺少数据库配置 ${key}，请在 .env.local 中填写`);
  }
  const pool = createPool(env);
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    await pool.end().catch(() => {});
    throw new Error(`数据库连接失败（${error.code || error.message}），请检查 .env.local 中的 DB_* 配置`);
  }
  const configFile = configPath || path.join(ROOT, 'campaign.config.json');
  let config = loadConfig(configFile);
  await syncCampaign(pool, config);

  const staffKey = env.STAFF_KEY || '';
  const staffOpenids = String(env.STAFF_OPENIDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const wx = { appid: env.WX_APPID || '', secret: env.WX_SECRET || '', mock: env.WX_MOCK === '1' || !env.WX_SECRET };

  const sessionOpenid = async req => {
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
    if (!match) return null;
    return findSession(pool, hashToken(match[1]), Date.now());
  };
  const hasStaffKey = req => isStaffKey(req.headers['x-staff-key'], staffKey);
  const isStaff = (req, openid) => hasStaffKey(req) || (openid && staffOpenids.includes(openid));
  // 401 when no credential was presented at all, 403 when one was rejected.
  const requireStaffKey = (req, res) => {
    if (hasStaffKey(req)) return true;
    const presented = typeof req.headers['x-staff-key'] === 'string' && req.headers['x-staff-key'].length > 0;
    sendJson(res, presented ? 403 : 401, { ok: false, code: 'FORBIDDEN', message: '无效的工作人员密钥' });
    return false;
  };

  async function handleSession(req, res) {
    const body = await readJson(req);
    if (body && typeof body.ticket === 'string') {
      throw new BizError('UNSUPPORTED_CREDENTIAL', '请使用微信扫码进入活动', 400);
    }
    if (!body || typeof body.code !== 'string' || body.code.length < 1 || body.code.length > 256) {
      throw new BizError('INVALID_CREDENTIAL', '登录凭证无效，请返回小程序重新进入', 400);
    }
    const { openid } = await code2session(body.code, wx);
    const now = Date.now();
    const token = newToken();
    const expiresAt = now + SESSION_TTL;
    await createSession(pool, hashToken(token), openid, now, expiresAt);
    sendJson(res, 200, { ok: true, data: { token, expiresAt } });
  }

  async function handleCall(req, res) {
    const body = await readJson(req);
    const action = typeof body.action === 'string' ? body.action : '';
    const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
    const openid = await sessionOpenid(req);
    const now = Date.now();

    if (action === 'state' || action === 'draw' || action === 'identity') {
      if (!openid) throw new BizError('AUTH_REQUIRED', '登录已失效，请返回小程序重新进入活动', 401);
      if (action === 'state') return sendJson(res, 200, { ok: true, data: await lottery.getState(pool, config, openid, now) });
      if (action === 'draw') return sendJson(res, 200, { ok: true, data: await lottery.draw(pool, config, openid, now) });
      return sendJson(res, 200, { ok: true, data: { openId: openid, isAdmin: !!isStaff(req, openid) } });
    }

    if (action === 'lookup' || action === 'redeem') {
      // Cashier integration: these two actions also work without a WeChat
      // session when a valid X-Staff-Key header is presented.
      if (!isStaff(req, openid)) {
        // 401 when nothing was presented, 403 when a session/key was rejected.
        const keyPresented = typeof req.headers['x-staff-key'] === 'string' && req.headers['x-staff-key'].length > 0;
        if (openid || keyPresented) throw new BizError('FORBIDDEN', '当前账号没有核销权限', 403);
        throw new BizError('AUTH_REQUIRED', '需要工作人员密钥或已授权的工作人员账号', 401);
      }
      const staffId = openid ? 'wx:' + maskOpenid(openid) : 'staff-key';
      const data = action === 'lookup'
        ? await lottery.lookup(pool, config, payload.code, now)
        : await lottery.redeem(pool, config, payload.code, staffId, now);
      return sendJson(res, 200, { ok: true, data });
    }

    throw new BizError('INVALID_ACTION', '不支持的操作', 400);
  }

  async function handleAdminRecords(req, res) {
    if (!requireStaffKey(req, res)) return;
    sendJson(res, 200, { ok: true, data: await lottery.listRecords(pool, config) });
  }

  async function handleAdminCsv(req, res) {
    if (!requireStaffKey(req, res)) return;
    const { records } = await lottery.listRecords(pool, config);
    const fmt = ms => (ms ? new Date(ms).toISOString() : '');
    const lines = ['code,prize,status,openid,createdAt,redeemedAt,redeemedBy'];
    for (const r of records) {
      lines.push([r.code, r.prize, r.status, r.openid, fmt(r.createdAt), fmt(r.redeemedAt), r.redeemedBy].map(csvEscape).join(','));
    }
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('﻿' + lines.join('\r\n') + '\r\n');
  }

  async function handleAdminConfig(req, res) {
    if (!requireStaffKey(req, res)) return;
    const patch = await readJson(req);
    const allowed = ['active', 'startsAt', 'endsAt', 'redeemEndsAt', 'name', 'title', 'venue', 'cashTerms', 'rulesText', 'prizes'];
    const current = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    for (const key of allowed) {
      if (Object.hasOwn(patch, key)) current[key] = patch[key];
    }
    config = saveConfig(configFile, current);
    await syncCampaign(pool, config);
    sendJson(res, 200, { ok: true, data: { campaign: (await lottery.getState(pool, config, '__admin__')).campaign } });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      // Accept both /api/* (direct/local) and /huodong-api/* (production nginx prefix).
      const pathname = url.pathname.replace(/^\/huodong-api(?=\/)/, '/api');
      if (pathname === '/api/session' && req.method === 'POST') return await handleSession(req, res);
      if (pathname === '/api/call' && req.method === 'POST') return await handleCall(req, res);
      if (pathname === '/api/admin/records' && req.method === 'GET') return await handleAdminRecords(req, res);
      if (pathname === '/api/admin/records.csv' && req.method === 'GET') return await handleAdminCsv(req, res);
      if (pathname === '/api/admin/config' && req.method === 'POST') return await handleAdminConfig(req, res);
      if (pathname.startsWith('/api/')) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: '接口不存在' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: '接口不存在' });
      serveStatic(req, res, pathname === '/' ? '/index.html' : pathname);
    } catch (error) {
      if (error instanceof BizError) {
        sendJson(res, error.status, { ok: false, code: error.code, message: error.message });
      } else {
        console.error('request failed:', error);
        if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'INTERNAL', message: '服务暂不可用，请稍后重试' });
        else res.end();
      }
    }
  });

  return { server, pool, getConfig: () => config };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || 8787;
  try {
    const { server } = await createApp();
    server.listen(port, () => {
      const mock = process.env.WX_MOCK === '1' || !process.env.WX_SECRET;
      console.log(`bubble lottery listening on http://localhost:${port} (wechat ${mock ? 'MOCK' : 'real'} mode)`);
    });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
