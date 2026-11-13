import React from 'react';
import { motion } from '../lib/motion.js';
import { Gift, PackagePlus } from 'lucide-react';
import { Modal } from '../components/ui.jsx';
import { canBePromoGift } from '../logic/cartLogic.js';

export function GiftChoiceModal({ choice, products, cart, onChoose, onClose }) {
  return (
    <Modal title="选择赠品" subtitle={`${choice.mainProductName} 已加入购物车，请选择本次要赠送的商品`} onClose={onClose} wide>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {choice.gifts.map((gift) => {
          const product = products.find((item) => item.id === gift.productId && canBePromoGift(item));
          const stock = Math.max(0, Number(product?.stock || 0) - cart.filter((item) => item.id === gift.productId).reduce((sum, item) => sum + Number(item.qty), 0));
          return (
            <motion.button
              whileHover={{ scale: stock >= gift.qty ? 1.03 : 1 }}
              whileTap={{ scale: stock >= gift.qty ? 0.97 : 1 }}
              className="glass flex flex-col items-center gap-2 px-4 py-5 text-center transition hover:border-coral/40 disabled:opacity-40"
              key={`${choice.id}-${gift.productId}`}
              onClick={() => onChoose(choice, gift.productId)}
              disabled={stock < gift.qty}
            >
              {product?.imageUrl ? (
                <img src={product.imageUrl} alt={gift.name} className="h-16 w-16 rounded-xl object-cover" />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-coral/10 text-coral"><Gift size={26} /></div>
              )}
              <span className="text-sm font-semibold">{gift.name}</span>
              <strong className="text-coral-soft">赠送 × {gift.qty}</strong>
              <small className="text-xs text-mist">可用库存 {stock}</small>
              {stock < gift.qty && <em className="text-xs not-italic text-red-300">库存不足</em>}
            </motion.button>
          );
        })}
      </div>
      {!choice.gifts.length && (
        <p className="flex items-center justify-center gap-2 py-8 text-mist"><PackagePlus size={18} /> 暂无可选赠品</p>
      )}
    </Modal>
  );
}
