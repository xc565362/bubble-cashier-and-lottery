'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const source = path.resolve(__dirname, '../..'), output = __dirname;
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function copy(from, to) {
  const stat = fs.lstatSync(from);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Release accepts regular files only');
  fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
}
function buildPackage({ releaseDate } = {}) {
  if (!/^20\d{6}$/.test(releaseDate || '')) throw new Error('Pass an explicit release date as --date YYYYMMDD');
  const built = path.join(output, 'online-dist');
  const index = fs.readFileSync(path.join(built, 'index.html'), 'utf8');
  if (!index.includes('src="/cashier/assets/') || !index.includes('href="/cashier/assets/')) throw new Error('Build with --base /cashier/ before packaging');
  const stage = path.join(output, `stage-${Date.now()}`); fs.mkdirSync(stage);
  for (const folder of ['online', 'payments', 'coupons']) {
    for (const name of fs.readdirSync(path.join(source, folder))) {
      if (!name.endsWith('.cjs') || ['install-linux.cjs', 'bootstrap.cjs', 'provision-connections.cjs'].includes(name)) continue;
      copy(path.join(source, folder, name), path.join(stage, folder, name));
    }
  }
  for (const name of ['orderLogic.js', 'afterSales.js']) copy(path.join(source, 'src', name), path.join(stage, 'src', name));
  for (const name of ['index.js', 'package.json', 'LICENSE']) copy(path.join(source, 'node_modules/json-source-map', name), path.join(stage, 'node_modules/json-source-map', name));
  function copyTree(from, to) { for (const entry of fs.readdirSync(from, { withFileTypes: true })) { if (entry.isDirectory()) copyTree(path.join(from, entry.name), path.join(to, entry.name)); else copy(path.join(from, entry.name), path.join(to, entry.name)); } }
  copyTree(built, path.join(stage, 'dist'));
  copy(path.join(output, 'update-linux.cjs'), path.join(stage, 'update-linux.cjs'));
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'bubble-online-cashier', version: '0.8.1', private: true, type: 'module', dependencies: { 'json-source-map': '0.6.1' } }, null, 2));
  const files = [];
  function walk(directory) { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) walk(file); else files.push({ path: path.relative(stage, file).replaceAll('\\', '/'), sha256: digest(file), bytes: fs.statSync(file).size }); } }
  walk(stage); files.sort((a, b) => a.path.localeCompare(b.path));
  const id = releaseDate + '-' + crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 12);
  fs.writeFileSync(path.join(stage, 'release-manifest.json'), JSON.stringify({ version: 1, kind: 'update-only', id, createdAt: new Date().toISOString(), files }, null, 2));
  const archive = path.join(output, `cashier-lottery-update-${id}.tar.gz`);
  if (fs.existsSync(archive)) throw new Error('This immutable release archive already exists; preserve it instead of replacing it');
  execFileSync('tar', ['-czf', archive, '-C', stage, '.'], { stdio: 'pipe' });
  const state = { id, stage, archive, sha256: digest(archive), files: files.length, bytes: fs.statSync(archive).size,
    containsSecrets: false, containsSetupGrant: false, onlineBase: '/cashier/' };
  const stateFile = path.join(output, 'cashier-release-state.json');
  if (fs.existsSync(stateFile)) {
    const previous = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const historical = path.join(output, `cashier-release-state-${previous.id}.json`);
    if (!fs.existsSync(historical)) fs.copyFileSync(stateFile, historical, fs.constants.COPYFILE_EXCL);
  }
  fs.writeFileSync(path.join(output, `cashier-release-state-${id}.json`), JSON.stringify(state, null, 2), { flag: 'wx' });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  console.log(JSON.stringify(state, null, 2)); return state;
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--date') throw new Error('Usage: node package-update.cjs --date YYYYMMDD');
  buildPackage({ releaseDate: args[1] });
}
module.exports = { buildPackage };
