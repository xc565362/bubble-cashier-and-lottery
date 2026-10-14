async function readBody(req, max = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > max) throw new Error('请求过大');
  }
  return Buffer.concat(chunks).toString('utf8');
}

function paymentMiddleware(service, { notifications = false } = {}) {
  return async (req, res, next) => {
    const pathname = req.url.split('?')[0];
    if (pathname === '/api/online/session' && req.method === 'GET') {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ online: false }));
      return;
    }
    if (!pathname.startsWith('/api/sqb/')) return next();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json')) throw new Error('不支持的请求');
      if (pathname === '/api/sqb/notify' && notifications) {
        res.end(await service.notification(await readBody(req)));
        return;
      }
      const host = req.headers.host;
      const origin = req.headers.origin;
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host || '') || origin !== `http://${host}`) throw new Error('支付管理仅允许本机同源访问');
      const action = pathname.slice('/api/sqb/'.length);
      const data = await service.dispatch(action, JSON.parse(await readBody(req, ['export-backup', 'prepare-restore'].includes(action) ? 32 * 1024 * 1024 : undefined)));
      res.end(JSON.stringify({ ok: true, data }));
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
  };
}

module.exports = { paymentMiddleware };
