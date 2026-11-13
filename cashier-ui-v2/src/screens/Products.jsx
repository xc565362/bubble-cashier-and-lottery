import React, { useRef } from 'react';
import { AnimatePresence, motion } from '../lib/motion.js';
import { Download, FileSpreadsheet, ImagePlus, Pencil, Plus, Search, Tags, Trash2, Upload, WalletCards } from 'lucide-react';
import { PageShell } from '../components/ui.jsx';
import { money, productTypeLabel } from '../lib/format.js';
import { isCoupon } from '../logic/orderLogic.js';
import { canBePromoGift, giftEligibility } from '../logic/cartLogic.js';
import { ProductImage } from '../modals/ProductModal.jsx';

export function ProductsScreen({
  products, groups, activeGroup, setActiveGroup, query, setQuery,
  paymentQr, onNew, onEdit, onRemove, onImport, onTemplate, onPaymentQr,
  onBackup, onMigrate,
  readOnly, isAdmin,
}) {
  const importRef = useRef(null);
  const qrRef = useRef(null);

  return (
    <PageShell
      kicker="Inventory"
      title="商品与库存"
      actions={
        isAdmin && (
          <>
            <button className="btn-ghost text-sm" onClick={() => importRef.current?.click()}><Upload size={16} /> 导入商品</button>
            <button className="btn-ghost text-sm" onClick={onTemplate}><FileSpreadsheet size={16} /> 下载模板</button>
            <button className="btn-ghost text-sm" onClick={() => qrRef.current?.click()}><ImagePlus size={16} /> {paymentQr ? '更换收款码' : '上传收款码'}</button>
            <button className="btn-ghost text-sm" onClick={onBackup}><Download size={16} /> 导出备份</button>
            <button className="btn-ghost text-sm" onClick={onMigrate}><Upload size={16} /> 资料迁移</button>
            <button className="btn-primary" onClick={onNew} disabled={readOnly}><Plus size={17} /> 新商品</button>
            <input ref={importRef} className="hidden" type="file" accept=".csv,.xlsx,.xls" onChange={(e) => { onImport(e.target.files?.[0]); e.target.value = ''; }} />
            <input ref={qrRef} className="hidden" type="file" accept="image/*" onChange={(e) => { onPaymentQr(e.target.files?.[0]); e.target.value = ''; }} />
          </>
        )
      }
    >
      {!isAdmin && (
        <p className="mb-4 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-mist">
          商品、库存和赠品规则由管理员维护。收银员可以在「收银」中使用已保存的商品。
        </p>
      )}
      <p className="mb-4 text-xs text-mist/70">
        商品类型：售卖品 / 赠品 / 优惠券。优惠券金额使用“抵扣金额”列，条码列使用文本格式。资料统一保存在云端，换电脑后登录即可继续使用；原本机资料请通过「资料迁移」导入空的云端账本。
      </p>

      <div className="relative mb-3">
        <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mist/60" />
        <input className="field !pl-10" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索商品名、条码或编码" />
      </div>
      <div className="mb-4 flex gap-2 overflow-x-auto pb-1" aria-label="商品分组筛选">
        {groups.map((group) => (
          <button
            key={group}
            onClick={() => setActiveGroup(group)}
            className={`flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition active:scale-95 ${
              activeGroup === group ? 'border-coral/60 bg-coral/15 text-coral-soft' : 'border-white/10 bg-white/[0.04] text-mist hover:border-white/25'
            }`}
          >
            <Tags size={14} /> {group}
          </button>
        ))}
      </div>

      <div className="space-y-2.5">
        <AnimatePresence initial={false}>
          {products.map((product) => (
            <motion.article
              layout
              key={product.id}
              className="glass flex items-center gap-4 px-4 py-3"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96 }}
            >
              <ProductImage product={product} />
              <button className="min-w-0 flex-1 text-left" onClick={() => isAdmin && !readOnly && onEdit(product)} disabled={!isAdmin || readOnly}>
                <strong className="block truncate text-[15px]">{product.name}</strong>
                <span className="block truncate text-xs text-mist">
                  {productTypeLabel(product.productType)}{product.productType === 'sale' && canBePromoGift(product) ? ' · 可参与买赠' : ''} · {product.group || '未分组'} · {product.barcode} · {product.sku || '无编码'}
                </span>
              </button>
              <div className="shrink-0 text-right">
                <b className="text-coral-soft">{isCoupon(product) ? `抵扣 ${money(product.couponAmount)}` : money(product.price)}</b>
                <p className="text-xs text-mist">{isCoupon(product) ? '每单一张 · 不扣库存' : `原价 ${money(product.originalPrice)} · 库存 ${product.stock}`}</p>
              </div>
              {isAdmin && (
                <div className="flex shrink-0 gap-1.5">
                  <button className="btn-icon !h-10 !w-10" aria-label={`编辑${product.name}`} disabled={readOnly} onClick={() => onEdit(product)}><Pencil size={15} /></button>
                  <button className="btn-icon !h-10 !w-10 hover:!border-red-400/50 hover:!text-red-300" aria-label={`删除${product.name}`} disabled={readOnly} onClick={() => onRemove(product.id)}><Trash2 size={15} /></button>
                </div>
              )}
            </motion.article>
          ))}
        </AnimatePresence>
        {!products.length && <p className="glass py-12 text-center text-mist">暂无匹配商品</p>}
      </div>

      {isAdmin && (
        <p className="mt-8 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-mist">
          加赠玩法已移至赠品页
        </p>
      )}
    </PageShell>
  );
}
