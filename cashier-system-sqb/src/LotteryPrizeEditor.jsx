import React, { useState } from 'react';
import { X } from 'lucide-react';
import { availablePrizeProducts, safePrizeImage } from './lotterySettings.js';

export function LotteryPrizeEditor({ editor, products, onSave, onClose }) {
  const [value, setValue] = useState(() => ({ ...editor.prize }));
  const [error, setError] = useState('');
  const fresh = editor.mode !== 'edit';
  const choices = availablePrizeProducts(products);
  const set = (field, next) => { setValue(old => ({ ...old, [field]: next })); setError(''); };
  function selectProduct(id) {
    const p = choices.find(item => item.id === id);
    setValue(old => ({ ...old, product: p ? { id: p.id, name: p.name, sku: p.sku || '', barcode: p.barcode || '' } : undefined,
      name: p?.name || old.name, shortName: p ? p.name.slice(0, 16) : old.shortName,
      imageUrl: safePrizeImage(p?.imageUrl) || '', icon: '' }));
  }
  function submit(event) {
    event.preventDefault();
    const item = { ...value, name: value.name.trim(), shortName: (value.shortName || value.name).trim(), imageUrl: (value.imageUrl || '').trim() };
    if (!item.name || item.name.length > 60 || item.shortName.length > 24) return setError('请填写奖品名称（最多 60 字）和展示短名（最多 24 字）');
    if (item.imageUrl && !safePrizeImage(item.imageUrl)) return setError('图片须为公开可访问的 HTTPS 地址');
    if (fresh && item.kind === 'physical' && !choices.some(p => p.id === item.product?.id)) return setError('请选择具有唯一货品编码或条码的库存商品');
    if (item.kind === 'cash') {
      item.amount = Number(item.amount); item.minimumCents = Math.round(Number(item.minimumCents));
      if (!Number.isFinite(item.amount) || item.amount <= 0 || item.amount > 10000 || Math.abs(item.amount * 100 - Math.round(item.amount * 100)) > 0.000001 || !Number.isSafeInteger(item.minimumCents) || item.minimumCents < 0) return setError('券面额须为 0.01 至 10000 元，门槛不得小于 0');
      delete item.product;
    } else { item.amount = 0; item.minimumCents = 0; }
    onSave(item);
  }
  return <div className="modalBackdrop"><form className="modal lotteryModal lotteryPrizeEditor" role="dialog" aria-modal="true" aria-label={editor.mode === 'edit' ? '编辑奖品展示' : editor.mode === 'replace' ? '更换奖品' : '新增奖项'} onSubmit={submit}>
    <div className="sectionHeader"><h2>{editor.mode === 'edit' ? '编辑奖品展示' : editor.mode === 'replace' ? '更换奖品' : '新增奖项'}</h2><button type="button" className="iconButton" aria-label="关闭奖品编辑" onClick={onClose}><X size={20} /></button></div>
    {editor.mode === 'replace' && <p className="lotteryNotice">原奖项停止后续抽取，已有中奖凭证继续领取原奖品。新奖项接收原奖项的剩余名额和概率，可在保存前调整。</p>}
    {error && <p className="dangerText" role="alert">{error}</p>}
    <label>奖品类型<select value={value.kind} disabled={!fresh} onChange={e => set('kind', e.target.value)}><option value="physical">实物奖品</option><option value="cash">购物抵扣券</option></select></label>
    {value.kind === 'physical' && (fresh ? <><label>核销时扣库存的商品<select required value={value.product?.id || ''} onChange={e => selectProduct(e.target.value)}><option value="">选择库存商品</option>{choices.map(p => <option key={p.id} value={p.id}>{p.name} · {p.sku || p.barcode} · 库存 {p.stock}</option>)}</select></label><p className="lotteryHelp">每次核销发放 1 件。若商品未列出，请先在商品管理中补齐货品编码或条码，并消除重复编码。</p></> : <p className="lotteryHelp">核销商品：{value.product?.name || '原活动商品绑定'}。需要换商品时，请使用「更换奖品」。</p>)}
    {value.kind === 'cash' && <div className="lotteryFields"><label>面额（元）<input type="number" min="0.01" max="10000" step="0.01" required disabled={!fresh} value={value.amount} onChange={e => set('amount', e.target.value)} /></label><label>使用门槛（元）<input type="number" min="0" step="0.01" required disabled={!fresh} value={value.minimumCents / 100} onChange={e => set('minimumCents', Math.round(Number(e.target.value) * 100))} /></label></div>}
    <label>奖品名称<input autoFocus value={value.name} onChange={e => set('name', e.target.value)} maxLength={60} required /></label>
    <label>手机展示短名<input value={value.shortName} onChange={e => set('shortName', e.target.value)} maxLength={24} required /></label>
    <label>奖品图片地址<input type="url" placeholder="https://…" value={value.imageUrl} onChange={e => set('imageUrl', e.target.value)} maxLength={2048} /></label>
    <p className="lotteryHelp">填写公开可访问的 HTTPS 图片地址。留空使用默认插图；选择商品时会带入已有的 HTTPS 图片。</p>
    {safePrizeImage(value.imageUrl) && <img className="lotteryImagePreview" src={safePrizeImage(value.imageUrl)} alt="奖品图片预览" referrerPolicy="no-referrer" />}
    <div className="lotteryActions"><button className="submitButton" type="submit">应用到待保存配置</button><button className="utilityButton" type="button" onClick={onClose}>取消</button></div>
  </form></div>;
}
