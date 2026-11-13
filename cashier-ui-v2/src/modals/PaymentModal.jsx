import React, { useEffect, useRef, useState } from 'react';
import { motion } from '../lib/motion.js';
import { Pause, QrCode, X } from 'lucide-react';
import { Modal } from '../components/ui.jsx';
import { money } from '../lib/format.js';
import { basketLineKey, isCoupon, isExternalPhysical } from '../logic/orderLogic.js';

export function PaymentModal({ order, paymentQr, onClose, onPaid, onZero, onHold }) {
  const title = order.method === '0元出库' ? '0元出库' : order.total === 0 ? '零元结算' : '订单收款';
  return (
    <Modal
      title={title}
      subtitle={order.orderNo}
      onClose={onClose}
      wide
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-ghost" onClick={onHold}><Pause size={16} /> 挂起</button>
          {order.method !== '0元出库' && <button className="btn-ghost" onClick={onZero}>0元出库</button>}
          <motion.button whileTap={{ scale: 0.97 }} className="btn-primary ml-auto !px-8 !py-3.5 text-lg" onClick={onPaid}>
            {order.method === '0元出库' ? '确认0元出库' : order.total === 0 ? '确认零元结算' : '确认收款'}
          </motion.button>
        </div>
      }
    >
      <div className="grid gap-5 sm:grid-cols-[1fr_auto]">
        <div className="space-y-4">
          <motion.div
            className="glass px-6 py-5 text-center"
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
          >
            <p className="text-xs uppercase tracking-[0.25em] text-mist">应收金额</p>
            <p className="mt-1 text-5xl font-black tracking-tight text-coral-soft">{money(order.total)}</p>
            <p className="mt-2 text-xs text-mist">原金额 {money(order.subtotal ?? order.total)} · 优惠 {money(order.discount || 0)}</p>
          </motion.div>
          <div className="space-y-1.5">
            {order.items.map((item) => (
              <div key={`${order.id}-${basketLineKey(item)}`} className="flex items-center justify-between rounded-lg bg-white/[0.04] px-3 py-2 text-sm">
                <span>
                  {item.name} × {item.qty}
                  {isExternalPhysical(item) && <span className="ml-1 text-coral-soft">· 抽奖赠品 · 免费</span>}
                  {item.prize && <span className="ml-1 text-coral-soft">· 奖品 · 免费</span>}
                </span>
                <span className="text-mist">
                  {isCoupon(item) ? `抵扣 -${money(item.couponDeduction)}` : money(item.price)}
                  {item.discount > 0 ? ` · 优惠 ${money(item.discount)}` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="flex w-56 flex-col items-center justify-center gap-3">
          {order.method === '0元出库' ? (
            <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-center text-sm text-amber-300">本单全部商品按 0 元出库</p>
          ) : order.total === 0 ? (
            <p className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-3 text-center text-sm text-emerald-300">本单无需收款</p>
          ) : paymentQr ? (
            <img className="w-52 rounded-xl border border-white/10 bg-[#fff] p-2" src={paymentQr} alt="收款码" />
          ) : (
            <div className="flex h-52 w-52 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 text-mist">
              <QrCode size={56} />
              <p className="px-4 text-center text-xs">请先在「商品」中上传你的微信或支付宝收款码</p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
