import React from 'react';
import { Play, Trash2 } from 'lucide-react';
import { Modal } from '../components/ui.jsx';
import { money } from '../lib/format.js';
import { priceOrder } from '../logic/orderLogic.js';

export function HeldCartsModal({ heldCarts, onClose, onResume, onDelete }) {
  return (
    <Modal title={`挂单 (${heldCarts.length})`} onClose={onClose}>
      {!heldCarts.length ? (
        <p className="py-10 text-center text-mist">暂无挂单</p>
      ) : (
        <div className="space-y-3">
          {heldCarts.map((held) => (
            <article className="glass flex items-center justify-between gap-4 px-4 py-3" key={held.id}>
              <div className="min-w-0">
                <div className="flex items-baseline gap-3">
                  <strong className="text-lg text-coral-soft">{money(priceOrder(held.items).total)}</strong>
                  <span className="text-xs text-mist">{new Date(held.createdAt).toLocaleString('zh-CN')}</span>
                </div>
                <p className="mt-1 truncate text-sm text-mist">{held.items.map((item) => `${item.name} × ${item.qty}`).join('，')}</p>
                {!!held.giftChoiceQueue?.length && <p className="mt-0.5 text-xs text-amber-300">待选赠品 {held.giftChoiceQueue.length} 组</p>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button className="btn-primary !min-h-[40px] !px-4 !py-2 text-sm" onClick={() => onResume(held.id)}><Play size={15} /> 取单</button>
                <button className="btn-icon !h-10 !w-10 hover:!border-red-400/50 hover:!text-red-300" aria-label="删除挂单" onClick={() => onDelete(held.id)}><Trash2 size={16} /></button>
              </div>
            </article>
          ))}
        </div>
      )}
    </Modal>
  );
}
