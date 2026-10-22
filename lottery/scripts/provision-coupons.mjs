#!/usr/bin/env node
// Provision the coupon center for this lottery campaign, zero-config style:
//   COUPON_CENTER_URL=https://coupon-center.example.com COUPON_ADMIN_TOKEN=<admin token> \
//     node scripts/provision-coupons.mjs [--config campaign.config.json] [--bridge .coupon-bridge.json]
//
// For every cash prize in the campaign config this script idempotently:
//   1. creates the matching coupon campaign (POST /v1/campaigns/lottery-provision,
//      one campaign per face value; the center pins face value/threshold by
//      entitlement fingerprint, so re-runs return the existing campaign),
//   2. creates a lottery-role API key scoped to that campaign (POST /v1/keys;
//      a deterministic requestId makes re-runs return the same key),
//   3. verifies each key against the center,
// and writes .coupon-bridge.json (chmod 600), which server.mjs loads when the
// COUPON_* env vars are absent. Tokens are never printed to the terminal.
//
// Optional: COUPON_MINIMUM_CENTS=<n> sets a default minimum spend (cents) for
// cash prizes that do not carry their own `minimumCents` in the config.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { validateCouponCenterUrl } from '../src/coupons.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function fail(message) {
  console.error(`provision-coupons: ${message}`);
  process.exit(1);
}

const configPath = argValue('--config') || path.join(ROOT, 'campaign.config.json');
const bridgePath = argValue('--bridge') || path.join(ROOT, '.coupon-bridge.json');
const url = process.env.COUPON_CENTER_URL ? validateCouponCenterUrl(process.env.COUPON_CENTER_URL) : null;
const adminToken = process.env.COUPON_ADMIN_TOKEN || '';
if (!url) fail('缺少 COUPON_CENTER_URL（生产环境必须是 HTTPS 源站）');
if (!/^[A-Za-z0-9_.-]{32,300}$/.test(adminToken)) fail('缺少有效的 COUPON_ADMIN_TOKEN（至少 32 位）');
const defaultMinimumCents = process.env.COUPON_MINIMUM_CENTS === undefined || process.env.COUPON_MINIMUM_CENTS === ''
  ? null : Number(process.env.COUPON_MINIMUM_CENTS);
if (defaultMinimumCents !== null && (!Number.isSafeInteger(defaultMinimumCents) || defaultMinimumCents < 0 || defaultMinimumCents > 1000000)) {
  fail('COUPON_MINIMUM_CENTS 必须是 0 至 1000000 的整数（单位：分）');
}

const config = loadConfig(configPath);
const cashPrizes = config.prizes.filter(p => p.kind === 'cash' && Number.isFinite(p.amount) && p.amount > 0);
if (!cashPrizes.length) fail('活动配置中没有现金奖项（kind=cash 且 amount>0），无需接入券中心');
if (config.redeemEndsAt <= Date.now()) fail('活动核销截止时间已过，不能准备券活动');

async function call(token, method, route, input) {
  const response = await fetch(url + route, {
    method, redirect: 'error', signal: AbortSignal.timeout(12000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
  });
  let body;
  try { body = await response.json(); } catch { fail(`券中心响应不是 JSON（${route}，HTTP ${response.status}）`); }
  if (!response.ok || !body?.ok) fail(`券中心拒绝了 ${route}：${body?.code || response.status} ${body?.error || ''}`);
  return body.data;
}

const info = await call(adminToken, 'GET', '/v1/info');
if (info.service !== 'stall-coupon-center' || info.role !== 'admin') fail('COUPON_ADMIN_TOKEN 不是兼容券中心的管理凭证');
if (!info.capabilities?.includes('lottery-catalog-v1')) fail('券中心不支持 lottery-catalog-v1，请先升级券中心');
console.log(`券中心 ${info.centerId}（${info.environment}）已连接，为活动 ${config.id} 准备 ${cashPrizes.length} 个现金奖项…`);
if (info.environment !== 'production') console.error('警告：券中心不是 production 环境，正式收款将拒绝这些券');

const startsAt = new Date(config.startsAt).toISOString();
const expiresAt = new Date(config.redeemEndsAt).toISOString();
const grants = {};
for (const prize of cashPrizes) {
  const minimumCents = prize.minimumCents ?? defaultMinimumCents ?? 0;
  const { campaign } = await call(adminToken, 'POST', '/v1/campaigns/lottery-provision', {
    requestId: `lottery-provision:${config.id}:${prize.id}`,
    campaignId: config.id,
    prize: { id: prize.id, kind: 'cash', name: prize.name, amount: prize.amount, minimumCents },
    quota: prize.qty, startsAt, expiresAt,
  });
  const key = await call(adminToken, 'POST', '/v1/keys', {
    requestId: `lottery-key:${campaign.id}`, role: 'lottery', campaignId: campaign.id,
    name: `bubble-lottery ${config.id} ${prize.id}`,
  });
  const visible = await call(key.token, 'GET', '/v1/campaigns');
  const check = (Array.isArray(visible) ? visible : []).find(item => item.id === campaign.id);
  if (!check || check.amountCents !== Math.round(prize.amount * 100) || (check.minimumCents ?? 0) !== minimumCents) {
    fail(`奖项 ${prize.id} 的券活动 ${campaign.id} 面额或门槛核验失败，请核对券中心数据`);
  }
  grants[prize.id] = { campaignId: campaign.id, keyId: key.id, token: key.token };
  console.log(`  ${prize.id}：券活动 ${campaign.id}（面额 ${(check.amountCents / 100).toFixed(2)} 元，上限 ${campaign.quota} 张），授权密钥 ${key.id}`);
}

const bridge = {
  version: 1, url, lotteryCampaignId: config.id,
  centerId: info.centerId, environment: info.environment,
  grants, provisionedAt: new Date().toISOString(),
};
const tmp = `${bridgePath}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(bridge, null, 2) + '\n', { mode: 0o600 });
fs.renameSync(tmp, bridgePath);
fs.chmodSync(bridgePath, 0o600);
console.log(`已写入 ${bridgePath}（权限 600，含 ${Object.keys(grants).length} 个奖项授权；内容含密钥，请勿提交或外传）`);
console.log('完成：启动或重启 lottery 服务后，现金奖项将自动发放券中心抵扣券。');
