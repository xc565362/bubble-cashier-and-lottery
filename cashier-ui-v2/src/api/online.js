import { API_BASE } from '../config.js';

let session = null;
let terminalId = null;
let terminalReady = null;
const terminalStorageKey = 'stall_cashier_online_terminal_v1';

function newTerminalId() {
  terminalId = crypto.randomUUID();
  try { window.sessionStorage?.setItem(terminalStorageKey, terminalId); } catch {}
  return terminalId;
}

export function onlineTerminalId() {
  if (terminalId) return terminalId;
  const key = terminalStorageKey;
  try {
    const stored = window.sessionStorage?.getItem(key);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stored || '')) terminalId = stored;
  } catch {}
  if (!terminalId) newTerminalId();
  return terminalId;
}

export function prepareOnlineTerminal() {
  if (terminalReady) return terminalReady;
  terminalReady = (async () => {
    const locks = window.navigator?.locks;
    // A duplicated tab inherits sessionStorage. Claim its identifier before any
    // authenticated work; ordinary reloads retain it, while copies get a new one.
    if (!locks?.request) return newTerminalId();
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = onlineTerminalId();
      const acquired = await new Promise((resolve, reject) => {
        locks.request(`bubble-online-terminal:${candidate}`, { ifAvailable: true }, (lock) => {
          resolve(Boolean(lock));
          if (lock) return new Promise(() => {});
        }).catch(reject);
      });
      if (acquired) return candidate;
      newTerminalId();
    }
    throw new Error('无法建立独立收银终端，请关闭重复页面后重试');
  })();
  return terminalReady;
}

export const getOnlineSession = () => session;
export function setOnlineSession(value) { session = value; }
export const onlineHeaders = () => ({
  'X-Terminal-Id': onlineTerminalId(),
  ...(session?.csrfToken ? { 'X-CSRF-Token': session.csrfToken } : {}),
});

export async function onlineRequest(path, { method = 'GET', body, allowUnauthorized = false, timeoutMs = 20000 } = {}) {
  await prepareOnlineTerminal();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${API_BASE}/online/${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...onlineHeaders() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('云端响应超时，请检查网络后重试'), { status: 0, code: 'TIMEOUT' });
    throw error;
  } finally {
    clearTimeout(timer);
  }
  let data;
  try { data = await response.json(); } catch {
    throw Object.assign(new Error('在线服务返回异常，请重试连接'), { status: response.status });
  }
  if (!response.ok) {
    if (response.status === 401 && !allowUnauthorized) window.dispatchEvent(new Event('online-session-expired'));
    throw Object.assign(new Error(data.error || data.message || '云端操作未完成，请刷新核对'), { status: response.status, code: data.code, data });
  }
  return data;
}

export async function detectOnlineSession() {
  await prepareOnlineTerminal();
  let response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      response = await fetch(`${API_BASE}/online/session`, { credentials: 'same-origin', cache: 'no-store', headers: onlineHeaders(), signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    throw new Error('无法连接云端收银服务，请确认本机服务已启动后重试');
  }
  let data;
  try { data = await response.json(); } catch {
    throw new Error('无法确认在线服务身份，请检查连接后重试');
  }
  if (!data.online || (!response.ok && response.status !== 401)) throw new Error(data.error || '在线服务暂不可用，请重试');
  setOnlineSession(response.ok ? data : null);
  return response.ok ? data : { online: true };
}
