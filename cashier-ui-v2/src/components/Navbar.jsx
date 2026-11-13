import React, { useState } from 'react';
import { AnimatePresence, motion } from '../lib/motion.js';
import { Activity, Cloud, LogOut, Moon, RefreshCw, Sun } from 'lucide-react';
import { Badge } from './ui.jsx';

const ROLE_LABELS = { admin: '管理员', cashier: '收银员', redeemer: '核销员' };

export function Navbar({ user, lease, cloudBusy, revision, onRefresh, onLogout }) {
  const [theme, setTheme] = useState(() => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'));

  function toggleTheme() {
    const next = theme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try { window.localStorage.setItem('bubble-theme', next); } catch {}
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', next === 'light' ? '#ffffff' : '#0b0d10');
    setTheme(next);
  }

  const pipeHeldByOther = Boolean(lease?.held && !lease?.mine);
  return (
    <header className="app-header sticky top-0 z-40 border-b border-white/[0.06] bg-ink-900/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2.5">
          <motion.div
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-coral to-coral-deep shadow-pop"
            whileHover={{ rotate: -6, scale: 1.05 }}
          >
            <span className="text-lg font-black text-[#fff]">泡</span>
          </motion.div>
          <div className="leading-tight">
            <p className="text-[15px] font-bold tracking-wide">Bubble 收银台</p>
            <p className="text-[11px] text-mist">云端共享账本 · 数据版本 {revision}</p>
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Badge tone={cloudBusy ? 'warn' : 'ok'}>
            {cloudBusy ? <RefreshCw size={13} className="animate-spin" /> : <Cloud size={13} />}
            {cloudBusy ? '云端同步中' : '云端已连接'}
          </Badge>
          {pipeHeldByOther && (
            <Badge tone="coral">
              <Activity size={13} />
              收款中 · {lease.displayName || '其他终端'}
            </Badge>
          )}
          <Badge tone="coral">{user.displayName || user.username} · {ROLE_LABELS[user.role] || '收银员'}</Badge>

          <button className="btn-ghost !min-h-[38px] !px-3 !py-1.5 text-sm" disabled={cloudBusy} onClick={onRefresh}>
            <RefreshCw size={15} /> 刷新
          </button>
          <button
            className="btn-icon !h-9 !w-9"
            aria-label={theme === 'light' ? '切换到深色模式' : '切换到浅色模式'}
            title={theme === 'light' ? '切换到深色模式' : '切换到浅色模式'}
            onClick={toggleTheme}
          >
            <span className="flex" key={theme}>
              {theme === 'light' ? <Sun size={16} /> : <Moon size={16} />}
            </span>
          </button>
          <button className="btn-icon !h-9 !w-9" aria-label="退出登录" title="退出登录" disabled={cloudBusy} onClick={onLogout}>
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </header>
  );
}
