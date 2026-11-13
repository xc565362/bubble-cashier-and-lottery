import React, { useEffect, useRef, useState } from 'react';
import { ImagePlus, PackagePlus } from 'lucide-react';
import { Modal } from '../components/ui.jsx';
import { giftEligibility, canBePromoGift } from '../logic/cartLogic.js';
import { isCoupon } from '../logic/orderLogic.js';
import { imageFileToDataUrl } from '../lib/format.js';

export function ProductImage({ product, size = 'md' }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [product.imageUrl]);
  const dims = size === 'lg' ? 'h-20 w-20' : 'h-12 w-12';
  if (product.imageUrl && !failed) {
    return <img className={`${dims} shrink-0 rounded-xl border border-white/10 object-cover`} src={product.imageUrl} alt={product.name || '商品图片'} onError={() => setFailed(true)} />;
  }
  return (
    <div className={`${dims} flex shrink-0 items-center justify-center rounded-xl border border-white/[0.07] bg-white/[0.05] text-mist/50`} aria-hidden="true">
      <PackagePlus size={size === 'lg' ? 26 : 18} />
    </div>
  );
}

export function ProductModal({ product, onClose, onSave }) {
  const [draft, setDraft] = useState(product);
  const imageInputRef = useRef(null);

  const update = (field, value) => setDraft((current) => ({ ...current, [field]: value }));

  async function uploadProductImage(file) {
    if (!file) return;
    try {
      const dataUrl = await imageFileToDataUrl(file);
      update('imageUrl', dataUrl);
    } catch {
      update('imageUrl', '');
    }
  }

  function updateProductType(value) {
    setDraft((current) => ({
      ...current,
      productType: value,
      giftEligible: value === 'gift' || (value === 'sale' && canBePromoGift(current)),
      price: value !== 'sale' ? 0 : current.price,
      couponAmount: value === 'coupon' ? current.couponAmount || '' : 0,
      stock: value === 'coupon' ? 0 : current.stock,
    }));
  }

  return (
    <Modal
      title={product.name ? '编辑商品' : '新增商品'}
      onClose={onClose}
      footer={<button className="btn-primary w-full" form="product-form">保存商品</button>}
    >
      <form
        id="product-form"
        className="grid grid-cols-2 gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(draft);
        }}
      >
        <label className="col-span-2 block">
          <span className="field-label">产品名称</span>
          <input className="field" value={draft.name} onChange={(e) => update('name', e.target.value)} placeholder="例如 柠檬茶" />
        </label>
        <label className="block">
          <span className="field-label">条码</span>
          <input className="field" value={draft.barcode} autoComplete="off" onChange={(e) => update('barcode', e.target.value)} placeholder="数字、字母或符号条码" />
        </label>
        <label className="block">
          <span className="field-label">货品编码</span>
          <input className="field" value={draft.sku || ''} onChange={(e) => update('sku', e.target.value)} placeholder="例如 DRINK-001" />
        </label>
        <label className="block">
          <span className="field-label">商品分组</span>
          <input className="field" value={draft.group || ''} onChange={(e) => update('group', e.target.value)} placeholder="例如 饮料、饰品、特价区" />
        </label>
        <label className="block">
          <span className="field-label">商品类型</span>
          <select className="field" value={draft.productType || 'sale'} onChange={(e) => updateProductType(e.target.value)}>
            <option value="sale">售卖品</option>
            <option value="gift">赠品</option>
            <option value="coupon">优惠券</option>
          </select>
        </label>
        {(draft.productType || 'sale') === 'sale' && (
          <label className="col-span-2 flex min-h-[44px] cursor-pointer items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-4">
            <input
              type="checkbox"
              aria-label="可参与买赠"
              className="h-5 w-5 accent-[#ff652e]"
              checked={giftEligibility(draft.giftEligible)}
              onChange={(e) => update('giftEligible', e.target.checked)}
            />
            <span className="text-sm">可参与买赠</span>
            <b className={`ml-auto text-xs ${giftEligibility(draft.giftEligible) ? 'text-coral-soft' : 'text-mist/60'}`}>
              {giftEligibility(draft.giftEligible) ? '已启用' : '未启用'}
            </b>
          </label>
        )}
        {isCoupon(draft) && (
          <label className="col-span-2 block">
            <span className="field-label">抵扣金额</span>
            <input className="field" type="number" min="0.01" step="0.01" required value={draft.couponAmount || ''} onChange={(e) => update('couponAmount', e.target.value)} placeholder="0.00" />
          </label>
        )}
        <div className="col-span-2 flex items-center gap-4">
          <ProductImage product={draft} size="lg" />
          <div className="space-y-2">
            <button type="button" className="btn-ghost !min-h-[40px] !py-2 text-sm" onClick={() => imageInputRef.current?.click()}>
              <ImagePlus size={16} /> 上传商品图片
            </button>
            <button type="button" className="block text-sm text-mist underline-offset-2 hover:text-coral-soft hover:underline" onClick={() => update('imageUrl', '')}>
              清除图片
            </button>
          </div>
          <input
            ref={imageInputRef}
            className="hidden"
            type="file"
            accept="image/*"
            onChange={(e) => {
              uploadProductImage(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
        <label className="col-span-2 block">
          <span className="field-label">图片链接</span>
          <input className="field" value={draft.imageUrl || ''} onChange={(e) => update('imageUrl', e.target.value)} placeholder="可填图片网址，或直接上传图片" />
        </label>
        <label className="block">
          <span className="field-label">原价</span>
          <input className="field" value={draft.originalPrice} inputMode="decimal" onChange={(e) => update('originalPrice', e.target.value)} placeholder="0.00" />
        </label>
        <label className="block">
          <span className="field-label">售价</span>
          <input className="field" value={draft.price} inputMode="decimal" disabled={(draft.productType || 'sale') !== 'sale'} onChange={(e) => update('price', e.target.value)} placeholder="0.00" />
        </label>
        <label className="block">
          <span className="field-label">库存数量</span>
          <input className="field" value={draft.stock} disabled={isCoupon(draft)} inputMode="numeric" onChange={(e) => update('stock', e.target.value)} placeholder="0" />
        </label>
      </form>
    </Modal>
  );
}
