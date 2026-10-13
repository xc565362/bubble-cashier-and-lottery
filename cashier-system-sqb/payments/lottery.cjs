const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sealCredentials, openCredentials } = require('./credentials.cjs');

function createLotteryBridge({ directory, protect = value => value, unprotect = value => value, fetchFn = fetch }) {
  const file = path.join(directory, 'lottery-management.json');
  let config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  let busy = false;
  function validate(input) {
    const url = new URL(input?.url || '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname === '/' ||
      !/^[0-9a-f]{64}$/.test(input.key || '') || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.campaignId || '')) throw new Error('请输入有效的 HTTPS 管理接口、活动编号和 64 位管理密钥');
    return { url: url.href, campaignId: input.campaignId, key: input.key };
  }
  const info = () => ({ configured: !!config, url: config?.url || '', campaignId: config?.campaignId || '' });
  async function request(action, payload = {}, target = config) {
    if (!target) throw new Error('抽奖管理尚未连接，请配置云端管理接口');
    const body = JSON.stringify({ campaignId: target.campaignId, action, payload });
    const time = String(Date.now()); const nonce = crypto.randomUUID();
    const signature = crypto.createHmac('sha256', unprotect(target.key)).update(time + '\n' + nonce + '\n' + body).digest('hex');
    const response = await fetchFn(target.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90000),
      headers: { 'Content-Type': 'application/json', 'X-Lottery-Time': time, 'X-Lottery-Nonce': nonce, 'X-Lottery-Signature': signature }, body });
    let result;
    try { result = await response.json(); } catch { throw new Error('管理接口返回格式异常，请核对地址'); }
    if (!response.ok || result.ok !== true) throw Object.assign(new Error(result.error || '云端管理请求未完成，请刷新核对后重试'), { code: result.code });
    if (action === 'snapshot' && (result.data?.service !== 'bubble-lottery-management' || result.data.version !== 1 || result.data.campaignId !== target.campaignId)) throw new Error('云端管理活动身份不匹配');
    return result.data;
  }
  async function connect(input) {
    const valid = validate(input);
    const target = { ...valid, key: protect(valid.key) };
    await request('snapshot', {}, target);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tmp = file + '.' + crypto.randomUUID() + '.tmp';
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(target)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file); config = target;
    return info();
  }
  return { async dispatch(action, input = {}) {
    if (action === 'config') return info();
    if (action === 'snapshot') return request(action);
    if (busy) throw new Error('抽奖管理操作尚未完成，请勿重复提交');
    busy = true;
    try {
      if (action === 'connect') return await connect(input);
      if (action === 'export-connection') {
        if (!config) throw new Error('尚未连接抽奖管理');
        return sealCredentials({ kind: 'lottery-management', ...config, key: unprotect(config.key) }, input.password);
      }
      if (action === 'import-connection') {
        const value = openCredentials(input.bundle, input.password);
        if (value.kind !== 'lottery-management') throw new Error('不是抽奖管理连接包');
        return await connect(value);
      }
      if (['update', 'increase-capacity'].includes(action)) {
        if (action === 'update' && input.catalog !== undefined) {
          const current = await request('snapshot');
          if (current.capabilities?.includes('lottery-catalog-v1') !== true) throw new Error('云端抽奖服务尚未支持完整奖项管理，请先升级后再保存；本次没有修改奖项');
        }
        return await request(action, input);
      }
      throw new Error('不支持的抽奖管理操作');
    } finally { busy = false; }
  } };
}
module.exports = { createLotteryBridge };
