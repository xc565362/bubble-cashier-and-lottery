import { availablePrizeProducts, percentToBps, safePrizeImage } from './lotterySettings.js';

export const SCARF_CAMPAIGN_ID = 'scarf-xhs-50-v1';
const clean = value => String(value || '').trim();
export function localDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
export function scarfDraft(snapshot) {
  const campaign = snapshot.campaign;
  return { title: campaign.title, venue: campaign.venue || '', startsAt: localDateTime(campaign.startsAt), endsAt: localDateTime(campaign.endsAt),
    redeemEndsAt: localDateTime(campaign.redeemEndsAt), percentage: String(campaign.winProbabilityBps / 100), total: String(snapshot.inventory.total),
    prize: { ...snapshot.prize, name: snapshot.prize.name || '', imageUrl: snapshot.prize.imageUrl || '', product: snapshot.prize.product ? { ...snapshot.prize.product } : null } };
}
export function matchingScarfProduct(product, products) {
  if (!product) return null;
  const codes = [product.sku, product.barcode].map(clean).filter(Boolean);
  const matches = availablePrizeProducts(products).filter(p => [p.sku, p.barcode].map(clean).some(code => code && codes.includes(code)));
  return matches.length === 1 ? matches[0] : null;
}
export function scarfConnectionProblem(snapshot, coupon) {
  if (!snapshot?.fulfillment?.ready) return '头巾活动尚未连接券中心，请先完成云端发券配置。';
  if (!coupon?.connected || coupon.mode !== 'remote') return '请先在「券管理」连接与头巾活动相同的云端券中心。';
  if (!coupon.physicalSupported || !coupon.lotteryCatalogSupported) return '券中心需要支持实物奖品和商品绑定，请先升级券服务。';
  if (coupon.centerId !== snapshot.fulfillment.centerId || coupon.environment !== snapshot.fulfillment.environment) return '头巾活动与本机连接的券中心或环境不一致，请在「券管理」核对连接。';
  return '';
}
export function scarfPayload(snapshot, draft, reason, products) {
  if (snapshot.campaign.enabled) throw new Error('请先暂停新抽奖，再修改活动配置');
  const title = clean(draft.title), venue = clean(draft.venue), name = clean(draft.prize.name), imageUrl = clean(draft.prize.imageUrl);
  if (!title || title.length > 60 || /[\u0000-\u001f]/.test(title)) throw new Error('请填写活动名称，最多 60 字');
  if (!venue || venue.length > 100 || /[\u0000-\u001f]/.test(venue)) throw new Error('请填写活动地点，最多 100 字');
  if (!name || name.length > 60 || /[\u0000-\u001f]/.test(name)) throw new Error('请填写奖品名称，最多 60 字');
  if (imageUrl && (imageUrl.length > 2000 || /[\u0000-\u001f]/.test(imageUrl) || !safePrizeImage(imageUrl))) throw new Error('奖品图片须为公开可访问的 HTTPS 地址，最多 2000 个字符');
  if (!/^\d{1,7}$/.test(String(draft.total)) || Number(draft.total) > 1000000 || Number(draft.total) < snapshot.inventory.awarded) throw new Error('总名额须为整数，不能小于已中奖数量，最多 1000000 份');
  if (!matchingScarfProduct(draft.prize.product, products)) throw new Error('请选择本机具有唯一货品编码或条码的库存商品');
  for (const [field, limit] of [['id', 120], ['name', 120], ['sku', 100], ['barcode', 100]]) {
    const value = clean(draft.prize.product[field]);
    if (value.length > limit || /[\u0000-\u001f]/.test(value) || (['id', 'name'].includes(field) && !value)) throw new Error('商品名称或编码不正确，请先在商品管理中核对');
  }
  const fields = ['startsAt', 'endsAt', 'redeemEndsAt'], dates = {};
  const count = fields.filter(field => draft[field]).length;
  if (count && count !== fields.length) throw new Error('请完整填写开始、结束及核销截止时间，或全部留空保存待定活动');
  for (const field of fields) {
    const existing = snapshot.campaign[field];
    const date = draft[field] ? new Date(draft[field] === localDateTime(existing) && existing ? existing : draft[field]) : null;
    if (date && !Number.isFinite(date.getTime())) throw new Error('活动时间格式无效');
    dates[field] = date ? date.toISOString() : null;
  }
  if (dates.startsAt && (dates.endsAt <= dates.startsAt || dates.redeemEndsAt < dates.endsAt)) throw new Error('结束时间须晚于开始时间，核销截止时间不能早于结束时间');
  if (!clean(reason) || clean(reason).length > 200 || /[\u0000-\u001f]/.test(clean(reason))) throw new Error('请填写调整原因，最多 200 字');
  return { revision: snapshot.revision, operation: 'configure', reason: clean(reason), total: Number(draft.total),
    campaign: { title, venue, ...dates, winProbabilityBps: percentToBps(draft.percentage) },
    prize: { id: draft.prize.id, name, imageUrl, product: { id: draft.prize.product.id, name: draft.prize.product.name, sku: clean(draft.prize.product.sku), barcode: clean(draft.prize.product.barcode) } } };
}
