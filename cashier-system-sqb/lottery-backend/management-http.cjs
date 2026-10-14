const crypto = require('node:crypto');
const { createPoolManagement } = require('./pool-management.cjs');
const { createManagementCenter } = require('./management-center.cjs');
function createManagementHttp({ store, campaign, prizes, key, centerConfig, now = Date.now, fetchFn = fetch }) {
  const center = createManagementCenter({ config: centerConfig, prizes, campaign, fetchFn });
  const pool = createPoolManagement({ store, campaign, prizes, now, getCenter: center.read,provisionCatalog:center.provision });
  const records = require('./draw-records.cjs').createDrawRecords({readPage:store.readEntries,campaignId:campaign.id,key,center,now});
  const response = (statusCode, value) => ({ statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(value) });
  return async event => {
    let phase = 'authentication';
    try {
      const headers = {};
      for(const [name,value] of Object.entries(event.headers||{})) {
        const lower=name.toLowerCase();
        if(typeof value!=='string'||Object.hasOwn(headers,lower))return response(401,{ok:false,error:'抽奖管理身份验证失败'});
        headers[lower]=value;
      }
      const body = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body;
      const time = headers['x-lottery-time'];
      const nonce = headers['x-lottery-nonce'];
      const signed = headers['x-lottery-signature'];
      if (!/^[0-9a-f]{64}$/.test(key || '') || event.httpMethod !== 'POST' || Object.hasOwn(headers,'origin') ||
        !String(headers['content-type']).startsWith('application/json') || typeof body !== 'string' || Buffer.byteLength(body) > 131072 ||
        !/^\d{13}$/.test(time || '') || Math.abs(now() - Number(time)) > 120000 || !/^[a-zA-Z0-9_-]{16,80}$/.test(nonce || '') ||
        !/^[0-9a-f]{64}$/.test(signed || '')) return response(401, { ok: false, error: '抽奖管理身份验证失败' });
      const expected = crypto.createHmac('sha256', key).update(time + '\n' + nonce + '\n' + body).digest();
      if (!crypto.timingSafeEqual(expected, Buffer.from(signed, 'hex'))) return response(401, { ok: false, error: '抽奖管理身份验证失败' });
      const input = JSON.parse(body);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k=>!['campaignId','action','payload'].includes(k)) || !['snapshot', 'update', 'increase-capacity', 'records'].includes(input.action) || input.campaignId !== campaign.id) return response(400, { ok: false, error: '管理操作或活动不匹配' });
      phase = 'replay-check';
      await store.transaction(async tx => {
        const id = 'lottery-admin:' + nonce;
        if (await tx.get('gatewayNonces', id)) throw Object.assign(new Error('请重新发起管理请求'), { code: 'REPLAY' });
        await tx.set('gatewayNonces', id, { at: now(), expiresAt: now() + 300000 });
        return true;
      });
      phase = input.action;
      let data;
      if (input.action === 'snapshot') {
        data = await pool.snapshot();
        try { data.center = await center.counts(data.center); } catch { data.centerError = '券中心统计暂时不可用，已核销数量不作零处理'; }
      } else if (input.action === 'records') data = await records(input.payload);
      else if (input.action === 'update') data = await pool.update(input.payload);
      else {
        const status = await pool.snapshot();
        if (status.enabled) throw Object.assign(new Error('请先暂停抽奖，再补充券发放上限'), { code: 'POOL_ACTIVE' });
        data = await center.increase(input.payload || {},status.catalog);
      }
      return response(200, { ok: true, data });
    } catch (error) {
      console.error('lottery management error', { phase, code: String(error.code || error.errCode || error.name),
        message: String(error.message || '').replace(/[A-Za-z0-9_=-]{24,}/g, '[redacted]').slice(0, 240) });
      const known = ['INVALID_RECORD_QUERY','RECORDS_UNAVAILABLE','INVALID_CONFIG', 'CATALOG_UNSUPPORTED','REVISION_CONFLICT', 'POOL_ACTIVE', 'POOL_CORRUPT', 'POOL_NOT_READY', 'CENTER_CAPACITY', 'SOLD_OUT', 'FIXED_STOCK_EMPTY', 'REPLAY'].includes(error.code);
      return response(400, { ok: false, code: error.code || 'MANAGEMENT_UNAVAILABLE', error: known ? error.message : '抽奖管理请求未完成，请检查云端配置与券中心状态后重试' });
    }
  };
}
module.exports = { createManagementHttp };
