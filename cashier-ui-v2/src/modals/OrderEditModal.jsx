import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Modal } from '../components/ui.jsx';
import { money } from '../lib/format.js';
import { isCoupon, priceOrder, orderSerial } from '../logic/orderLogic.js';

export function OrderEditModal({ order, products, onClose, onSave }) {
  const [items, setItems] = useState(() => order.items.map((item) => ({ ...item, editKey: crypto.randomUUID() })));
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState('');
  const [settled, setSettled] = useState(false);
  const zero = order.method === '0元出库';
  const available = products.filter((product) => (!isCoupon(product) || !items.some(isCoupon)) && [product.name, product.barcode, product.sku].some((value) => String(value || '').toLowerCase().includes(search.toLowerCase())));
  let priced;
  let error = '';
  try { priced = priceOrder(items, zero); } catch (issue) { error = issue.message; }
  const difference = priced ? Math.round((priced.total - order.total) * 100) / 100 : 0;

  function update(index, field, value) {
    setItems((current) => current.map((item, position) => position === index ? { ...item, [field]: value } : item));
    setSettled(false);
  }
  function addProduct() {
    const product = products.find((item) => item.id === selected);
    if (!product || (isCoupon(product) && items.some(isCoupon))) return;
    setItems((current) => [...current, { ...product, qty: 1, price: zero ? 0 : product.price, discount: 0, editKey: crypto.randomUUID() }]);
    setSettled(false);
  }

  return (
    <Modal
      title="编辑 / 换货"
      subtitle={orderSerial(order) || '待补齐收钱吧流水号'}
      onClose={onClose}
      wide
      footer={
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
            <span className="text-mist">原订单金额 <b className="text-milk">{money(order.total)}</b></span>
            <strong>换货后金额 <b className="text-coral-soft">{money(priced?.total)}</b></strong>
            <span className="text-mist">{difference >= 0 ? '需补款' : '需退款'} <b className={difference >= 0 ? 'text-amber-300' : 'text-red-300'}>{money(Math.abs(difference))}</b></span>
          </div>
          {difference !== 0 && (
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" className="h-5 w-5 accent-[#ff652e]" checked={settled} onChange={(e) => setSettled(e.target.checked)} />
              已完成{difference > 0 ? '补款' : '退款'} {money(Math.abs(difference))}
            </label>
          )}
          {error && <p className="text-sm text-red-300" role="alert">{error}</p>}
          <button
            className="btn-primary w-full"
            disabled={!!error || (difference !== 0 && !settled)}
            onClick={() => {
              if (error || (difference !== 0 && !settled)) return;
              onSave(order.id, items.map(({ editKey, ...item }) => item));
            }}
          >
            保存换货
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        {order.payment?.provider === 'sqb' && (
          <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-2.5 text-sm text-amber-300">原收钱吧交易金额保留。换货差额请另行完成补款或退款。</p>
        )}
        {items.map((item, index) => {
          const stock = Number(products.find((product) => product.id === item.id)?.stock || 0)
            + order.items.filter((original) => original.id === item.id).reduce((sum, original) => sum + original.qty, 0);
          return (
            <article className="glass px-4 py-3" key={item.editKey}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <strong>{item.name}</strong>
                  <p className="text-xs text-mist">{item.barcode} · {isCoupon(item) ? `优惠券面额 ${money(item.couponAmount)}` : `可用库存 ${stock}`}</p>
                </div>
                <button type="button" className="btn-icon !h-9 !w-9 hover:!border-red-400/50 hover:!text-red-300" aria-label={`移除${item.name}`} onClick={() => { setItems((current) => current.filter((_, position) => position !== index)); setSettled(false); }}>
                  <Trash2 size={15} />
                </button>
              </div>
              {isCoupon(item) ? (
                <p className="mt-2 text-sm text-coral-soft">抵扣 -{money(priced?.items[index]?.couponDeduction)}</p>
              ) : (
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <label className="block">
                    <span className="field-label">数量</span>
                    <input className="field !py-2" type="number" min="1" step="1" required value={item.qty} onChange={(e) => update(index, 'qty', e.target.value)} />
                  </label>
                  <label className="block">
                    <span className="field-label">单价</span>
                    <input className="field !py-2" type="number" min="0" step="0.01" required disabled={zero || item.productType === 'gift'} value={zero ? 0 : item.price} onChange={(e) => update(index, 'price', e.target.value)} />
                  </label>
                  <label className="block">
                    <span className="field-label">优惠金额</span>
                    <input className="field !py-2" type="number" min="0" step="0.01" disabled={zero || item.productType === 'gift'} value={item.discount || 0} onChange={(e) => update(index, 'discount', e.target.value)} />
                  </label>
                </div>
              )}
            </article>
          );
        })}
        <div className="glass grid gap-2 px-4 py-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="block">
            <span className="field-label">查找换入商品</span>
            <input className="field" value={search} onChange={(e) => { setSearch(e.target.value); setSelected(''); }} placeholder="商品名、条码或编码" />
          </label>
          <label className="block">
            <span className="field-label">换入商品</span>
            <select className="field" value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">选择商品</option>
              {available.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.barcode} · {money(product.price)}</option>)}
            </select>
          </label>
          <button type="button" className="btn-ghost" disabled={!selected} onClick={addProduct}><Plus size={16} /> 加入订单</button>
        </div>
      </div>
    </Modal>
  );
}
