export function percentToBps(value) {
  const text = String(value).trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) throw new Error('概率须为 0 至 100，最多两位小数');
  const [whole, fraction = ''] = text.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (result > 10000) throw new Error('概率不能超过 100%');
  return result;
}
export function lotteryConnectionProblem(snapshot, coupon) {
  if (!snapshot?.fulfillment) return '请升级此刻在地的活动服务，以核对收银核销连接；现有奖池仍可查看和配置。';
  if (!snapshot.fulfillment.ready) return '此刻在地的券中心暂不可用，请先核对活动后台的核销连接。';
  if (!coupon?.connected || coupon.mode !== 'remote') return '请先在「券管理」连接与此刻在地相同的云端券中心。';
  if (!snapshot.fulfillment.centerId || !snapshot.fulfillment.environment || coupon.centerId !== snapshot.fulfillment.centerId || coupon.environment !== snapshot.fulfillment.environment) return '此刻在地与本机连接的券中心或环境不一致，请在「券管理」核对连接。';
  if (snapshot.prizes?.some(p => p.kind === 'physical') && !coupon.physicalSupported) return '券中心需要支持实物奖品核销，请先升级券服务。';
  return '';
}
export function lotteryDraft(snapshot) {
  return { mode: snapshot.mode, quantities: Object.fromEntries(snapshot.prizes.map(p => [p.id, String(p.quota)])),
    percentages: Object.fromEntries(snapshot.prizes.map(p => [p.id, String(p.weightBps / 100)])),
    ...(snapshot.capabilities?.includes('catalog-v1') ? { catalog: structuredClone(snapshot.catalog || snapshot.prizes.map(prizeDefinition)) } : {}) };
}
export function prizeDefinition(p) {
  return { id: p.id, name: p.name, shortName: p.shortName || p.name, kind: p.kind,
    amount: p.amount || 0, minimumCents: p.minimumCents || 0, label: p.label || '', icon: p.icon || '',
    imageUrl: p.imageUrl || '', retired: p.retired === true, ...(p.product ? { product: { ...p.product } } : {}) };
}
export function safePrizeImage(value) {
  if (!value) return '';
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && value.length <= 2048 ? url.href : ''; } catch { return ''; }
}
export function availablePrizeProducts(products) {
  return products.filter(p => {
    const codes = [p.sku, p.barcode].map(value => String(value || '').trim()).filter(Boolean);
    return p.productType !== 'coupon' && codes.length && products.filter(other =>
      [other.sku, other.barcode].some(code => codes.includes(String(code || '').trim()))).length === 1;
  });
}
export function retirePrize(snapshot, draft, id) {
  const allocated = snapshot.prizes.find(p => p.id === id)?.allocated || 0;
  if (!snapshot.prizes.some(p => p.id === id)) {
    const quantities = { ...draft.quantities }, percentages = { ...draft.percentages };
    delete quantities[id]; delete percentages[id];
    return { ...draft, catalog: draft.catalog.filter(p => p.id !== id), quantities, percentages };
  }
  return { ...draft, catalog: draft.catalog.map(p => p.id === id ? { ...p, retired: true } : p),
    quantities: { ...draft.quantities, [id]: String(allocated) }, percentages: { ...draft.percentages, [id]: '0' } };
}
export function lotteryPayload(snapshot, draft, reason) {
  const quantities = {}, weightsBps = {};
  const items = draft.catalog || snapshot.prizes;
  if (draft.catalog && (!snapshot.capabilities?.includes('catalog-v1') || !items.some(p => !p.retired))) throw new Error('请至少保留一个可抽奖项，并确认云端支持奖品管理');
  for (const p of items) {
    const allocated = snapshot.prizes.find(item => item.id === p.id)?.allocated || 0;
    const text = String(draft.quantities[p.id]);
    if (!/^\d{1,7}$/.test(text) || Number(text) > 1000000 || Number(text) < allocated) throw new Error(`${p.name}总名额不能小于已抽中数量，且须为整数`);
    quantities[p.id] = Number(text);
    weightsBps[p.id] = draft.mode === 'inventory' ? 0 : percentToBps(draft.percentages[p.id]);
    if (p.retired && (quantities[p.id] !== allocated || weightsBps[p.id] !== 0)) throw new Error('已移除奖项只保留历史中奖名额，概率必须为 0');
    if (p.imageUrl && !safePrizeImage(p.imageUrl)) throw new Error(`${p.name}的图片地址必须为 HTTPS`);
  }
  if (draft.mode === 'inventory') {
    const available = items.map(p => ({ id: p.id, count: p.retired ? 0 : quantities[p.id] - (snapshot.prizes.find(item => item.id === p.id)?.allocated || 0) }));
    const total = available.reduce((sum, p) => sum + p.count, 0);
    if (!total) throw new Error('请至少保留一个可抽名额');
    for (const p of available) weightsBps[p.id] = Math.floor(p.count * 10000 / total);
    let remainder = 10000 - Object.values(weightsBps).reduce((sum, n) => sum + n, 0);
    for (const p of available.filter(p => p.count).sort((a, b) => (b.count * 10000 % total) - (a.count * 10000 % total))) if (remainder-- > 0) weightsBps[p.id]++;
  }
  if (Object.values(weightsBps).reduce((sum, n) => sum + n, 0) !== 10000) throw new Error('固定概率合计必须为 100%');
  if (!reason.trim()) throw new Error('请填写调整原因');
  return { operation: 'configure', expectedRevision: snapshot.revision, mode: draft.mode, quantities, weightsBps, reason: reason.trim(),
    ...(draft.catalog ? { catalog: draft.catalog.map(prizeDefinition) } : {}) };
}
