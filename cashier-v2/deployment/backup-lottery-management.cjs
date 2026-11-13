const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const [cli, destination] = process.argv.slice(2);
if (!cli || !destination || fs.existsSync(destination)) throw new Error('Pass CLI and a new private backup directory');
fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
const env = 'bubble-lottery-500-d8cd9c6a45992';
function run(args, output) {
  const result = spawnSync(process.execPath, [cli, '-e', env, ...args], { encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  fs.writeFileSync(path.join(destination, output), result.stdout || '', { mode: 0o600 });
  if (result.status !== 0) { fs.writeFileSync(path.join(destination, output + '.error'), result.stderr || '', { mode: 0o600 }); throw new Error('Cloud command failed; inspect private ' + output); }
  return result.stdout;
}
run(['config', 'pull', 'fn', 'lottery', '--output', path.join(destination, 'cloudbaserc.before.json'), '--json'], 'config-pull.json');
run(['fn', 'code', 'download', 'lottery', path.join(destination, 'code-before'), '--json'], 'code-download.json');
for (const table of ['lottery_entries', 'lottery_codes', 'lottery_pools', 'lottery_coupons', 'lottery_coupon_reservations', 'lottery_coupon_requests', 'lottery_coupon_checkouts', 'lottery_coupon_orders', 'lottery_coupon_payments', 'lottery_gateway_nonces', 'lottery_gateway_rates']) {
  const command = JSON.stringify([{ TableName: table, CommandType: 'QUERY', Command: JSON.stringify({ find: table, filter: {}, limit: 10000 }) }]);
  run(['db', 'nosql', 'execute', '--command', command, '--json'], table + '.raw.json');
  console.log('Backed up ' + table);
}
run(['routes', 'list', '--json'], 'routes-before.json');
const files = fs.readdirSync(destination).filter(name => fs.statSync(path.join(destination, name)).isFile()).map(name => ({ name, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(destination, name))).digest('hex') }));
fs.writeFileSync(path.join(destination, 'backup-index.json'), JSON.stringify({ at: new Date().toISOString(), env, files, mutatedBusinessData: false }, null, 2));
console.log(JSON.stringify({ backupCompleted: true, files: files.length, directory: destination }));
