'use strict';
// Run as root after inspecting the plan. Existing coupon routes/data are preserved.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const unitName = 'bubble-online.service';
const marker = '    include /etc/nginx/snippets/bubble-online.conf;';
function probe(route, host, port = 5175) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: route, headers: { Host: host }, timeout: 3000 }, response => {
      let body = ''; response.setEncoding('utf8');
      response.on('data', value => { body += value; if (body.length > 8192) request.destroy(new Error('健康检查响应过大')); });
      response.on('end', () => { try { resolve({ status: response.statusCode, value: JSON.parse(body) }); } catch (error) { reject(error); } });
    });
    request.on('timeout', () => request.destroy(new Error('健康检查超时'))); request.on('error', reject);
  });
}
function nginxWithOnline(current) {
  if (current.includes(marker)) return current;
  const anchor = '  location / { return 404; }', index = current.lastIndexOf(anchor);
  if (index < 0 || !current.slice(0, index).includes('listen 443 ssl;') || !current.includes('location /v1/') || !current.includes('127.0.0.1:3910')) throw new Error('现有券中心代理配置已变化，请人工核对后安装');
  return current.slice(0, index) + marker + '\n' + current.slice(index);
}
function nginxSnippet() {
  const settings = `    client_max_body_size 32m;\n    proxy_set_header Host $host;\n    proxy_set_header X-Real-IP $remote_addr;\n    proxy_set_header X-Forwarded-Proto https;\n    proxy_connect_timeout 5s;\n    proxy_read_timeout 120s;\n    proxy_send_timeout 120s;`;
  return `# Bubble online cashier; separate from /v1/ coupon service.\nlocation = /cashier { return 302 /cashier/; }\nlocation ^~ /cashier/ {\n    proxy_pass http://127.0.0.1:5175/;\n${settings}\n}\nlocation ^~ /api/online/ {\n    proxy_pass http://127.0.0.1:5175;\n${settings}\n}\nlocation ^~ /api/sqb/ {\n    proxy_pass http://127.0.0.1:5175;\n${settings}\n}\n`;
}
function unit(release, node) {
  return `[Unit]\nDescription=Bubble online cashier\nAfter=network-online.target\nWants=network-online.target\n[Service]\nType=simple\nUser=bubble-online\nGroup=bubble-online\nWorkingDirectory=${release}\nEnvironmentFile=/etc/bubble-online/service.env\nExecStart=${node} online/server.cjs\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=130\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nPrivateDevices=true\nProtectHome=true\nProtectSystem=strict\nReadWritePaths=/var/lib/bubble-online /etc/bubble-online/keys\nProtectKernelTunables=true\nProtectKernelModules=true\nProtectControlGroups=true\nRestrictSUIDSGID=true\n[Install]\nWantedBy=multi-user.target\n`;
}
function verifyManifest(source) {
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'release-manifest.json'), 'utf8'));
  if (!Array.isArray(manifest.files) || manifest.files.length < 10) throw new Error('发布清单无效');
  for (const entry of manifest.files) {
    if (!/^[A-Za-z0-9_./-]+$/.test(entry.path) || entry.path.includes('..') || path.isAbsolute(entry.path)) throw new Error('发布文件路径无效');
    const file = path.join(source, entry.path), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== entry.sha256) throw new Error('发布文件校验失败');
  }
  return manifest;
}
async function install({ source, origin, apply = false }) {
  if (process.platform !== 'linux') throw new Error('此安装程序仅用于 Linux 服务器');
  const url = new URL(origin); if (url.origin !== origin || url.protocol !== 'https:') throw new Error('需要 HTTPS 入口');
  source = fs.realpathSync(source); const manifest = verifyManifest(source);
  const releaseName = `cashier-online-${manifest.id}`; if (!/^[a-z0-9-]+$/.test(releaseName)) throw new Error('发布编号不正确');
  const release = path.join('/opt/bubble', releaseName);
  const configFile = '/etc/nginx/sites-available/bubble-coupons';
  const original = fs.readFileSync(configFile, 'utf8'), next = nginxWithOnline(original);
  if (!original.includes(`server_name ${url.hostname};`)) throw new Error('HTTPS 站点身份不匹配');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('需要 Node.js 24 或更新版本');
  const plan = { release, origin, login: origin + '/cashier/', service: unitName, couponRoutesPreserved: true, initializesBusinessData: false, createsAccounts: false };
  if (!apply) { console.log(JSON.stringify(plan, null, 2)); return plan; }
  if (process.getuid() !== 0) throw new Error('请使用 sudo 执行安装');
  const run = (file, args) => execFileSync(file, args, { stdio: 'pipe' });
  const backup = `/var/lib/bubble-online-deploy-backups/${Date.now()}`;
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 }); fs.copyFileSync(configFile, path.join(backup, 'bubble-coupons.nginx'));
  const unitFile = `/etc/systemd/system/${unitName}`;
  if (fs.existsSync(unitFile)) fs.copyFileSync(unitFile, path.join(backup, 'bubble-online.service'));
  if (fs.existsSync('/etc/nginx/snippets/bubble-online.conf')) fs.copyFileSync('/etc/nginx/snippets/bubble-online.conf', path.join(backup, 'bubble-online.conf'));
  if (!fs.existsSync(release)) {
    fs.mkdirSync(release, { recursive: true, mode: 0o755 });
    for (const item of manifest.files) { const dest = path.join(release, item.path); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(source, item.path), dest); fs.chmodSync(dest, 0o644); }
    fs.copyFileSync(path.join(source, 'release-manifest.json'), path.join(release, 'release-manifest.json'));
  } else verifyManifest(release);
  try { run('id', ['-u', 'bubble-online']); } catch { run('useradd', ['--system', '--no-create-home', '--shell', '/usr/sbin/nologin', 'bubble-online']); }
  fs.mkdirSync('/etc/bubble-online', { recursive: true, mode: 0o750 });
  run('chown', ['root:bubble-online', '/etc/bubble-online']); fs.chmodSync('/etc/bubble-online', 0o750);
  for (const dir of ['/var/lib/bubble-online', '/etc/bubble-online/keys']) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); run('chown', ['bubble-online:bubble-online', dir]); fs.chmodSync(dir, 0o700); }
  const setupSource = path.join(source, 'setup-grant.json'), setupTarget = '/var/lib/bubble-online/setup-grant.json';
  if (!fs.existsSync('/var/lib/bubble-online/accounts.sqlite') && fs.existsSync(setupSource) && !fs.existsSync(setupTarget)) {
    fs.copyFileSync(setupSource, setupTarget, fs.constants.COPYFILE_EXCL); fs.chmodSync(setupTarget, 0o600); run('chown', ['bubble-online:bubble-online', setupTarget]);
  }
  const envFile = '/etc/bubble-online/service.env';
  if (fs.existsSync(envFile)) fs.copyFileSync(envFile, path.join(backup, 'service.env'));
  fs.writeFileSync(envFile, `PUBLIC_ORIGIN=${origin}\nPORT=5175\nHOST=127.0.0.1\nBUBBLE_ONLINE_DATA_DIR=/var/lib/bubble-online\nBUBBLE_ONLINE_KEY_FILE=/etc/bubble-online/keys/config.key\nBUBBLE_ONLINE_SETUP_FILE=${setupTarget}\n`, { mode: 0o600 });
  fs.chmodSync(envFile, 0o600);
  fs.writeFileSync(unitFile, unit(release, process.execPath), { mode: 0o644 });
  let proxyChanged = false;
  try {
    run('systemctl', ['daemon-reload']); run('systemctl', ['enable', unitName]); run('systemctl', ['restart', unitName]);
    let ready = false;
    for (let i = 0; i < 15; i++) {
      try { const response = await probe('/healthz', url.host); if (response.status === 200 && response.value.service === 'bubble-online-cashier') { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error('在线服务启动检查失败');
    const denied = await probe('/api/online/ledger', url.host);
    if (denied.status !== 401) throw new Error('未登录访问检查失败');
    fs.mkdirSync('/etc/nginx/snippets', { recursive: true });
    fs.writeFileSync('/etc/nginx/snippets/bubble-online.conf', nginxSnippet(), { mode: 0o644 });
    fs.writeFileSync(configFile, next, { mode: 0o644 }); proxyChanged = true;
    run('nginx', ['-t']); run('systemctl', ['reload', 'nginx']);
  } catch (error) {
    if (proxyChanged) { fs.writeFileSync(configFile, original); const prior = path.join(backup, 'bubble-online.conf'); if (fs.existsSync(prior)) fs.copyFileSync(prior, '/etc/nginx/snippets/bubble-online.conf'); run('nginx', ['-t']); run('systemctl', ['reload', 'nginx']); }
    const priorUnit = path.join(backup, 'bubble-online.service');
    if (fs.existsSync(priorUnit)) { fs.copyFileSync(priorUnit, unitFile); if (fs.existsSync(path.join(backup, 'service.env'))) fs.copyFileSync(path.join(backup, 'service.env'), envFile); run('systemctl', ['daemon-reload']); run('systemctl', ['restart', unitName]); }
    else run('systemctl', ['stop', unitName]);
    throw error;
  }
  console.log(JSON.stringify({ ...plan, status: 'installed', backup }, null, 2)); return plan;
}
if (require.main === module) {
  const args = process.argv.slice(2), at = name => args[args.indexOf(name) + 1];
  install({ source: at('--source'), origin: at('--origin'), apply: args.includes('--apply') }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { nginxWithOnline, nginxSnippet, unit, verifyManifest, install, probe };
