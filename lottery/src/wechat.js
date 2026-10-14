import crypto from 'node:crypto';
import { BizError } from './errors.js';

// Mock mode (WX_MOCK=1 or missing credentials): each distinct code maps to a
// stable distinct local user, without calling WeChat.
export async function code2session(code, { appid, secret, mock, fetchImpl = fetch } = {}) {
  if (mock) {
    return { openid: 'mock_' + crypto.createHash('sha256').update(String(code)).digest('hex').slice(0, 16) };
  }
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.searchParams.set('appid', appid);
  url.searchParams.set('secret', secret);
  url.searchParams.set('js_code', code);
  url.searchParams.set('grant_type', 'authorization_code');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let data;
  try {
    const response = await fetchImpl(url, { redirect: 'error', signal: controller.signal });
    data = await response.json();
  } catch {
    throw new BizError('WX_LOGIN_FAILED', '微信登录暂不可用，请稍后重试', 502);
  } finally {
    clearTimeout(timeout);
  }
  // The response may carry session_key; never log it, only forward the openid.
  if (!data || typeof data.openid !== 'string' || !data.openid) {
    throw new BizError('WX_LOGIN_FAILED', '微信登录失败，请返回小程序重新进入', 502);
  }
  return { openid: data.openid };
}
