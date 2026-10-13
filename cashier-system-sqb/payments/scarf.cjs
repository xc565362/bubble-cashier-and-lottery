const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sealCredentials, openCredentials } = require('./credentials.cjs');

const CAMPAIGN_ID = 'scarf-xhs-50-v1';
function createScarfBridge({ directory, protect = value => value, unprotect = value => value, fetchFn = fetch }) {
  const file = path.join(directory, 'scarf-management.json');
  let config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  let busy = false;
  const info = () => ({ configured: !!config, url: config?.url || '', campaignId: CAMPAIGN_ID });
  function validate(input) {
    let url;
    try { url = new URL(input?.url || ''); } catch { throw new Error('请输入有效的头巾活动 HTTPS 管理接口'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/api/scarf-management' ||
        input.campaignId !== CAMPAIGN_ID || !/^[0-9a-f]{64}$/.test(input.key || '')) {
      throw new Error('请填写头巾活动的 HTTPS /api/scarf-management 接口和 64 位管理密钥');
    }
    return { url: url.href, campaignId: CAMPAIGN_ID, key: input.key };
  }
  async function request(action, payload = {}, target = config) {
    if (!target) throw new Error('头巾活动尚未连接，请先配置云端管理接口');
    const body = JSON.stringify({ campaignId: target.campaignId, action, payload });
    const time = String(Date.now()), nonce = crypto.randomUUID();
    const signature = crypto.createHmac('sha256', unprotect(target.key)).update(time + '\n' + nonce + '\n' + body).digest('hex');
    const response = await fetchFn(target.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90000),
      headers: { 'Content-Type': 'application/json', 'X-Lottery-Time': time, 'X-Lottery-Nonce': nonce, 'X-Lottery-Signature': signature }, body });
    let result;
    try { result = await response.json(); } catch { throw new Error('头巾活动接口返回格式异常，请核对地址'); }
    if (!response.ok || result.ok !== true) throw Object.assign(new Error(result.error || '头巾管理请求未完成，请刷新核对后重试'), { code: result.code });
    if (action === 'snapshot' && (result.data?.service !== 'bubble-scarf-management' || result.data.version !== 1 || result.data.campaignId !== CAMPAIGN_ID)) {
      throw new Error('管理接口身份不匹配，请使用山野有约头巾活动接口');
    }
    return result.data;
  }
  async function connect(input) {
    const value = validate(input), target = { ...value, key: protect(value.key) };
    await request('snapshot', {}, target);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = `${file}.${crypto.randomUUID()}.tmp`, fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(target)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file); config = target;
    return info();
  }
  return { async dispatch(action, input = {}) {
    if (action === 'config') return info();
    if (action === 'snapshot') return request('snapshot');
    if (busy) throw new Error('头巾活动操作尚未完成，请勿重复提交');
    busy = true;
    try {
      if (action === 'connect') return await connect(input);
      if (action === 'update') {
        if (input.campaign?.rulesText !== undefined) {
          const current = await request('snapshot');
          if (current.capabilities?.includes('rules-text-v1') !== true) throw new Error('山野有约的云端活动服务尚未支持活动说明，请先升级活动服务和 H5 页面再保存；本次没有修改配置');
        }
        return await request('update', input);
      }
      if (action === 'export-connection') {
        if (!config) throw new Error('尚未连接头巾活动');
        return sealCredentials({ kind: 'scarf-management', ...config, key: unprotect(config.key) }, input.password);
      }
      if (action === 'import-connection') {
        const value = openCredentials(input.bundle, input.password);
        if (value.kind !== 'scarf-management') throw new Error('不是头巾活动管理连接包，请使用对应活动的连接包');
        return await connect(value);
      }
      throw new Error('不支持的头巾活动管理操作');
    } finally { busy = false; }
  } };
}
module.exports = { createScarfBridge, CAMPAIGN_ID };
