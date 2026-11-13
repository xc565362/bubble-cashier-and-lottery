import { API_BASE } from '../config.js';
import { getOnlineSession, onlineHeaders } from './online.js';

export async function sqbCall(action, payload = {}, { timeoutMs = 20000 } = {}) {
  let result;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${API_BASE}/sqb/${action}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...onlineHeaders() },
      body: JSON.stringify(payload),
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('支付服务响应超时，请检查网络后重试'), { status: 0, code: 'TIMEOUT' });
    throw error;
  } finally {
    clearTimeout(timer);
  }
  try { result = await response.json(); } catch {
    throw new Error('支付服务未启动，请使用新版桌面软件或本机支付服务');
  }
  if (response.status === 401 && getOnlineSession()) window.dispatchEvent(new Event('online-session-expired'));
  if (!response.ok) throw Object.assign(new Error(result.error || '支付服务暂不可用'), { code: result.code, status: response.status });
  if (!result.ok) throw Object.assign(new Error(result.error || '支付服务暂不可用'), { code: result.code });
  return result.data;
}

export async function enablePaymentNotifications() {
  if (!('Notification' in window) || !window.isSecureContext) return '当前浏览器不支持系统通知，收款结果仍会在页面显示';
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  return permission === 'granted' ? '已允许收款通知' : '通知未授权，请在浏览器网站设置中允许通知';
}

export async function notifyConfirmedPayment(id) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return false;
    const notice = await sqbCall('claim-payment-notification', { id });
    if (!notice) return true;
    const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (registration?.active) await registration.showNotification(notice.title, { body: notice.body, tag: notice.id, silent: false });
    else new Notification(notice.title, { body: notice.body, tag: notice.id, silent: false });
    return true;
  } catch { return false; }
}
