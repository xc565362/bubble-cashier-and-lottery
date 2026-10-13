const net = require('node:net');

function isPublicIPv4(ip) {
  if (typeof ip !== 'string' || net.isIP(ip) !== 4) return false;
  const [a, b, c] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}

function createPublicIpResolver(fetchFn = fetch) {
  let cached;
  let checkedAt = 0;
  const providers = [
    { name: 'ipify', url: 'https://api.ipify.org?format=json', parse: (text) => JSON.parse(text).ip },
    { name: 'AWS', url: 'https://checkip.amazonaws.com/', parse: (text) => text.trim() },
  ];
  return async ({ fresh = false } = {}) => {
    if (!fresh && cached && Date.now() - checkedAt < 30000) return cached;
    // Never fall back to an old address after a fresh lookup fails (the network may have changed).
    cached = undefined;
    const attempts = [];
    for (const provider of providers) {
      try {
        const response = await fetchFn(provider.url, { signal: AbortSignal.timeout(10000), redirect: 'error', cache: 'no-store' });
        if (!response.ok) {
          await response.body?.cancel();
          attempts.push({ provider: provider.name, code: `HTTP_${response.status}` });
          continue;
        }
        const text = await response.text();
        if (text.length > 512) throw new SyntaxError();
        const ip = provider.parse(text);
        if (!isPublicIPv4(ip)) throw new SyntaxError();
        cached = ip; checkedAt = Date.now(); return ip;
      } catch (error) {
        const code = ['TimeoutError', 'AbortError'].includes(error.name) ? 'TIMEOUT'
          : error instanceof SyntaxError ? 'INVALID_RESPONSE' : 'NETWORK_ERROR';
        attempts.push({ provider: provider.name, code });
      }
    }
    const error = new Error('无法检测本机公网 IPv4，两个检测站点均未成功。请检查网络、代理，或切换手机热点后重试；不需要固定 IP。');
    error.code = 'PUBLIC_IP_UNAVAILABLE';
    error.ipChecks = attempts;
    throw error;
  };
}

module.exports = { isPublicIPv4, createPublicIpResolver };
