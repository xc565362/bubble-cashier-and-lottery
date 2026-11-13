import React from 'react';
import { AnimatePresence, motion } from '../lib/motion.js';
import { X } from 'lucide-react';

export const spring = { type: 'spring', stiffness: 380, damping: 30 };

export function Aurora() {
  return (
    <div className="aurora-bg" aria-hidden="true">
      <div className="absolute -left-40 -top-40 h-[34rem] w-[34rem] animate-aurora rounded-full bg-coral/20 blur-[120px]" />
      <div className="absolute right-[-10%] top-1/3 h-[30rem] w-[30rem] animate-aurora rounded-full bg-amber-glow/10 blur-[130px] [animation-delay:-6s]" />
      <div className="absolute bottom-[-20%] left-1/4 h-[26rem] w-[26rem] animate-aurora rounded-full bg-indigo-500/10 blur-[110px] [animation-delay:-12s]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.04),transparent_55%)]" />
      <div className="aurora-grid absolute inset-0 opacity-[0.35]" />
    </div>
  );
}

export function Modal({ title, subtitle, onClose, children, footer, wide = false, labelledBy }) {
  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/70 p-4 backdrop-blur-md"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === 'string' ? title : labelledBy}
    >
      <motion.div
        className={`glass-strong flex max-h-[92vh] w-full flex-col ${wide ? 'max-w-3xl' : 'max-w-lg'}`}
        initial={{ opacity: 0, y: 28, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 20, scale: 0.97 }}
        transition={spring}
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/[0.06] px-6 py-4">
          <div>
            <h2 className="text-lg font-bold tracking-wide">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-mist">{subtitle}</p>}
          </div>
          {onClose && (
            <button type="button" className="btn-icon -mr-2 h-9 w-9" aria-label="关闭" onClick={onClose}>
              <X size={18} />
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="border-t border-white/[0.06] px-6 py-4">{footer}</div>}
      </motion.div>
    </motion.div>
  );
}

export function Toast({ message }) {
  return (
    <AnimatePresence>
      {message && (
        <motion.div
          key={message}
          className="fixed bottom-24 left-1/2 z-[70] -translate-x-1/2"
          initial={{ opacity: 0, y: 24, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.95 }}
          transition={spring}
          role="status"
        >
          <div className="glass-strong border-coral/30 px-5 py-3 text-sm font-medium shadow-pop">
            {message}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Badge({ tone = 'neutral', children }) {
  const tones = {
    neutral: 'badge-neutral',
    ok: 'badge-ok',
    warn: 'badge-warn',
    danger: 'badge-danger',
    coral: 'badge-coral',
  };
  return <span className={`chip ${tones[tone] || tones.neutral}`}>{children}</span>;
}

export function EmptyState({ icon: Icon, title, hint }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-14 text-center">
      {Icon && <Icon size={34} className="text-mist/50" />}
      <p className="font-semibold text-mist">{title}</p>
      {hint && <p className="max-w-sm text-sm text-mist/60">{hint}</p>}
    </div>
  );
}

export function ConfirmationCheck({ checked, onChange, disabled = false, children }) {
  return (
    <label
      className={`flex min-h-[52px] cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition select-none ${
        checked ? 'border-coral/60 bg-coral/10' : 'border-white/10 bg-white/[0.04]'
      } ${disabled ? 'pointer-events-none opacity-50' : ''}`}
    >
      <span
        className={`flex h-6 w-6 items-center justify-center rounded-md border transition ${
          checked ? 'border-coral bg-coral text-[#fff]' : 'border-white/25 bg-ink-800 text-transparent'
        }`}
      >
        <input type="checkbox" className="sr-only" checked={checked} disabled={disabled} onChange={onChange} />
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8.5 6.5 12 13 4" />
        </svg>
      </span>
      <span className="flex-1 text-sm leading-snug">{children}</span>
      <span className={`text-xs ${checked ? 'text-coral-soft' : 'text-mist/60'}`}>{checked ? '已确认' : '未勾选'}</span>
    </label>
  );
}

export function PageShell({ kicker, title, actions, children }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.28, ease: 'easeOut' }}
      className="mx-auto w-full max-w-7xl px-4 pb-32 pt-5 sm:px-6"
    >
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="kicker">{kicker}</p>
          <h1 className="mt-1 text-2xl font-bold tracking-wide">{title}</h1>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </motion.section>
  );
}
