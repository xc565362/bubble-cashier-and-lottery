import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from '../lib/motion.js';
import { Barcode, Check, CheckCircle2, Gift, History, Minus, Plus, Search, Trash2 } from 'lucide-react';
import { Badge, EmptyState, Modal, PageShell, spring } from '../components/ui.jsx';
import { isPromoRuleActive, todayKey } from '../lib/format.js';
import { isCompleted } from '../logic/orderLogic.js';
import { canBePromoGift } from '../logic/cartLogic.js';
import { ProductImage } from '../modals/ProductModal.jsx';

const timeText = (value) => (value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—');
const isGiveawayOrder = (order) =>
  order.method === '0元出库'
  || (Array.isArray(order.items) && order.items.length > 0 && order.items.every((item) => item.productType === 'gift'));

export function GiftsScreen({ products, orders, promoRules, saleProducts, giftProducts, locked, readOnly, isAdmin, flash, onHandout, onSaveRule, onToggleRule, onRemoveRule }) {
  const [search, setSearch] = useState('');
  const [scanInput, setScanInput] = useState('');
  const [selected, setSelected] = useState(null);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [justHanded, setJustHanded] = useState('');
  const [range, setRange] = useState('today');

  const canOperate = !locked;

  const gifts = useMemo(() => {
    const term = search.trim().toLowerCase();
    return products.filter((item) => {
      if (!canBePromoGift(item)) return false;
      return !term || [item.name, item.barcode, item.sku, item.group].some((value) => String(value || '').toLowerCase().includes(term));
    });
  }, [products, search]);

  const giveawayOrders = useMemo(() => {
    const today = todayKey();
    return orders
      .filter(isGiveawayOrder)
      .filter((order) => range === 'all' || todayKey(new Date(order.createdAt)) === today)
      .slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }, [orders, range]);

  const todayStats = useMemo(() => {
    const today = todayKey();
    const rows = orders.filter((order) => isGiveawayOrder(order) && isCompleted(order) && todayKey(new Date(order.createdAt)) === today);
    return {
      count: rows.length,
      qty: rows.reduce((sum, order) => sum + order.items.reduce((acc, item) => acc + Number(item.qty || 0), 0), 0),
    };
  }, [orders]);

  const activeRules = useMemo(() => (promoRules || []).filter((rule) => isPromoRuleActive(rule)), [promoRules]);

  const selectedLive = selected ? products.find((item) => item.id === selected.id) : null;
  const selectedStock = Number(selectedLive?.stock ?? selected?.stock ?? 0);

  useEffect(() => {
    if (!selected) return;
    setQty((value) => Math.max(1, Math.min(Number(value) || 1, Math.max(1, selectedStock))));
  }, [selected, selectedStock]);

  useEffect(() => {
    if (!justHanded) return undefined;
    const timer = window.setTimeout(() => setJustHanded(''), 1800);
    return () => window.clearTimeout(timer);
  }, [justHanded]);

  function openHandout(product) {
    if (locked) { flash('请先核对待处理收退款'); return; }
    if (Number(product.stock || 0) <= 0) { flash(`${product.name} 暂无库存`); return; }
    setQty(1);
    setSelected(product);
  }

  function scanGift(event) {
    event?.preventDefault();
    const code = scanInput.trim();
    if (!code) return;
    const matches = products.filter((item) => item.barcode === code);
    const gift = matches.find((item) => item.productType === 'gift') || matches.find(canBePromoGift);
    if (gift) { openHandout(gift); setScanInput(''); return; }
    flash(matches.length ? '该条码对应商品不是赠品，也未启用“可参与买赠”，请到收银页操作' : '未找到该条码对应的赠品');
  }

  async function confirmHandout() {
    if (!selectedLive || busy) return;
    const amount = Math.max(1, Math.min(Number(qty) || 1, Math.max(1, selectedStock)));
    if (selectedStock <= 0) { flash(`${selectedLive.name} 暂无库存`); return; }
    setBusy(true);
    try {
      if (await onHandout(selectedLive, amount)) {
        setJustHanded(`${selectedLive.name} × ${amount}`);
        setSelected(null);
      }
    } finally {
      setBusy(false);
    }
  }

  function productName(productId) {
    return products.find((item) => item.id === productId)?.name || '商品已删除';
  }

  function ruleSummary(rule) {
    const saleCount = products.filter((item) => item.productType === 'sale').length;
    const main = rule.mainProductIds.length === saleCount && saleCount
      ? '全部售卖品'
      : rule.mainProductIds.map(productName).join(' / ') || '未选择主品';
    const giftsLabel = rule.gifts.map((gift) => `${productName(gift.productId)} × ${gift.qty}`).join(' / ');
    return `${main}${rule.mode === 'choice' ? ' 可选 ' : ' 送 '}${giftsLabel}`;
  }

  return (
    <PageShell kicker="Gifts" title="赠品发放">
      <div className="mb-5 grid grid-cols-3 gap-3">
        {[
          ['今日发放单数', todayStats.count],
          ['今日发放件数', todayStats.qty],
          ['有库存赠品', gifts.filter((item) => Number(item.stock || 0) > 0).length],
        ].map(([label, value]) => (
          <motion.div key={label} className="glass px-3 py-4 text-center" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
            <p className="text-[11px] text-mist">{label}</p>
            <p className="mt-1 text-2xl font-black text-coral-soft">{value}</p>
          </motion.div>
        ))}
      </div>

      <div className="glass mb-5 p-5">
        <form className="flex items-center gap-2" onSubmit={scanGift}>
          <div className="relative min-w-0 flex-1">
            <Barcode size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mist/60" />
            <input
              className="field !pl-10"
              value={scanInput}
              aria-label="赠品条码"
              autoComplete="off"
              placeholder="扫描或输入赠品条码"
              onChange={(event) => setScanInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Tab' && scanInput.trim()) { event.preventDefault(); scanGift(); } }}
            />
          </div>
          <button type="submit" className="btn-primary !min-h-[44px] shrink-0" disabled={!scanInput.trim()}>确认</button>
        </form>

        <div className="relative mt-4">
          <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mist/60" />
          <input className="field !pl-10" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索赠品名、条码或编码" />
        </div>

        <motion.div layout className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          <AnimatePresence mode="popLayout">
            {gifts.map((product) => {
              const out = Number(product.stock || 0) <= 0;
              return (
                <motion.button
                  layout
                  key={product.id}
                  className="glass group relative flex flex-col items-stretch gap-2 overflow-hidden p-3 text-left transition hover:border-coral/50 hover:shadow-pop disabled:opacity-45"
                  onClick={() => openHandout(product)}
                  disabled={out || !canOperate}
                  initial={{ opacity: 0, scale: 0.92 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  whileHover={!out && canOperate ? { y: -3 } : undefined}
                  whileTap={!out && canOperate ? { scale: 0.96 } : undefined}
                  transition={spring}
                >
                  <div className="flex items-start justify-between gap-2">
                    <ProductImage product={product} />
                    {product.productType === 'gift'
                      ? <span className="chip !px-2 !py-0.5 border-emerald-400/30 bg-emerald-400/10 text-[10px] text-emerald-300">赠品 · 免费</span>
                      : <span className="chip !px-2 !py-0.5 border-sky-400/30 bg-sky-400/10 text-[10px] text-sky-300">可售可赠</span>}
                  </div>
                  <span className="line-clamp-2 min-h-[2.5em] text-[15px] font-semibold leading-snug">{product.name}</span>
                  <small className="truncate font-mono text-[11px] text-mist/70">{product.barcode}</small>
                  <small className="truncate text-[11px] text-mist/60">
                    {product.group || '未分组'} · 库存{' '}
                    <motion.b key={product.stock} initial={{ scale: 1.35 }} animate={{ scale: 1 }} className={`inline-block ${out ? 'text-red-300' : 'text-milk'}`}>
                      {product.stock}
                    </motion.b>
                  </small>
                  {out && <em className="absolute right-3 top-3 rounded-md bg-red-500/80 px-2 py-0.5 text-[11px] font-bold not-italic text-[#fff]">无库存</em>}
                </motion.button>
              );
            })}
          </AnimatePresence>
        </motion.div>
        {!gifts.length && (
          <EmptyState icon={Gift} title="没有匹配的赠品" hint="赠品在「商品」页中创建，商品类型选择“赠品”；售卖品勾选“可参与买赠”后也会出现在这里。" />
        )}
      </div>

      <section aria-label="发放记录" className="mb-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 font-bold"><History size={18} className="text-coral" /> 发放记录</h3>
            <p className="text-xs text-mist">0元出库与纯赠品订单，最新在前；数据来自云端账本。</p>
          </div>
          <div className="flex gap-1 rounded-full border border-white/10 bg-white/[0.04] p-1">
            {[['today', '今日'], ['all', '全部']].map(([key, label]) => (
              <button
                key={key}
                className={`min-h-[32px] rounded-full px-4 text-xs font-medium transition active:scale-95 ${
                  range === key ? 'bg-coral/20 text-coral-soft shadow-pop' : 'text-mist hover:text-milk'
                }`}
                onClick={() => setRange(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {giveawayOrders.length ? (
          <div className="table-shell overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="border-b border-white/[0.07] text-left text-xs text-mist">
                  <th className="px-4 py-3 font-medium">时间</th>
                  <th className="px-4 py-3 font-medium">发放内容</th>
                  <th className="px-4 py-3 font-medium">件数</th>
                  <th className="px-4 py-3 font-medium">方式</th>
                  <th className="px-4 py-3 font-medium">操作员</th>
                </tr>
              </thead>
              <tbody>
                {giveawayOrders.map((order) => (
                  <tr key={order.id} className="table-row">
                    <td className="px-4 py-3 text-xs text-mist"><time>{timeText(order.createdAt)}</time></td>
                    <td className="max-w-[320px] px-4 py-3">
                      <span className="block truncate font-semibold">{order.items.map((item) => `${item.name} × ${item.qty}`).join('、')}</span>
                      <code className="font-mono text-[11px] text-mist/60">{order.orderNo || order.id}</code>
                    </td>
                    <td className="px-4 py-3 font-semibold">{order.items.reduce((sum, item) => sum + Number(item.qty || 0), 0)}</td>
                    <td className="px-4 py-3">
                      <Badge tone={order.status === '已取消' ? 'danger' : order.method === '0元出库' ? 'ok' : 'coral'}>
                        {order.status === '已取消' ? '已取消' : order.method}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-xs text-mist">{order.operatorId || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={History} title={range === 'today' ? '今日暂无发放记录' : '暂无发放记录'} />
        )}
      </section>

      {isAdmin ? (
        <section aria-label="加赠玩法">
          <PromoRulesEditor rules={promoRules || []} saleProducts={saleProducts || []} giftProducts={giftProducts || []} onSave={onSaveRule} onToggle={onToggleRule} onRemove={onRemoveRule} readOnly={readOnly} />
        </section>
      ) : (
        <section aria-label="满赠规则">
          <div className="mb-3">
            <h3 className="flex items-center gap-2 font-bold"><Gift size={18} className="text-coral" /> 满赠规则</h3>
            <p className="text-xs text-mist">当前生效的买赠活动；收银时自动加赠或提示选择。加赠规则由管理员维护。</p>
          </div>
          <div className="glass space-y-2.5 p-4">
            {activeRules.length ? (
              activeRules.map((rule) => (
                <article key={rule.id} className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-4 py-3">
                  <strong className="block text-sm">{ruleSummary(rule)}</strong>
                  <span className="text-xs text-mist">
                    {rule.mode === 'choice' ? '二选一/多选一' : '全部赠送'} · {rule.stackable ? '叠加赠送' : '不叠加'}
                    {rule.startAt ? ` · ${new Date(rule.startAt).toLocaleString('zh-CN', { hour12: false })}` : ' · 不限开始'}
                    {rule.endAt ? ` 至 ${new Date(rule.endAt).toLocaleString('zh-CN', { hour12: false })}` : ' 至 不限结束'}
                  </span>
                </article>
              ))
            ) : (
              <p className="py-6 text-center text-sm text-mist">暂无生效中的满赠规则</p>
            )}
          </div>
        </section>
      )}

      <AnimatePresence>
        {selected && (
          <Modal
            key="gift-handout"
            title="确认发放赠品"
            subtitle="本单按 0 元出库，云端库存实时扣减"
            onClose={() => !busy && setSelected(null)}
            footer={
              <div className="flex flex-wrap items-center gap-2">
                <button className="btn-ghost" onClick={() => setSelected(null)} disabled={busy}>取消</button>
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  className="btn-primary ml-auto !px-8 !py-3.5 text-lg"
                  disabled={busy || !selectedLive || selectedStock <= 0}
                  onClick={confirmHandout}
                >
                  <Gift size={18} /> {busy ? '发放中…' : '确认发放'}
                </motion.button>
              </div>
            }
          >
            {selectedLive ? (
              <div className="space-y-4">
                <div className="glass flex items-center gap-4 px-4 py-3">
                  <ProductImage product={selectedLive} size="lg" />
                  <div className="min-w-0 flex-1">
                    <strong className="block truncate text-base">{selectedLive.name}</strong>
                    <span className="block truncate text-xs text-mist">{selectedLive.group || '未分组'} · {selectedLive.barcode}</span>
                    <span className="mt-1 block text-xs text-mist">
                      当前库存 <b className={selectedStock > 0 ? 'text-milk' : 'text-red-300'}>{selectedStock}</b> · 0 元出库
                    </span>
                  </div>
                  <Badge tone="ok">{selectedLive.productType === 'gift' ? '赠品 · 免费' : '可售可赠 · 0 元出库'}</Badge>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.03] px-4 py-3">
                  <span className="text-sm text-mist">发放数量</span>
                  <div className="flex items-center gap-2">
                    <button className="btn-icon !h-9 !w-9" aria-label="减少数量" onClick={() => setQty((value) => Math.max(1, (Number(value) || 1) - 1))} disabled={busy || qty <= 1}>
                      <Minus size={15} />
                    </button>
                    <motion.b key={qty} initial={{ scale: 1.3 }} animate={{ scale: 1 }} className="w-8 text-center text-lg">{qty}</motion.b>
                    <button className="btn-icon !h-9 !w-9" aria-label="增加数量" onClick={() => setQty((value) => Math.min(selectedStock, (Number(value) || 1) + 1))} disabled={busy || qty >= selectedStock}>
                      <Plus size={15} />
                    </button>
                  </div>
                </div>
                {selectedStock <= 0 && (
                  <p className="rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-300" role="alert">该赠品已无库存，无法发放</p>
                )}
              </div>
            ) : (
              <p className="py-6 text-center text-sm text-mist">该赠品已被删除，请关闭后刷新数据</p>
            )}
          </Modal>
        )}
        {justHanded && (
          <motion.div
            key="gift-success"
            className="pointer-events-none fixed inset-0 z-[65] flex items-center justify-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="glass-strong flex flex-col items-center gap-3 border-emerald-400/40 px-10 py-8"
              initial={{ scale: 0.7, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              transition={spring}
              role="status"
            >
              <motion.span initial={{ scale: 0, rotate: -30 }} animate={{ scale: 1, rotate: 0 }} transition={{ ...spring, delay: 0.05 }}>
                <CheckCircle2 size={46} className="text-emerald-300" />
              </motion.span>
              <p className="text-lg font-bold text-emerald-300">赠品已发放</p>
              <p className="text-sm text-mist">{justHanded} · 库存已扣减</p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </PageShell>
  );
}

function PromoRulesEditor({ rules, saleProducts, giftProducts, onSave, onToggle, onRemove, readOnly }) {
  function newDraft() {
    return {
      id: crypto.randomUUID(),
      enabled: true,
      mode: 'all',
      mainProductIds: saleProducts[0]?.id ? [saleProducts[0].id] : [],
      stackable: true,
      gifts: [{ productId: giftProducts[0]?.id || '', qty: 1 }],
      startAt: '',
      endAt: '',
    };
  }

  const [draft, setDraft] = useState(() => ({
    id: crypto.randomUUID(),
    enabled: true,
    mode: 'all',
    mainProductIds: [],
    stackable: true,
    gifts: [{ productId: '', qty: 1 }],
    startAt: '',
    endAt: '',
  }));

  useEffect(() => {
    setDraft((current) => ({
      ...current,
      mainProductIds: current.mainProductIds.length ? current.mainProductIds : (saleProducts[0]?.id ? [saleProducts[0].id] : []),
      gifts: current.gifts.map((gift) => ({ ...gift, productId: gift.productId || giftProducts[0]?.id || '' })),
    }));
  }, [giftProducts, saleProducts]);

  const updateDraft = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const toggleMainProduct = (productId) => setDraft((current) => {
    const selected = current.mainProductIds.includes(productId);
    return { ...current, mainProductIds: selected ? current.mainProductIds.filter((id) => id !== productId) : [...current.mainProductIds, productId] };
  });
  const updateGift = (index, field, value) => setDraft((current) => ({
    ...current,
    gifts: current.gifts.map((gift, giftIndex) => (giftIndex === index ? { ...gift, [field]: value } : gift)),
  }));

  async function submitRule(event) {
    event.preventDefault();
    if (await onSave(draft)) setDraft(newDraft());
  }

  function editRule(rule) {
    setDraft({
      ...rule,
      mainProductIds: rule.mainProductIds.length ? rule.mainProductIds : [],
      gifts: rule.gifts.length ? rule.gifts : [{ productId: giftProducts[0]?.id || '', qty: 1 }],
    });
  }

  function productName(productId) {
    return saleProducts.find((product) => product.id === productId)?.name
      || giftProducts.find((product) => product.id === productId)?.name
      || '商品已删除';
  }

  function mainProductsLabel(rule) {
    if (rule.mainProductIds.length === saleProducts.length && saleProducts.length) return '全部售卖品';
    return rule.mainProductIds.map(productName).join(' / ') || '未选择主品';
  }

  function ruleStatus(rule) {
    if (!rule.enabled) return '已停用';
    return isPromoRuleActive(rule) ? '生效中' : '未到时间';
  }

  const canCreate = saleProducts.length > 0 && giftProducts.length > 0 && !readOnly;
  const selectedMainProducts = saleProducts.filter((product) => draft.mainProductIds.includes(product.id));

  return (
    <div className="glass p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-lg font-bold"><Gift size={19} className="text-coral" /> 加赠玩法</h3>
        <span className="text-sm text-mist">{rules.filter((rule) => rule.enabled).length} 个启用</span>
      </div>

      <form className="grid gap-4 lg:grid-cols-2" onSubmit={submitRule}>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="field-label">玩法</span>
              <select className="field" value={draft.mode} onChange={(e) => updateDraft('mode', e.target.value)} disabled={!canCreate}>
                <option value="all">全部赠送</option>
                <option value="choice">二选一/多选一</option>
              </select>
            </label>
            <label className="block">
              <span className="field-label">赠品是否叠加</span>
              <select className="field" value={draft.stackable ? 'stackable' : 'once'} onChange={(e) => updateDraft('stackable', e.target.value === 'stackable')} disabled={!canCreate}>
                <option value="stackable">叠加赠送</option>
                <option value="once">不叠加</option>
              </select>
            </label>
            <label className="block">
              <span className="field-label">开始时间</span>
              <input className="field" value={draft.startAt} type="datetime-local" onChange={(e) => updateDraft('startAt', e.target.value)} disabled={!canCreate} />
            </label>
            <label className="block">
              <span className="field-label">结束时间</span>
              <input className="field" value={draft.endAt} type="datetime-local" onChange={(e) => updateDraft('endAt', e.target.value)} disabled={!canCreate} />
            </label>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="text-mist">主品 <b className="text-milk">已选 {selectedMainProducts.length}/{saleProducts.length}</b></span>
              <div className="flex gap-2">
                <button type="button" className="text-xs text-coral-soft hover:underline" onClick={() => setDraft((c) => ({ ...c, mainProductIds: saleProducts.map((p) => p.id) }))} disabled={!canCreate}>全选</button>
                <button type="button" className="text-xs text-mist hover:underline" onClick={() => setDraft((c) => ({ ...c, mainProductIds: [] }))} disabled={!canCreate}>清空</button>
              </div>
            </div>
            {!!selectedMainProducts.length && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {selectedMainProducts.map((product) => <span key={product.id} className="chip border-coral/30 bg-coral/10 text-coral-soft">{product.name}</span>)}
              </div>
            )}
            <div className="grid max-h-44 grid-cols-2 gap-1.5 overflow-y-auto sm:grid-cols-3">
              {saleProducts.map((product) => (
                <label
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-xs transition ${
                    draft.mainProductIds.includes(product.id) ? 'border-coral/50 bg-coral/10 text-coral-soft' : 'border-white/10 bg-white/[0.03] text-mist'
                  }`}
                  key={product.id}
                >
                  <input type="checkbox" className="sr-only" checked={draft.mainProductIds.includes(product.id)} onChange={() => toggleMainProduct(product.id)} disabled={!canCreate} />
                  <span className="truncate">{product.name}</span>
                  {draft.mainProductIds.includes(product.id) && <Check size={13} className="shrink-0" />}
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <span className="field-label">{draft.mode === 'choice' ? '二选一/多选一' : '全部赠送'}赠品</span>
          {draft.gifts.map((gift, index) => (
            <div className="flex items-center gap-2" key={`${draft.id}-${index}`}>
              <select className="field flex-1" value={gift.productId} aria-label={`赠品${index + 1}`} onChange={(e) => updateGift(index, 'productId', e.target.value)} disabled={!canCreate}>
                {giftProducts.map((product) => <option value={product.id} key={product.id}>{product.name}{product.productType === 'sale' ? '（可售可赠）' : ''}</option>)}
              </select>
              <input className="field !w-20" value={gift.qty} type="number" min="1" inputMode="numeric" aria-label={`赠品${index + 1}数量`} onChange={(e) => updateGift(index, 'qty', e.target.value)} disabled={!canCreate} />
              <button className="btn-icon !h-10 !w-10 hover:!border-red-400/50 hover:!text-red-300" type="button" aria-label={`删除赠品${index + 1}`} onClick={() => setDraft((c) => ({ ...c, gifts: c.gifts.filter((_, i) => i !== index) }))} disabled={draft.gifts.length <= 1}>
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          <button className="btn-ghost !min-h-[40px] !py-2 text-sm" type="button" onClick={() => setDraft((c) => ({ ...c, gifts: [...c.gifts, { productId: giftProducts[0]?.id || '', qty: 1 }] }))} disabled={!canCreate}>
            <Plus size={15} /> 增加赠品
          </button>
          <button className="btn-primary w-full" type="submit" disabled={!canCreate}><Plus size={17} /> 保存规则</button>
          {!canCreate && <p className="text-xs text-mist">暂无可配置组合：需要售卖品，以及赠品或已启用买赠的售卖品。</p>}
        </div>
      </form>

      <div className="mt-5 space-y-2.5">
        {rules.length === 0 ? (
          <p className="py-8 text-center text-sm text-mist">还没有加赠规则</p>
        ) : (
          rules.map((rule) => (
            <article className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.03] px-4 py-3" key={rule.id}>
              <div className="min-w-0">
                <strong className="block text-sm">
                  {mainProductsLabel(rule)}{rule.mode === 'choice' ? ' 可选 ' : ' 送 '}
                  {rule.gifts.map((gift) => `${productName(gift.productId)} × ${gift.qty}`).join(' / ')}
                </strong>
                <span className="text-xs text-mist">
                  {rule.mode === 'choice' ? '二选一/多选一' : '全部赠送'} · {ruleStatus(rule)}
                  {rule.stackable ? ' · 叠加赠送' : ' · 不叠加'}
                  {rule.startAt ? ` · ${new Date(rule.startAt).toLocaleString('zh-CN')}` : ' · 不限开始'}
                  {rule.endAt ? ` 至 ${new Date(rule.endAt).toLocaleString('zh-CN')}` : ' 至 不限结束'}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button className="btn-ghost !min-h-[36px] !px-3 !py-1 text-xs" onClick={() => editRule(rule)} disabled={readOnly}>编辑</button>
                <button
                  className={`!min-h-[36px] !px-3 !py-1 text-xs ${rule.enabled ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => onToggle(rule.id)}
                  disabled={readOnly}
                >
                  {rule.enabled ? '启用' : '停用'}
                </button>
                <button className="btn-icon !h-9 !w-9 hover:!border-red-400/50 hover:!text-red-300" aria-label="删除加赠规则" onClick={() => onRemove(rule.id)} disabled={readOnly}>
                  <Trash2 size={15} />
                </button>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
