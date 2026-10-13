const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createService } = require('./service.cjs');
const { paymentMiddleware } = require('./http.cjs');

const directory = process.env.SQB_DATA_DIR || path.join(os.homedir(), '.stall-cashier-sqb-web');
const port = Number(process.env.PORT || 5174);
const service = createService({ directory, exclusive: true });
const middleware = paymentMiddleware(service, { notifications: true });
const root = path.resolve(__dirname, '../dist');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => middleware(req, res, () => {
  let file;
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    file = path.resolve(root, `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`);
  } catch { res.statusCode = 400; res.end('Bad request'); return; }
  if (!file.startsWith(root + path.sep) || req.method !== 'GET' || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; res.end('Not found'); return; }
  res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
  const stream = fs.createReadStream(file);
  stream.on('error', () => { if (!res.headersSent) res.statusCode = 500; res.end(); });
  stream.pipe(res);
}));
server.on('error', (error) => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Set PORT to another port.` : error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Cashier: http://localhost:${port}/`));
