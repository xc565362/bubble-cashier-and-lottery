import {escapeHtml as e} from './core.mjs';

// The server decides which prizes are active and their order. IDs are opaque:
// even a prize named "draw" must remain a prize rather than becoming a control.
export function prizeBoard(prizes = []) {
  const seen = new Set();
  const items = prizes.filter(prize => {
    if (!prize || typeof prize.id !== 'string' || !prize.id.trim() || seen.has(prize.id)) return false;
    seen.add(prize.id); return true;
  });
  const ringOrder = items.map(prize => prize.id);
  const slots = items.map(prize => ({kind:'prize', prize}));
  if (items.length === 8) {
    const positions = [0, 1, 2, 5, 8, 7, 6, 3], ring = Array(9);
    slots.forEach((slot, index) => { ring[positions[index]] = slot; });
    ring[4] = {kind:'draw'};
    return {items, slots:ring, ringOrder, classic:true, columns:3};
  }
  return {items, slots:[...slots, {kind:'draw'}], ringOrder, classic:false, columns:Math.min(3, Math.max(1, items.length))};
}

export function safeImageUrl(value) {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value) || /[\s\\]/.test(value)) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}
export function prizeArt(prize) {
  if (!prize) return '';
  const image = safeImageUrl(prize.imageUrl);
  const cash = prize.kind === 'cash';
  if (cash && !image) return `<div class="prize-art"><div class="cash"><span class="currency">¥</span><span class="amount">${e(prize.amount)}</span></div></div>`;
  const fallback = !cash && ['cap','bucket','waist','tote'].includes(prize.icon) ? `./assets/${prize.icon}.svg` : '';
  if (!image && !fallback) return `<div class="prize-art"><span class="product-placeholder" role="img" aria-label="${e(prize.name)}实物奖品示意"><span class="gift-icon" aria-hidden="true"></span></span></div>`;
  return `<div class="prize-art"><img class="product" src="${e(image || fallback)}" alt="${e(prize.name)}${image ? '' : '示意图'}" ${image ? `data-prize-image="remote" data-fallback-src="${fallback}" data-fallback-kind="${cash ? 'cash' : fallback ? 'icon' : 'neutral'}" ${cash ? `data-fallback-amount="${e(prize.amount)}"` : ''} data-fallback-alt="${e(prize.name)}${fallback || cash ? '' : '实物奖品'}示意图" referrerpolicy="no-referrer"` : ''}></div>`;
}
export function fallbackPrizeImage(target) {
  if (target?.getAttribute?.('data-prize-image') !== 'remote') return false;
  const fallback = target.getAttribute('data-fallback-src');
  if (target.getAttribute('data-fallback-kind') === 'cash') {
    if (!target.ownerDocument?.createElement) return false;
    target.removeAttribute('data-prize-image');
    const cash = target.ownerDocument.createElement('div'),currency = target.ownerDocument.createElement('span'),amount = target.ownerDocument.createElement('span');
    cash.className = 'cash'; currency.className = 'currency'; amount.className = 'amount';
    currency.textContent = '¥'; amount.textContent = target.getAttribute('data-fallback-amount') || '';
    cash.append(currency, amount); target.replaceWith(cash);
    return true;
  }
  if (!/^\.\/assets\/(?:cap|bucket|waist|tote)\.svg$/.test(fallback || '')) {
    if (target.getAttribute('data-fallback-kind') !== 'neutral' || !target.ownerDocument?.createElement) return false;
    target.removeAttribute('data-prize-image');
    const placeholder = target.ownerDocument.createElement('span');
    placeholder.className = 'product-placeholder';
    placeholder.setAttribute('role', 'img');
    placeholder.setAttribute('aria-label', target.getAttribute('data-fallback-alt') || '实物奖品示意');
    const icon = target.ownerDocument.createElement('span');
    icon.className = 'gift-icon'; icon.setAttribute('aria-hidden', 'true');
    placeholder.append(icon); target.replaceWith(placeholder);
    return true;
  }
  target.removeAttribute('data-prize-image');
  target.setAttribute('alt', target.getAttribute('data-fallback-alt') || '奖品示意图');
  target.setAttribute('src', fallback);
  return true;
}

const percentage = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
  ? String(Number(value.toFixed(4))) : '';
export function probabilityCaption(prize, campaign = {}) {
  if (campaign.enabled === false && campaign.drawMode === 'fixed' && percentage(prize?.configuredProbability) !== '') return `设定 ${percentage(prize.configuredProbability)}%`;
  const effective = percentage(prize?.effectiveProbability);
  if (effective !== '') return `当前 ${effective}%`;
  const configured = campaign.drawMode === 'fixed' && percentage(prize?.configuredProbability) !== ''
    ? percentage(prize.configuredProbability) : percentage(prize?.probability);
  if (configured === '') return '';
  if (campaign.drawMode === 'fixed') return `固定 ${configured}%`;
  if (campaign.drawMode === 'inventory' || (!campaign.drawMode && campaign.inventory)) return `初始配置 ${configured}%`;
  return `配置比例 ${configured}%`;
}
export function probabilityExplanation(campaign = {}, prizes = []) {
  const effective = prizes.some(prize => percentage(prize?.effectiveProbability) !== '');
  if (effective) {
    const mode = campaign.drawMode === 'fixed' ? '本活动按固定概率抽取。'
      : campaign.drawMode === 'inventory' ? '本活动按当前剩余名额比例抽取。' : '';
    return mode + '标注为“当前”的概率由服务端提供；暂停或不可抽取时以页面提示为准。有名额时参与成功即获 1 份奖品，名额发完即止。';
  }
  const basis = campaign.drawMode === 'fixed'
    ? '标注的固定概率为各奖项的配置概率。'
    : campaign.drawMode === 'inventory' || (!campaign.drawMode && campaign.inventory)
      ? '标注的初始配置比例来自初始奖池，不代表剩余奖池的实时中奖概率。'
      : '奖项配置比例以当前活动公示为准。';
  return basis + '有名额时参与成功即获 1 份奖品，名额发完即止。';
}
