import React from 'react';
import { AnimatePresence, motion } from '../lib/motion.js';
import { Barcode, Camera, Gift, Minus, Pause, Play, Plus, RefreshCw, Search, ShoppingCart, Tags, Ticket, Trash2, WalletCards } from 'lucide-react';
import { spring } from '../components/ui.jsx';
import { money, clampNumber, productTypeLabel } from '../lib/format.js';
import { basketLineKey, isCoupon, isExternalPhysical } from '../logic/orderLogic.js';
import { canBePromoGift } from '../logic/cartLogic.js';
import { ProductImage } from '../modals/ProductModal.jsx';

export function PosScreen({
  products, groups, activeGroup, setActiveGroup,
  cart, query, setQuery, barcodeInput, setBarcodeInput, scanBarcode,
  addToCart, changeQty, changeDiscount,
  giftChoiceQueue, onOpenGiftChoice,
  checkout, onHold, onShowHeld, heldCount, onClearCart, clearing,
  cartTotal, cartSubtotal, cartDiscount,
  openScanner, locked,
}) {
  return (
    <div className="mx-auto grid w-full max-w-[1500px] gap-5 px-4 pb-36 pt-5 sm:px-6 lg:grid-cols-[1fr_400px]">
      {/* 商品区 */}
      <div className="min-w-0 space-y-4">
        <div className="glass flex flex-wrap items-center gap-2 px-4 py-3">
          <button className="btn-ghost !min-h-[44px]" onClick={openScanner}>
            <Camera size={18} /> 摄像头扫码
          </button>
          <form
            className="flex min-w-0 flex-1 items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              scanBarcode(barcodeInput);
            }}
          >
            <div className="relative min-w-0 flex-1">
              <Barcode size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mist/60" />
              <input
                className="field !pl-10"
                value={barcodeInput}
                aria-label="商品或优惠券条码"
                autoComplete="off"
                placeholder="商品 / 优惠券条码"
                onChange={(event) => setBarcodeInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Tab' && barcodeInput.trim()) { event.preventDefault(); scanBarcode(barcodeInput); } }}
              />
            </div>
            <button type="submit" className="btn-primary !min-h-[44px] shrink-0">确认</button>
          </form>
        </div>

        <div className="relative">
          <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mist/60" />
          <input className="field !pl-10" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索商品名、条码或编码" />
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1" aria-label="商品分组筛选">
          {groups.map((group) => (
            <button
              key={group}
              onClick={() => setActiveGroup(group)}
              className={`flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition active:scale-95 ${
                activeGroup === group
                  ? 'border-coral/60 bg-coral/15 text-coral-soft shadow-pop'
                  : 'border-white/10 bg-white/[0.04] text-mist hover:border-white/25'
              }`}
            >
              <Tags size={14} />
              {group}
            </button>
          ))}
        </div>

        <motion.div layout className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          <AnimatePresence mode="popLayout">
            {products.map((product) => {
              const out = !isCoupon(product) && Number(product.stock || 0) <= 0;
              return (
                <motion.button
                  layout
                  key={product.id}
                  className="glass group relative flex flex-col items-stretch gap-2 overflow-hidden p-3 text-left transition hover:border-coral/50 hover:shadow-pop disabled:opacity-45"
                  onClick={() => addToCart(product)}
                  disabled={out || locked}
                  initial={{ opacity: 0, scale: 0.92 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  whileHover={!out && !locked ? { y: -3 } : undefined}
                  whileTap={!out && !locked ? { scale: 0.96 } : undefined}
                  transition={spring}
                >
                  <div className="flex items-start justify-between gap-2">
                    <ProductImage product={product} />
                    <span className={`chip !px-2 !py-0.5 text-[10px] ${
                      isCoupon(product)
                        ? 'border-coral/40 bg-coral/15 text-coral-soft'
                        : product.productType === 'gift'
                          ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                          : 'border-white/15 bg-white/[0.06] text-mist'
                    }`}>
                      {productTypeLabel(product.productType)}{product.productType === 'sale' && canBePromoGift(product) ? ' · 可赠送' : ''}
                    </span>
                  </div>
                  <span className="line-clamp-2 min-h-[2.5em] text-[15px] font-semibold leading-snug">{product.name}</span>
                  <strong className="text-lg text-coral-soft">{isCoupon(product) ? `抵扣 ${money(product.couponAmount)}` : money(product.price)}</strong>
                  <small className="truncate font-mono text-[11px] text-mist/70">{product.barcode}</small>
                  <small className="truncate text-[11px] text-mist/60">{product.group || '未分组'} · {product.sku || '无编码'} · {isCoupon(product) ? '每单限一张' : `库存 ${product.stock}`}</small>
                  {out && <em className="absolute right-3 top-3 rounded-md bg-red-500/80 px-2 py-0.5 text-[11px] font-bold not-italic text-[#fff]">无库存</em>}
                </motion.button>
              );
            })}
          </AnimatePresence>
        </motion.div>
        {!products.length && (
          <div className="glass flex flex-col items-center gap-2 py-16 text-center text-mist">
            <ShoppingCart size={30} />
            <p>没有匹配的商品</p>
          </div>
        )}
      </div>

      {/* 购物车 */}
      <aside className="glass-strong sticky top-[72px] flex max-h-[calc(100vh-96px)] flex-col self-start overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <h2 className="flex items-center gap-2 text-lg font-bold"><ShoppingCart size={19} className="text-coral" /> 购物车</h2>
          <motion.span
            key={cartTotal}
            className="text-xl font-black text-coral-soft"
            initial={{ scale: 1.18 }}
            animate={{ scale: 1 }}
            transition={spring}
          >
            {money(cartTotal)}
          </motion.span>
        </div>
        <div className="flex gap-2 border-b border-white/[0.06] px-5 py-3">
          <button className="btn-ghost flex-1 !min-h-[40px] !py-2 text-sm" onClick={onHold} disabled={!cart.length}><Pause size={15} /> 挂起</button>
          <button className="btn-ghost flex-1 !min-h-[40px] !py-2 text-sm" onClick={onShowHeld}><Play size={15} /> 挂单 ({heldCount})</button>
          <button className="btn-ghost flex-1 !min-h-[40px] !py-2 text-sm" onClick={onClearCart} disabled={!cart.length || clearing} title="清空购物车">
            {clearing ? <RefreshCw size={15} className="animate-spin" /> : <Trash2 size={15} />} 清空
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {cart.length === 0 ? (
            <div className="flex h-full min-h-[180px] flex-col items-center justify-center gap-2 text-mist/60">
              <ShoppingCart size={30} />
              <p className="text-sm">扫码或点商品开始收银</p>
            </div>
          ) : (
            <ul className="space-y-2.5">
              <AnimatePresence initial={false}>
                {cart.map((item) => (
                  <motion.li
                    layout
                    key={basketLineKey(item)}
                    initial={{ opacity: 0, x: 42, scale: 0.95 }}
                    animate={{ opacity: 1, x: 0, scale: 1 }}
                    exit={{ opacity: 0, x: -30, scale: 0.94 }}
                    transition={spring}
                  >
                    {isCoupon(item) ? (
                      <div className="flex items-center justify-between gap-3 rounded-xl border border-coral/35 bg-coral/[0.08] px-4 py-3">
                        <div className="min-w-0">
                          <strong className="flex items-center gap-1.5 text-sm"><Ticket size={15} className="shrink-0 text-coral" /> <span className="truncate">{item.name}</span></strong>
                          <p className="mt-0.5 text-xs text-mist">券面额 {money(item.couponAmount)} · 每单一张</p>
                          <p className="text-xs text-coral-soft">本单抵扣 {money(item.couponDeduction)}</p>
                        </div>
                        <b className="shrink-0 text-coral-soft">-{money(item.couponDeduction)}</b>
                        <button className="btn-icon !h-9 !w-9 shrink-0 hover:!border-red-400/50 hover:!text-red-300" aria-label={`移除优惠券${item.name}`} title="移除优惠券" onClick={() => changeQty(basketLineKey(item), -1)}>
                          <Trash2 size={15} />
                        </button>
                      </div>
                    ) : (
                      <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-4 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <strong className="block truncate text-sm">{item.name}</strong>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {item.source === 'promo' && <span className="chip !px-2 !py-0 border-emerald-400/30 bg-emerald-400/10 text-[10px] text-emerald-300">活动赠送 · 免费</span>}
                              {isExternalPhysical(item) && <span className="chip !px-2 !py-0 border-coral/40 bg-coral/15 text-[10px] text-coral-soft">抽奖赠品 · 免费</span>}
                              {item.prize && <span className="chip !px-2 !py-0 border-coral/40 bg-coral/15 text-[10px] text-coral-soft">奖品 · 免费</span>}
                            </div>
                            <p className="mt-1 text-xs text-mist">{money(item.price)} × {item.qty} · 库存 {item.stock}</p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button className="btn-icon !h-9 !w-9" aria-label="减少数量" onClick={() => changeQty(basketLineKey(item), -1)}><Minus size={15} /></button>
                            <motion.b key={item.qty} initial={{ scale: 1.3 }} animate={{ scale: 1 }} className="w-7 text-center text-base">{item.qty}</motion.b>
                            <button
                              className="btn-icon !h-9 !w-9"
                              aria-label="增加数量"
                              onClick={() => (item.productType === 'gift' ? changeQty(basketLineKey(item), 1) : addToCart(item))}
                              disabled={isExternalPhysical(item) || item.prize || cart.filter((line) => line.id === item.id).reduce((sum, line) => sum + line.qty, 0) >= Number(item.stock || 0)}
                            >
                              <Plus size={15} />
                            </button>
                          </div>
                        </div>
                        {giftChoiceQueue
                          .filter((choice) => item.productType === 'sale' && choice.mainProductId === item.id)
                          .map((choice) => (
                            <button className="btn-ghost mt-2 w-full !min-h-[36px] !py-1.5 text-xs !border-coral/40 !text-coral-soft" key={choice.id} onClick={() => onOpenGiftChoice(choice.id)}>
                              <Gift size={14} /> 选择赠品
                            </button>
                          ))}
                        <div className="mt-2 flex items-center gap-2">
                          <label className="flex flex-1 items-center gap-2 text-xs text-mist">
                            优惠
                            <input
                              className="field !min-h-[36px] !py-1 !text-sm"
                              value={item.discount || ''}
                              disabled={item.productType === 'gift'}
                              inputMode="decimal"
                              placeholder="0"
                              onChange={(event) => changeDiscount(basketLineKey(item), event.target.value)}
                            />
                          </label>
                          <span className="shrink-0 text-xs text-mist">优惠后 <b className="text-milk">{money(Math.max(0, item.price * item.qty - clampNumber(item.discount, 0, item.price * item.qty)))}</b></span>
                        </div>
                      </div>
                    )}
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
        </div>

        <div className="space-y-1 border-t border-white/[0.06] px-5 py-3 text-sm">
          <div className="flex justify-between text-mist"><span>商品原金额</span><b className="text-milk">{money(cartSubtotal)}</b></div>
          <div className="flex justify-between text-mist"><span>优惠金额</span><b className="text-milk">{money(cartDiscount)}</b></div>
          <div className="flex justify-between pt-1 text-base font-bold"><span>实收</span><span className="text-coral-soft">{money(cartTotal)}</span></div>
        </div>
        <div className="space-y-2 px-5 pb-5">
          <div className="grid grid-cols-2 gap-2">
            <button className="btn-ghost" disabled={!cart.some((item) => !isCoupon(item)) || locked} onClick={() => checkout('0元出库')}>0元出库</button>
            <button className="btn-ghost" disabled={!cart.some((item) => !isCoupon(item)) || locked} onClick={() => checkout('扫码收款')}>
              <WalletCards size={17} /> 生成收款码
            </button>
          </div>
          <motion.button
            whileTap={{ scale: 0.98 }}
            className="btn-primary w-full !py-4 text-lg"
            disabled={!cart.some((item) => !isCoupon(item)) || locked}
            onClick={() => checkout('收钱吧')}
          >
            <Barcode size={19} /> {cart.length && cartTotal === 0 ? '零元结算' : '收钱吧收款'}
          </motion.button>
        </div>
      </aside>
    </div>
  );
}
