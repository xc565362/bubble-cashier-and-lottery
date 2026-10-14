import React, { useEffect, useRef, useState } from 'react';
import { detectOnlineSession, onlineRequest, setOnlineSession } from './onlineApi.js';
import './online.css';

export function OnlineGate({ children }) {
  const [mode, setMode] = useState('loading'), [session, setSession] = useState(null), [initial, setInitial] = useState(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const working = useRef(false);
  async function accept(value) {
    setOnlineSession(value);
    const snapshot = await onlineRequest('ledger');
    setInitial(snapshot); setSession(value); setMode('online');
  }
  async function check() {
    setMode('loading'); setError('');
    try { const value = await detectOnlineSession(); if (!value) setMode('local'); else if (value.user) await accept(value); else setMode('login'); }
    catch (issue) { setError(issue.message); setMode('error'); }
  }
  useEffect(() => {
    check();
    const expired = () => { setOnlineSession(null); setSession(null); setInitial(null); setMode('login'); setError('登录已失效，请重新登录。未完成交易保存在云端。'); };
    window.addEventListener('online-session-expired', expired);
    return () => window.removeEventListener('online-session-expired', expired);
  }, []);
  async function login(event) {
    event.preventDefault(); if (working.current) return;
    working.current = true; setBusy(true); setError('');
    const form = event.currentTarget, input = Object.fromEntries(new FormData(form));
    try { const value = await onlineRequest('login', { method: 'POST', body: input, allowUnauthorized: true }); form.reset(); await accept(value); }
    catch (issue) { setError(issue.message); }
    finally { working.current = false; setBusy(false); }
  }
  async function logout() {
    try { await onlineRequest('logout', { method: 'POST', body: {} }); setOnlineSession(null); setSession(null); setInitial(null); setMode('login'); setError(''); }
    catch (issue) { setError(issue.message); }
  }
  if (mode === 'local') return children(null);
  if (mode === 'online') return children({ session, initial, logout, notice: error });
  return <main className="onlineLogin"><section className="onlineLoginCard">
    <p className="kicker">Bubble · 云端收银</p><h1>登录收银台</h1>
    <p>商品、库存、订单与活动配置统一保存在云端。</p>
    {error && <p className="dangerText" role="alert">{error}</p>}
    {mode === 'loading' ? <p role="status">正在连接云端…</p> : mode === 'error' ? <button className="submitButton" onClick={check}>重新连接</button> :
      <form onSubmit={login}><label>账号<input name="username" autoComplete="username" required maxLength={80} disabled={busy} /></label>
        <label>密码<input name="password" type="password" autoComplete="current-password" required maxLength={200} disabled={busy} /></label>
        <button className="submitButton" disabled={busy}>{busy ? '正在登录…' : '登录'}</button></form>}
  </section></main>;
}

export function OnlineAccountPage({ user, onImport }) {
  const [users, setUsers] = useState([]), [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const file = useRef(null), working = useRef(false);
  async function load() { if (user.role === 'admin') { const data = await onlineRequest('users'); setUsers(data.users); } }
  useEffect(() => { load().catch(issue => setError(issue.message)); }, []);
  async function run(work, success) {
    if (working.current) return; working.current = true; setBusy(true); setError(''); setMessage('');
    try { await work(); setMessage(success || '已保存'); await load(); } catch (issue) { setError(issue.message); }
    finally { working.current = false; setBusy(false); }
  }
  return <section className="workspace fullWorkspace onlineAccounts"><div className="sectionHeader"><h2>账号与资料</h2></div>
    <p>当前账号：{user.displayName || user.username} · {user.role === 'admin' ? '管理员' : '收银员'}</p>
    {error && <p className="dangerText" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {user.role === 'admin' ? <>
      <h3>人员账号</h3><div className="onlineUserList">{users.map(person => <div key={person.id} className="onlineUser">
        <div><strong>{person.displayName || person.username}</strong><small>{person.username} · {person.disabled ? '已停用' : '可登录'}</small></div>
        <select aria-label={`${person.username}角色`} value={person.role} disabled={busy} onChange={event => run(() => onlineRequest(`users/${encodeURIComponent(person.id)}`, { method: 'PATCH', body: { role: event.target.value } }))}><option value="cashier">收银员</option><option value="admin">管理员</option></select>
        <button className="utilityButton" disabled={busy || person.id === user.id} onClick={() => run(() => onlineRequest(`users/${encodeURIComponent(person.id)}`, { method: 'PATCH', body: { disabled: !person.disabled } }))}>{person.disabled ? '启用' : '停用'}</button>
        <form onSubmit={event => { event.preventDefault(); const form = event.currentTarget, password = new FormData(form).get('password'); run(async () => { await onlineRequest(`users/${encodeURIComponent(person.id)}/password`, { method: 'POST', body: { password } }); form.reset(); }, '密码已重置'); }}>
          <input name="password" type="password" aria-label={`${person.username}新密码`} placeholder="设置新密码" autoComplete="new-password" minLength={12} maxLength={200} required disabled={busy} /><button className="utilityButton" disabled={busy}>重置密码</button>
        </form>
      </div>)}</div>
      <h3>新增账号</h3><form className="onlineUserCreate" onSubmit={event => { event.preventDefault(); const form = event.currentTarget, input = Object.fromEntries(new FormData(form)); run(async () => { await onlineRequest('users', { method: 'POST', body: input }); form.reset(); }, '账号已创建'); }}>
        <label>登录账号<input name="username" autoComplete="off" required maxLength={80} disabled={busy} /></label><label>姓名<input name="displayName" maxLength={80} required disabled={busy} /></label>
        <label>初始密码<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={200} required disabled={busy} /></label>
        <label>角色<select name="role" disabled={busy}><option value="cashier">收银员</option><option value="admin">管理员</option></select></label><button className="submitButton" disabled={busy}>创建账号</button>
      </form>
      <h3>首次迁移经营资料</h3><p>先取得收银权限，再将原电脑导出的完整经营备份导入空的云端账本。商品、库存和历史订单会由服务器核对；已有云端数据时不能覆盖。收钱吧历史交易还需匹配原商户配置。</p>
      <button className="utilityButton" disabled={busy} onClick={() => file.current?.click()}>选择原经营备份</button><input ref={file} type="file" hidden accept=".json" onChange={event => { const selected = event.target.files?.[0]; event.target.value = ''; if (!selected) return; if (selected.size > 32 * 1024 * 1024) { setError('备份不能超过 32 MB'); return; } if (!window.confirm('确认将此经营备份迁移到空的云端账本？服务器将先校验，已有数据不会被覆盖。')) return; run(async () => { const bundle = JSON.parse(await selected.text()); await onImport(bundle); }, '经营资料已迁移到云端'); }} />
    </> : <p>人员账号、收款配置与经营资料迁移由管理员维护。</p>}
  </section>;
}
