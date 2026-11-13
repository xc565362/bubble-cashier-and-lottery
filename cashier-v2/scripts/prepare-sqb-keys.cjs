const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

async function main() {
  const home = os.homedir();
  const privateDirectory = path.join(home, '.stall-cashier-sqb-keys');
  const publicDirectory = path.join(home, 'Desktop', '\u6536\u94b1\u5427\u5bf9\u63a5\u8d44\u6599');
  if (!fs.existsSync(privateDirectory)) throw new Error('Create the restricted private directory before running this script.');
  const response = await fetch('http://localhost:5173/api/sqb/generate-key', {
    method: 'POST', headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' },
    body: '{}', signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error('Local key generation failed. No keys were exported.');
  const expectedDirectory = path.join(home, '.stall-cashier-sqb-web');
  if (path.resolve(result.data.directory) !== expectedDirectory) throw new Error('Unexpected key directory.');
  const keys = JSON.parse(fs.readFileSync(path.join(expectedDirectory, 'merchant-key.json'), 'utf8'));
  const privateKey = crypto.createPrivateKey(keys.privateKey);
  if (privateKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyDetails.modulusLength !== 2048) throw new Error('Expected RSA 2048.');
  const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  if (publicKey !== keys.publicKey || publicKey !== result.data.merchantPublicKey) throw new Error('Public/private key mismatch.');
  const challenge = crypto.randomBytes(48);
  const signature = crypto.sign('RSA-SHA256', challenge, privateKey);
  if (!crypto.verify('RSA-SHA256', challenge, publicKey, signature)) throw new Error('RSA2 signature self-test failed.');
  const privatePath = path.join(privateDirectory, 'sqb-application-private.pem');
  if (fs.existsSync(privatePath)) {
    if (fs.readFileSync(privatePath, 'utf8') !== keys.privateKey) throw new Error('A different private backup already exists; refusing to overwrite it.');
  } else fs.writeFileSync(privatePath, keys.privateKey, { mode: 0o600, flag: 'wx' });
  fs.mkdirSync(publicDirectory, { recursive: true });
  const publicPath = path.join(publicDirectory, '\u6536\u94b1\u5427\u5e94\u7528\u516c\u94a5.txt');
  if (fs.existsSync(publicPath)) {
    if (fs.readFileSync(publicPath, 'utf8') !== publicKey) throw new Error('A different public key already exists; refusing to overwrite it.');
  } else fs.writeFileSync(publicPath, publicKey, { flag: 'wx' });
  const fingerprint = crypto.createHash('sha256').update(crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' })).digest('hex');
  console.log(JSON.stringify({ publicPath, privatePath, algorithm: 'SHA256withRSA', bits: 2048, privateFormat: 'PKCS8 PEM', publicFormat: 'SPKI PEM', fingerprint, signatureSelfTest: 'passed' }));
}

main().catch(() => { console.error('Key preparation failed; private key contents were not printed.'); process.exitCode = 1; });
