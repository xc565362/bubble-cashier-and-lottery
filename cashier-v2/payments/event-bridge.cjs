'use strict';
// bubble-event/1 generic event bridge: any marketing event server (lottery,
// raffle, check-in) that publishes a conforming GET /api/manifest can be
// paired here with zero cashier-side code changes. Staff actions authenticate
// with a shared X-Staff-Key header. Connections are keyed by the manifest's
// `service` name and stored with the key encrypted via protect().
//
// Pairing is MVP v1: the staff key is pasted once into the connect form.
// Protocol v1.1 will replace that paste with a one-time pairing-code exchange;
// when that lands, only exchangeCredentials() below changes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROTOCOL = 'bubble-event/1';
const KNOWN_ACTIONS = ['records', 'lookup', 'redeem', 'export'];
const FIELD_TYPES = new Set(['code', 'text', 'enum', 'timestamp']);
// Pairing probe: an all-zero code must produce a clean not-found, which proves
// the key is accepted without touching any real record.
const PROBE_CODE = '0000000000000000';
const MAX_CSV_CHARS = 20 * 1024 * 1024;

function createEventBridge({ directory, protect = value => value, unprotect = value => value, fetchFn = fetch }) {
  const file = path.join(directory, 'event-connections.json');
  let connections = {};
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [id, entry] of Object.entries(saved)) {
        if (entry && typeof entry === 'object' && entry.id === id
          && typeof entry.baseUrl === 'string' && typeof entry.key === 'string'
          && entry.manifest && typeof entry.manifest === 'object' && typeof entry.connectedAt === 'string') {
          connections[id] = entry;
        }
      }
    }
  }

  function validateEndpoint(input) {
    let url;
    try { url = new URL(String(input?.baseUrl || '').trim()); } catch { throw new Error('请输入有效的活动服务地址'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) {
      throw new Error('活动服务地址须为 HTTPS；仅本机服务可使用 http://127.0.0.1');
    }
    const key = String(input?.key || '');
    if (!key || key.length > 200 || /[\u0000-\u001f]/.test(key)) throw new Error('请输入有效的工作人员密钥');
    return { baseUrl: url.href.replace(/\/$/, ''), key };
  }

  function assertManifest(raw) {
    const fail = (detail) => { throw new Error(`活动服务协议清单格式异常（${detail}），请核对服务版本`); };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('响应不是清单对象');
    if (raw.protocol !== PROTOCOL) fail('protocol 必须为 bubble-event/1');
    if (raw.version !== 1) fail('version 必须为 1');
    if (typeof raw.service !== 'string' || !raw.service || raw.service.length > 64 || /[\u0000-\u001f]/.test(raw.service)) fail('service 缺失或格式错误');
    const display = raw.display;
    if (!display || typeof display !== 'object' || Array.isArray(display)) fail('缺少 display');
    if (typeof display.title !== 'string' || !display.title.trim() || display.title.length > 60) fail('display.title 缺失或过长');
    if (!Array.isArray(display.recordFields) || !display.recordFields.length || display.recordFields.length > 12) fail('display.recordFields 须为 1-12 项数组');
    const seenKeys = new Set();
    for (const field of display.recordFields) {
      if (!field || typeof field !== 'object' || Array.isArray(field)) fail('recordFields 项不是对象');
      if (typeof field.key !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(field.key)) fail('recordFields.key 格式错误');
      if (seenKeys.has(field.key)) fail(`recordFields.key 重复：${field.key}`);
      seenKeys.add(field.key);
      if (typeof field.label !== 'string' || !field.label || field.label.length > 20) fail('recordFields.label 缺失或过长');
      if (!FIELD_TYPES.has(field.type)) fail('recordFields.type 须为 code/text/enum/timestamp');
      if (field.type === 'enum' && (!Array.isArray(field.values) || !field.values.length || field.values.length > 20
        || field.values.some((value) => typeof value !== 'string' || !value || value.length > 20))) fail('enum 字段须带 1-20 项字符串 values');
    }
    if (raw.benefits !== undefined) {
      if (!raw.benefits || typeof raw.benefits !== 'object' || Array.isArray(raw.benefits)) fail('benefits 须为对象');
      const entries = Object.entries(raw.benefits);
      if (entries.length > 100) fail('benefits 超过 100 项');
      for (const [prizeId, benefit] of entries) {
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(prizeId)) fail('benefits 键须为奖品 id');
        if (!benefit || typeof benefit !== 'object' || !['physical', 'cash'].includes(benefit.kind)) fail('benefits.kind 须为 physical 或 cash');
        if (benefit.amountCents !== undefined && (!Number.isSafeInteger(benefit.amountCents) || benefit.amountCents < 0 || benefit.amountCents > 100000000)) fail('benefits.amountCents 须为非负整数（分）');
      }
    }
    if (!Array.isArray(raw.actions) || !raw.actions.length || raw.actions.length > KNOWN_ACTIONS.length
      || new Set(raw.actions).size !== raw.actions.length || raw.actions.some((verb) => !KNOWN_ACTIONS.includes(verb))) {
      fail('actions 须为 records/lookup/redeem/export 的不重复子集');
    }
    return raw;
  }

  async function fetchJson(url, { method = 'GET', key, body } = {}) {
    let response;
    try {
      response = await fetchFn(url, {
        method: body ? 'POST' : method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { ...(key ? { 'X-Staff-Key': key } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error('无法连接活动服务，请确认服务已启动且地址正确');
    }
    let result;
    try { result = await response.json(); } catch { throw new Error('活动服务返回格式异常，请核对服务地址'); }
    return { status: response.status, result };
  }

  // v1: credentials are the pasted staff key. v1.1: exchange a one-time
  // pairing code for a key here instead; everything else stays unchanged.
  const exchangeCredentials = (valid) => ({ key: valid.key });

  function persist() {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tmp = file + '.' + crypto.randomUUID() + '.tmp';
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(connections)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  }

  const list = () => ({ connections: Object.values(connections).map((entry) => ({
    id: entry.id, title: entry.manifest.display.title, baseUrl: entry.baseUrl,
    actions: [...entry.manifest.actions], connectedAt: entry.connectedAt,
  })) });

  function connection(id) {
    const entry = connections[String(id || '')];
    if (!entry) throw new Error('活动尚未连接，请先配置服务地址和工作人员密钥');
    return entry;
  }

  function assertSupports(entry, verb) {
    if (!entry.manifest.actions.includes(verb)) throw new Error(`此活动服务不支持${verb === 'export' ? '导出' : verb === 'records' ? '记录查询' : verb}操作`);
  }

  function unwrap(target, { status, result }) {
    if (status === 401 || status === 403) throw new Error('工作人员密钥无效，请重新连接活动服务');
    if (!result || result.ok !== true) throw Object.assign(new Error(result?.message || '活动服务暂不可用，请稍后重试'), { code: result?.code });
    return result.data;
  }

  function assertRecords(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.records) || data.records.length > 100000
      || data.records.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new Error('活动服务记录格式异常，请核对服务版本');
    }
    return data;
  }

  function normalizeCode(input) {
    const code = String(input?.code || '').replace(/\s+/g, '');
    if (!code || code.length > 64 || /[\u0000-\u001f]/.test(code)) throw new Error('核销码格式不正确，请核对后重试');
    return code;
  }

  async function pair(input) {
    const valid = validateEndpoint(input);
    const credentials = exchangeCredentials(valid);
    const manifestResponse = await fetchJson(valid.baseUrl + '/api/manifest');
    if (manifestResponse.status !== 200) throw new Error('活动服务未提供协议清单，请核对服务版本');
    const manifest = assertManifest(manifestResponse.result);
    // Pairing proves auth with a lookup probe, so a connectable service must
    // at least support lookup.
    if (!manifest.actions.includes('lookup')) throw new Error('活动服务协议清单缺少 lookup 动作，请核对服务版本');
    const probe = await fetchJson(valid.baseUrl + '/api/call', {
      key: credentials.key, body: { action: 'lookup', payload: { code: PROBE_CODE } },
    });
    if (probe.status === 401 || probe.status === 403) throw new Error('工作人员密钥无效，请核对后重新输入');
    const cleanNotFound = probe.status === 404
      || (probe.result && probe.result.ok === false && typeof probe.result.code === 'string' && /NOT_FOUND/.test(probe.result.code));
    if (!cleanNotFound && probe.result?.ok !== true) {
      throw new Error(typeof probe.result?.message === 'string' && probe.result.message
        ? `活动服务校验失败：${probe.result.message}` : '活动服务响应异常，无法完成连接');
    }
    const entry = {
      id: manifest.service, baseUrl: valid.baseUrl, key: protect(credentials.key),
      manifest, connectedAt: new Date().toISOString(),
    };
    // One connection per service identity: re-pairing the same service updates
    // its address/key in place and is reported as a replacement, not an add.
    const replaced = Object.hasOwn(connections, entry.id);
    connections[entry.id] = entry;
    persist();
    return { ...list().connections.find((item) => item.id === entry.id), replaced };
  }

  return { async dispatch(action, input = {}) {
    if (action === 'list') return list();
    if (action === 'pair') return pair(input);
    if (action === 'manifest') return JSON.parse(JSON.stringify(connection(input.id).manifest));
    if (action === 'remove') {
      const entry = connection(input.id);
      delete connections[entry.id];
      persist();
      return list();
    }
    if (action === 'records') {
      const entry = connection(input.id);
      assertSupports(entry, 'records');
      return assertRecords(unwrap(entry, await fetchJson(entry.baseUrl + '/api/admin/records', { key: unprotect(entry.key) })));
    }
    if (action === 'lookup' || action === 'redeem') {
      const entry = connection(input.id);
      assertSupports(entry, action);
      return unwrap(entry, await fetchJson(entry.baseUrl + '/api/call', {
        key: unprotect(entry.key), body: { action, payload: { code: normalizeCode(input) } },
      }));
    }
    if (action === 'export-csv') {
      const entry = connection(input.id);
      assertSupports(entry, 'export');
      let response;
      try {
        response = await fetchFn(entry.baseUrl + '/api/admin/records.csv', {
          redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'X-Staff-Key': unprotect(entry.key) },
        });
      } catch {
        throw new Error('无法连接活动服务，请确认服务已启动且地址正确');
      }
      if (response.status === 401 || response.status === 403) throw new Error('工作人员密钥无效，请重新连接活动服务');
      if (!response.ok) throw new Error('活动记录导出失败，请稍后重试');
      const csv = await response.text();
      if (csv.length > MAX_CSV_CHARS) throw new Error('活动记录导出内容过大，请改用活动后台导出');
      return { csv };
    }
    throw new Error('不支持的活动服务操作');
  } };
}
module.exports = { createEventBridge, KNOWN_ACTIONS };
