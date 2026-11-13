import React, { useState } from 'react';
import { motion } from '../lib/motion.js';
import { KeyRound, Loader2, LogIn, User } from 'lucide-react';
import { Aurora, spring } from '../components/ui.jsx';

export function LoginScreen({ busy, error, notice, onSubmit, onRetry, mode }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-4">
      <Aurora />
      <motion.div
        className="glass-strong w-full max-w-md px-8 py-10"
        initial={{ opacity: 0, y: 32, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={spring}
      >
        <motion.div
          className="mx-auto mb-6 flex h-16 w-16 animate-floaty items-center justify-center rounded-2xl bg-gradient-to-br from-coral to-coral-deep shadow-pop"
          initial={{ rotate: -8 }}
          animate={{ rotate: 0 }}
          transition={spring}
        >
          <span className="text-2xl font-black text-[#fff]">泡</span>
        </motion.div>
        <p className="kicker text-center">Bubble · 云端收银</p>
        <h1 className="mt-2 text-center text-3xl font-bold tracking-wide">登录收银台</h1>
        <p className="mt-2 text-center text-sm text-mist">商品、库存、订单与活动配置统一保存在云端。</p>

        {notice && <p className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-2.5 text-sm text-amber-300">{notice}</p>}
        {error && <p className="mt-4 rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-2.5 text-sm text-red-300" role="alert">{error}</p>}

        {mode === 'loading' ? (
          <div className="mt-8 flex items-center justify-center gap-2 text-mist" role="status">
            <Loader2 size={18} className="animate-spin" /> 正在连接云端…
          </div>
        ) : mode === 'error' ? (
          <button className="btn-primary mt-8 w-full" onClick={onRetry}>重新连接</button>
        ) : (
          <form
            className="mt-8 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit({ username, password });
            }}
          >
            <label className="block">
              <span className="field-label">账号</span>
              <div className="relative">
                <User size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-mist/60" />
                <input className="field !pl-11" value={username} autoComplete="username" required maxLength={80} disabled={busy} onChange={(e) => setUsername(e.target.value)} />
              </div>
            </label>
            <label className="block">
              <span className="field-label">密码</span>
              <div className="relative">
                <KeyRound size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-mist/60" />
                <input className="field !pl-11" type="password" value={password} autoComplete="current-password" required maxLength={200} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
              </div>
            </label>
            <motion.button whileTap={{ scale: 0.98 }} className="btn-primary w-full" disabled={busy}>
              {busy ? <Loader2 size={17} className="animate-spin" /> : <LogIn size={17} />}
              {busy ? '正在登录…' : '登录'}
            </motion.button>
          </form>
        )}
      </motion.div>
    </main>
  );
}
