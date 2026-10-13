const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const QRCode = require('qrcode');
const { PNG } = require('pngjs');
const { MultiFormatReader, BinaryBitmap, HybridBinarizer, RGBLuminanceSource, DecodeHintType, BarcodeFormat } = require('@zxing/library');

const directory = path.resolve(process.argv[2]);
const centerId = '6946ec4d-8127-45c7-9dc6-dbc4e9eb72e0';
const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
const save = (name, data) => fs.writeFileSync(path.join(directory, name), JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
async function call(action, input = {}) {
  const response = await fetch('http://localhost:5173/api/sqb/' + action, {
    method: 'POST', headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' },
    body: JSON.stringify(input), signal: AbortSignal.timeout(25000),
  });
  const result = await response.json();
  assert.ok(response.ok && result.ok, 'Cashier API failed: ' + action + ' ' + (result.error || result.code || response.status));
  return result.data;
}
function verifyImage(file, expected, format) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const luminance = new Uint8ClampedArray(png.width * png.height);
  for (let i = 0; i < luminance.length; i++) luminance[i] = png.data[i * 4];
  const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(luminance, png.width, png.height)));
  const hints = new Map([[DecodeHintType.POSSIBLE_FORMATS, [format]], [DecodeHintType.TRY_HARDER, true]]);
  assert.equal(new MultiFormatReader().decode(bitmap, hints).getText(), expected);
}
async function main() {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const config = await call('coupon-config');
  assert.equal(config.centerId, centerId); assert.equal(config.environment, 'production');
  assert.equal(config.connected, true); assert.equal(config.physicalSupported, true);
  const bindings = await call('coupon-physical-bindings');
  const product = bindings.prizes.tote.product;
  assert.equal(product.sku, 'BB260057');
  assert.equal(product.id, '4b8b06d1-6485-4967-8c30-264e3389bfde');
  const campaignsBefore = await call('coupon-campaigns');
  const lotteryBefore = await call('lottery-snapshot');
  const until = Math.min(Date.now() + 24 * 3600000, lotteryBefore.redemptionEndsAt);
  assert.ok(until > Date.now(), 'Activity already closed');
  if (!fs.existsSync(path.join(directory, 'plan.json'))) {
    const id = crypto.randomUUID();
    save('plan.json', { id, code: crypto.randomBytes(8).toString('hex').toUpperCase(),
      name: '内部验收测试-超大编织袋-仅1次', prizeId: 'tote', sku: 'BB260057',
      startsAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(until).toISOString(),
      owner: 'internal-pos-acceptance-' + id, awardId: 'pos-acceptance-' + id });
    save('campaigns.before.json', campaignsBefore);
    save('lottery.before.json', lotteryBefore);
  }
  const plan = read('plan.json');
  const qr = path.join(directory, '兑换二维码.png');
  const barcode = path.join(directory, '兑换条形码.png');
  await QRCode.toFile(qr, plan.code, { errorCorrectionLevel: 'M', margin: 4, scale: 12, color: { dark: '#000000', light: '#ffffff' } });
  const { default: JsBarcode } = await import('../src/vendor/jsbarcode.js');
  const encoded = {};
  JsBarcode(encoded, plan.code, { format: 'CODE128', displayValue: false });
  const bits = encoded.encodings.map(e => e.data).join('');
  const scale = 3, margin = 36, height = 192;
  const image = new PNG({ width: bits.length * scale + margin * 2, height: height + margin * 2 });
  image.data.fill(255);
  for (let i = 0; i < bits.length; i++) if (bits[i] === '1') {
    for (let x = margin + i * scale; x < margin + (i + 1) * scale; x++) for (let y = margin; y < margin + height; y++) {
      const offset = (y * image.width + x) * 4;
      image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = 0;
    }
  }
  fs.writeFileSync(barcode, PNG.sync.write(image));
  verifyImage(qr, plan.code, BarcodeFormat.QR_CODE);
  verifyImage(barcode, plan.code, BarcodeFormat.CODE_128);

  // A dedicated one-coupon campaign cannot consume any of the eight lottery quotas.
  const campaign = await call('coupon-create-campaign', { requestId: 'acceptance-campaign-' + plan.id,
    name: plan.name, kind: 'physical', physical: { prizeId: plan.prizeId, quantity: 1 }, amountCents: 0, minimumCents: 0,
    quota: 1, startsAt: plan.startsAt, expiresAt: plan.expiresAt, redemptionEnabled: true });
  if (!fs.existsSync(path.join(directory, 'campaign.json'))) save('campaign.json', campaign);
  assert.equal(campaign.quota, 1); assert.equal(campaign.physical.prizeId, 'tote');
  assert.ok(!Object.values(lotteryBefore.center.prizes).some(p => p.campaignId === campaign.id));
  const coupon = await call('coupon-issue', { requestId: 'acceptance-issue-' + plan.id, campaignId: campaign.id,
    owner: plan.owner, awardId: plan.awardId, trustedCode: plan.code });
  assert.equal(coupon.state, 'AVAILABLE', 'Test coupon is already in use; do not issue another');
  assert.equal(coupon.code, plan.code); assert.equal(coupon.physical.prizeId, 'tote');
  assert.equal(coupon.amountCents, 0); assert.equal(coupon.environment, 'production');
  const current = await call('coupon-coupon', { id: coupon.id });
  assert.equal(current.state, 'AVAILABLE'); assert.equal(current.code, plan.code);
  const after = await call('coupon-campaigns');
  assert.equal(after.find(c => c.id === campaign.id).issued, 1);
  for (const old of read('campaigns.before.json')) assert.deepEqual(after.find(c => c.id === old.id), old, 'An existing campaign changed');
  const lotteryAfter = await call('lottery-snapshot');
  assert.deepEqual(lotteryAfter, read('lottery.before.json'), 'Lottery changed during issuance; inspect concurrent activity');
  const receipt = { createdAt: new Date().toISOString(), code: plan.code, couponId: coupon.id, campaignId: campaign.id,
    campaignName: plan.name, product: { id: product.id, name: product.name, sku: product.sku }, quantity: 1,
    expiresAt: coupon.expiresAt, state: current.state, stockDeductedByCreation: false,
    lotteryConfigurationUnchanged: true, originalCampaignsUnchanged: true, miniProgramLinked: false,
    warning: 'Confirming zero checkout creates a real order and deducts one BB260057 from local inventory. This test coupon is not a WeChat winning record.',
    decodedImageChecks: ['QR_CODE', 'CODE_128'], qrFile: qr, barcodeFile: barcode };
  if (!fs.existsSync(path.join(directory, 'receipt.json'))) save('receipt.json', receipt);
  console.log(JSON.stringify(receipt, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
