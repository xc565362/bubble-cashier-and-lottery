import fs from 'node:fs';
import { BizError } from './errors.js';

const PRIZE_KINDS = ['cash', 'physical'];

function parseTime(value, field) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  throw new BizError('INVALID_CONFIG', `配置项 ${field} 不是有效时间`, 500);
}

// Validates and normalizes the editable campaign config. Dates may be ISO
// strings or millisecond timestamps; they are normalized to milliseconds.
export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BizError('INVALID_CONFIG', '活动配置格式错误', 500);
  if (typeof raw.id !== 'string' || !raw.id.trim() || raw.id.length > 100) throw new BizError('INVALID_CONFIG', '活动配置缺少 id', 500);
  if (typeof raw.name !== 'string' || !raw.name.trim()) throw new BizError('INVALID_CONFIG', '活动配置缺少 name', 500);
  if (typeof raw.active !== 'boolean') throw new BizError('INVALID_CONFIG', '活动配置 active 必须为布尔值', 500);
  const active = raw.active;
  const startsAt = parseTime(raw.startsAt, 'startsAt');
  const endsAt = parseTime(raw.endsAt, 'endsAt');
  if (endsAt <= startsAt) throw new BizError('INVALID_CONFIG', '活动结束时间必须晚于开始时间', 500);
  const redeemEndsAt = raw.redeemEndsAt == null ? endsAt : parseTime(raw.redeemEndsAt, 'redeemEndsAt');
  if (!Array.isArray(raw.prizes) || !raw.prizes.length) throw new BizError('INVALID_CONFIG', '活动配置缺少 prizes', 500);
  const seen = new Set();
  const prizes = raw.prizes.map((p, i) => {
    const where = `prizes[${i}]`;
    if (!p || typeof p !== 'object') throw new BizError('INVALID_CONFIG', `${where} 格式错误`, 500);
    if (typeof p.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(p.id)) throw new BizError('INVALID_CONFIG', `${where}.id 格式错误`, 500);
    if (seen.has(p.id)) throw new BizError('INVALID_CONFIG', `奖品 id 重复：${p.id}`, 500);
    seen.add(p.id);
    if (typeof p.name !== 'string' || !p.name.trim()) throw new BizError('INVALID_CONFIG', `${where}.name 缺失`, 500);
    const kind = PRIZE_KINDS.includes(p.kind) ? p.kind : null;
    if (!kind) throw new BizError('INVALID_CONFIG', `${where}.kind 必须为 cash 或 physical`, 500);
    if (!Number.isSafeInteger(p.qty) || p.qty < 0) throw new BizError('INVALID_CONFIG', `${where}.qty 必须为非负整数`, 500);
    if (typeof p.probability !== 'number' || !Number.isFinite(p.probability) || p.probability <= 0) {
      throw new BizError('INVALID_CONFIG', `${where}.probability 必须为正数`, 500);
    }
    return {
      id: p.id, name: p.name, shortName: typeof p.shortName === 'string' ? p.shortName : p.name,
      kind, qty: p.qty, probability: p.probability,
      label: typeof p.label === 'string' ? p.label : '', icon: typeof p.icon === 'string' ? p.icon : '',
      ...(kind === 'cash' && Number.isFinite(p.amount) && p.amount > 0 ? { amount: p.amount } : {}),
    };
  });
  return {
    id: raw.id.trim(), name: raw.name, active,
    title: typeof raw.title === 'string' ? raw.title : raw.name,
    venue: typeof raw.venue === 'string' ? raw.venue : '',
    cashTerms: typeof raw.cashTerms === 'string' ? raw.cashTerms : '',
    rulesText: typeof raw.rulesText === 'string' ? raw.rulesText : '',
    startsAt, endsAt, redeemEndsAt, prizes,
  };
}

export function loadConfig(file) {
  return validateConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
}

// Atomic write so a crash mid-save cannot leave a half-written config.
export function saveConfig(file, raw) {
  validateConfig(raw);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return loadConfig(file);
}
