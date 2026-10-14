'use strict';
// Bridge to the self-hosted lottery server (lottery/server.mjs): staff actions
// authenticate with a shared X-Staff-Key header, no HMAC and no session.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createLotteryLocalBridge({ directory, protect = value => value, unprotect = value => value, fetchFn = fetch }) {
  const file = path.join(directory, 'lottery-local.json');
  let config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;

  function validate(input) {
    let url;
    try { url = new URL(String(input?.baseUrl || '').trim()); } catch { throw new Error('请输入有效的抽奖服务地址'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) {
      throw new Error('抽奖服务地址须为 HTTPS；仅本机服务可使用 http://127.0.0.1');
    }
    const key = String(input?.key || '');
    if (!key || key.length > 200 || /[\u0000-\u001f]/.test(key)) throw new Error('请输入有效的工作人员密钥');
    return { baseUrl: url.href.replace(/\/$/, ''), key };
  }

  const info = () => ({ configured: !!config, baseUrl: config?.baseUrl || '' });

  async function request(pathname, { method = 'GET', body } = {}, target = config) {
    if (!target) throw new Error('抽奖服务尚未连接，请先配置服务地址和工作人员密钥');
    let response;
    try {
      response = await fetchFn(target.baseUrl + pathname, {
        method: body ? 'POST' : method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'X-Staff-Key': unprotect(target.key), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error('无法连接抽奖服务，请确认服务已启动（默认 http://127.0.0.1:8787）');
    }
    let result;
    try { result = await response.json(); } catch { throw new Error('抽奖服务返回格式异常，请核对服务地址'); }
    if (response.status === 401 || response.status === 403) throw new Error('工作人员密钥无效，请重新配置抽奖服务连接');
    if (!response.ok || result.ok !== true) throw Object.assign(new Error(result.message || '抽奖服务暂不可用，请稍后重试'), { code: result.code });
    return result.data;
  }

  function assertRecords(data) {
    const summary = data?.summary;
    if (!summary || !Number.isSafeInteger(summary.entries) || !Number.isSafeInteger(summary.pending) ||
        !Number.isSafeInteger(summary.redeemed) || !Number.isSafeInteger(summary.stockTotal) ||
        !Number.isSafeInteger(summary.stockRemaining) || !Array.isArray(data.records) || data.records.length > 100000 ||
        data.records.some(row => !row || typeof row.code !== 'string' || typeof row.prize !== 'string' ||
          typeof row.status !== 'string' || typeof row.openid !== 'string')) {
      throw new Error('抽奖服务记录格式异常，请核对服务版本');
    }
    return data;
  }

  function normalizeCode(input) {
    const code = String(input?.code || '').replace(/\s+/g, '').toUpperCase();
    if (!/^[0-9A-F]{16}$/.test(code)) throw new Error('核销码格式不正确，请核对后重试');
    return code;
  }

  async function connect(input) {
    const valid = validate(input);
    const target = { baseUrl: valid.baseUrl, key: protect(valid.key) };
    await request('/api/admin/records', {}, target); // verify address + key before saving
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tmp = file + '.' + crypto.randomUUID() + '.tmp';
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(target)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file); config = target;
    return info();
  }

  return { async dispatch(action, input = {}) {
    if (action === 'config') return info();
    if (action === 'records') return assertRecords(await request('/api/admin/records'));
    if (action === 'export-csv') {
      if (!config) throw new Error('抽奖服务尚未连接，请先配置服务地址和工作人员密钥');
      const response = await fetchFn(config.baseUrl + '/api/admin/records.csv', { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'X-Staff-Key': unprotect(config.key) } })
        .catch(() => { throw new Error('无法连接抽奖服务，请确认服务已启动（默认 http://127.0.0.1:8787）'); });
      if (!response.ok) throw new Error('抽奖记录导出失败，请稍后重试');
      return { csv: await response.text() };
    }
    if (action === 'lookup') return request('/api/call', { body: { action: 'lookup', payload: { code: normalizeCode(input) } } });
    if (action === 'redeem') return request('/api/call', { body: { action: 'redeem', payload: { code: normalizeCode(input) } } });
    if (action === 'connect') return connect(input);
    throw new Error('不支持的抽奖服务操作');
  } };
}
module.exports = { createLotteryLocalBridge };
