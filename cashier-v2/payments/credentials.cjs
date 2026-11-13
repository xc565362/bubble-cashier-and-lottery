const crypto = require('node:crypto');

function rsaKey(value, privateKey = false) {
  if (typeof value !== 'string' || value.length > 16000) throw new Error('密钥文件格式或大小不正确');
  let key;
  try {
    const text = value.trim();
    const read = privateKey ? crypto.createPrivateKey : crypto.createPublicKey;
    try { key = read(text); }
    catch {
      if (!/^[A-Za-z0-9+/=\s]+$/.test(text)) throw new Error();
      const der = Buffer.from(text.replace(/\s/g, ''), 'base64');
      for (const type of privateKey ? ['pkcs8', 'pkcs1'] : ['spki', 'pkcs1']) {
        try { key = read({ key: der, format: 'der', type }); break; } catch {}
      }
    }
    if (!key || key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength !== 2048) throw new Error();
  } catch { throw new Error(privateKey ? '请导入有效的 RSA 2048 私钥（PKCS1 或 PKCS8）' : '请导入收钱吧提供的 RSA 2048 验签公钥'); }
  return key;
}

function normalizePrivateKey(value) {
  const key = rsaKey(value, true);
  const publicKey = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' });
  const challenge = crypto.randomBytes(32);
  if (!crypto.verify('RSA-SHA256', challenge, publicKey, crypto.sign('RSA-SHA256', challenge, key))) throw new Error('私钥本地签名自检失败');
  return { privateKey: key.export({ type: 'pkcs8', format: 'pem' }), publicKey };
}

function publicFingerprint(publicKey) {
  return crypto.createHash('sha256').update(rsaKey(publicKey).export({ type: 'spki', format: 'der' })).digest('hex');
}

function sealCredentials(data, password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 200) throw new Error('配置包密码需要 12 至 200 个字符');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  key.fill(0);
  return { format: 'stall-sqb-credentials', version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
}

function openCredentials(bundle, password) {
  try {
    if (bundle?.format !== 'stall-sqb-credentials' || bundle.version !== 1 || typeof password !== 'string' || password.length < 12 || password.length > 200) throw new Error();
    const decode = (field, length) => {
      if (typeof bundle[field] !== 'string' || bundle[field].length > 50000 || !/^[A-Za-z0-9+/=]+$/.test(bundle[field])) throw new Error();
      const value = Buffer.from(bundle[field], 'base64');
      if (length && value.length !== length) throw new Error();
      return value;
    };
    const key = crypto.scryptSync(password, decode('salt', 16), 32);
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, decode('iv', 12));
      decipher.setAuthTag(decode('tag', 16));
      return JSON.parse(Buffer.concat([decipher.update(decode('data')), decipher.final()]).toString('utf8'));
    } finally { key.fill(0); }
  } catch { throw new Error('配置包或密码不正确，未修改当前配置'); }
}

module.exports = { rsaKey, normalizePrivateKey, publicFingerprint, sealCredentials, openCredentials };
