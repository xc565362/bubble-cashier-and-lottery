import React, { useEffect, useRef, useState } from 'react';
import { Check, RefreshCw, ShieldCheck, UserRound, Users, XCircle } from 'lucide-react';
import { sqbCall } from '../api/sqb.js';
import { onlineRequest } from '../api/online.js';
import { PageShell, Badge } from '../components/ui.jsx';

const ROLE_LABELS = { admin: '管理员', cashier: '收银员', redeemer: '核销员' };
const ROLE_TEMPLATES = {
  cashier: ['pos', 'orders', 'gifts', 'events', 'settings'],
  redeemer: ['events', 'coupons', 'orders'],
};
const SECTIONS = [
  ['pos', '收银'],
  ['products', '商品'],
  ['orders', '流水'],
  ['coupons', '券管理'],
  ['gifts', '赠品'],
  ['events', '活动'],
  ['settings', '设置'],
];

const sameGrants = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const effectiveGrants = (person) => (Array.isArray(person.grants) && person.grants.length ? person.grants : (ROLE_TEMPLATES[person.role] || []));

export function SettingsScreen({ user, onImport, flash }) {
  return (
    <PageShell kicker="Settings" title="设置">
      <div className="space-y-6">
        <ConnectionTestPanel />
        {user.role === 'admin' ? <AccountPanel user={user} onImport={onImport} /> : <AccountCard user={user} />}
      </div>
    </PageShell>
  );
}

function ConnectionTestPanel() {
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState('');
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    sqbCall('config').then((value) => {
      setConfig(value || null);
      if (value?.connectionCheck) setCheck(value.connectionCheck);
    }).catch((error) => setConfigError(error.message));
  }, []);

  async function runCheck() {
    if (busy) return;
    setBusy(true);
    try {
      const value = await sqbCall('check-connection');
      setCheck(value?.connectionCheck || value || {});
    } catch (error) {
      setCheck({ verified: false, message: error.message, checkedAt: new Date().toISOString() });
    } finally { setBusy(false); }
  }

  const modeLabel = config?.mode === 'production' ? '正式商户' : '测试商户';
  return (
    <section className="glass p-5" aria-label="连接测试">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-bold"><ShieldCheck size={19} className="text-coral" /> 连接测试</h2>
        {config && (
          <Badge tone={config.mode === 'production' ? 'ok' : 'warn'}>
            {config.mode === 'production' ? '正式商户参数' : '测试商户参数'}
          </Badge>
        )}
      </div>

      <dl className="mb-4 space-y-1.5 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-mist">商户状态</dt>
          <dd>{config ? `${modeLabel} · ${config.ready ? '配置就绪' : '配置未完成'}` : configError || '正在读取…'}</dd>
        </div>
        {check?.checkedAt && (
          <div className="flex justify-between gap-4">
            <dt className="text-mist">上次检测</dt>
            <dd>{new Date(check.checkedAt).toLocaleString('zh-CN')}</dd>
          </div>
        )}
      </dl>

      <button className="btn-primary" disabled={busy} onClick={runCheck}>
        {busy ? <RefreshCw size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
        {busy ? '正在检测…' : '测试连接'}
      </button>

      {check && (
        <p className={`mt-3 rounded-xl border px-4 py-2.5 text-sm ${check.verified ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-red-400/30 bg-red-400/10 text-red-300'}`} role="status">
          {check.verified ? <Check size={15} className="mr-1 inline" /> : <XCircle size={15} className="mr-1 inline" />}
          {check.verified ? '连接正常' : '连接未通过'}
          {check.code ? ` · ${check.code}` : ''}
          {check.message ? ` · ${check.message}` : ''}
          {check.checkedAt ? ` · ${new Date(check.checkedAt).toLocaleString('zh-CN')}` : ''}
        </p>
      )}
    </section>
  );
}

function AccountCard({ user }) {
  return (
    <section className="glass p-5" aria-label="当前账号">
      <h2 className="mb-4 flex items-center gap-2 text-lg font-bold"><UserRound size={19} className="text-coral" /> 当前账号</h2>
      <p className="flex items-center gap-2 text-sm text-mist">
        {user.displayName || user.username} · {ROLE_LABELS[user.role] || '收银员'}
      </p>
    </section>
  );
}

function GrantsChecklist({ value, onChange, disabled }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="功能权限">
      {SECTIONS.map(([key, label]) => {
        const checked = value.includes(key);
        return (
          <label
            key={key}
            className={`flex min-h-[36px] cursor-pointer items-center gap-1.5 rounded-lg border px-3 text-xs transition ${
              checked ? 'border-coral/50 bg-coral/10 text-coral-soft' : 'border-white/10 bg-white/[0.03] text-mist'
            } ${disabled ? 'pointer-events-none opacity-50' : ''}`}
          >
            <input
              type="checkbox"
              className="sr-only"
              checked={checked}
              disabled={disabled}
              onChange={() => onChange(checked ? value.filter((item) => item !== key) : [...value, key])}
            />
            {checked && <Check size={12} className="shrink-0" />}
            {label}
          </label>
        );
      })}
    </div>
  );
}

function UserRow({ person, currentUser, busy, run }) {
  const [role, setRole] = useState(person.role);
  const [grants, setGrants] = useState(() => effectiveGrants(person));

  useEffect(() => {
    setRole(person.role);
    setGrants(effectiveGrants(person));
  }, [person]);

  function changeRole(next) {
    setRole(next);
    if (next !== 'admin') setGrants(ROLE_TEMPLATES[next] || []);
  }

  const dirty = role !== person.role || (role !== 'admin' && !sameGrants(grants, effectiveGrants(person)));

  function save() {
    const body = role === 'admin' ? { role } : { role, grants };
    run(() => onlineRequest(`users/${encodeURIComponent(person.id)}`, { method: 'PATCH', body }), '角色与权限已保存');
  }

  return (
    <div className="glass grid items-center gap-2 px-4 py-3 sm:grid-cols-[1fr_130px_80px]">
      <div>
        <strong className="text-sm">{person.displayName || person.username}</strong>
        <p className="text-xs text-mist">{person.username} · {person.disabled ? '已停用' : '可登录'}</p>
      </div>
      <select className="field !py-2 !text-sm" aria-label={`${person.username}角色`} value={role} disabled={busy} onChange={(event) => changeRole(event.target.value)}>
        <option value="cashier">收银员</option>
        <option value="redeemer">核销员</option>
        <option value="admin">管理员</option>
      </select>
      <button className="btn-ghost !min-h-[40px] !py-1.5 text-sm" disabled={busy || person.id === currentUser.id} onClick={() => run(() => onlineRequest(`users/${encodeURIComponent(person.id)}`, { method: 'PATCH', body: { disabled: !person.disabled } }))}>
        {person.disabled ? '启用' : '停用'}
      </button>
      <div className="sm:col-span-3">
        {role === 'admin' ? (
          <p className="text-xs text-mist">管理员拥有全部权限</p>
        ) : (
          <GrantsChecklist value={grants} onChange={setGrants} disabled={busy} />
        )}
      </div>
      <div className="sm:col-span-3">
        <button className="btn-primary !min-h-[40px] !py-1.5 text-sm" disabled={busy || !dirty} onClick={save}>
          <Check size={15} /> 保存角色与权限
        </button>
      </div>
      <form className="flex gap-2 sm:col-span-3" onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const password = new FormData(form).get('password');
        run(async () => {
          await onlineRequest(`users/${encodeURIComponent(person.id)}/password`, { method: 'POST', body: { password } });
          form.reset();
        }, '密码已重置');
      }}>
        <input className="field flex-1 !py-2 !text-sm" name="password" type="password" aria-label={`${person.username}新密码`} placeholder="设置新密码" autoComplete="new-password" minLength={12} maxLength={200} required disabled={busy} />
        <button className="btn-ghost !min-h-[40px] !py-1.5 text-sm" disabled={busy}>重置密码</button>
      </form>
    </div>
  );
}

function AccountPanel({ user, onImport }) {
  const [users, setUsers] = useState([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [newRole, setNewRole] = useState('cashier');
  const [newGrants, setNewGrants] = useState(ROLE_TEMPLATES.cashier);
  const file = useRef(null);
  const working = useRef(false);

  async function load() { const data = await onlineRequest('users'); setUsers(data.users); }
  useEffect(() => { load().catch((issue) => setError(issue.message)); }, []);

  async function run(work, success) {
    if (working.current) return;
    working.current = true; setBusy(true); setError(''); setMessage('');
    try { await work(); setMessage(success || '已保存'); await load(); }
    catch (issue) { setError(issue.message); }
    finally { working.current = false; setBusy(false); }
  }

  function changeNewRole(next) {
    setNewRole(next);
    if (next !== 'admin') setNewGrants(ROLE_TEMPLATES[next] || []);
  }

  return (
    <section className="glass p-5" aria-label="账号与资料">
      <h2 className="mb-4 flex items-center gap-2 text-lg font-bold"><Users size={19} className="text-coral" /> 账号与资料</h2>
      <p className="mb-4 flex items-center gap-2 text-sm text-mist">
        <UserRound size={15} /> 当前账号：{user.displayName || user.username} · {ROLE_LABELS[user.role] || '收银员'}
      </p>
      {error && <p className="mb-3 rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-2.5 text-sm text-red-300" role="alert">{error}</p>}
      {message && <p className="mb-3 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-2.5 text-sm text-emerald-300" role="status">{message}</p>}

      <div className="space-y-6">
        <div>
          <h3 className="mb-2 font-semibold">人员账号</h3>
          <div className="space-y-2">
            {users.map((person) => <UserRow key={person.id} person={person} currentUser={user} busy={busy} run={run} />)}
          </div>
        </div>

        <div>
          <h3 className="mb-2 font-semibold">新增账号</h3>
          <form className="grid gap-3 sm:grid-cols-4" onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const input = Object.fromEntries(new FormData(form));
            const body = { ...input, role: newRole, ...(newRole === 'admin' ? {} : { grants: newGrants }) };
            run(async () => {
              await onlineRequest('users', { method: 'POST', body });
              form.reset();
              setNewRole('cashier');
              setNewGrants(ROLE_TEMPLATES.cashier);
            }, '账号已创建');
          }}>
            <label className="block"><span className="field-label">登录账号</span><input className="field" name="username" autoComplete="off" required maxLength={80} disabled={busy} /></label>
            <label className="block"><span className="field-label">姓名</span><input className="field" name="displayName" maxLength={80} required disabled={busy} /></label>
            <label className="block"><span className="field-label">初始密码</span><input className="field" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={200} required disabled={busy} /></label>
            <label className="block"><span className="field-label">角色</span>
              <select className="field" value={newRole} disabled={busy} onChange={(event) => changeNewRole(event.target.value)}>
                <option value="cashier">收银员</option>
                <option value="redeemer">核销员</option>
                <option value="admin">管理员</option>
              </select>
            </label>
            <div className="sm:col-span-4">
              {newRole === 'admin' ? (
                <p className="text-xs text-mist">管理员拥有全部权限</p>
              ) : (
                <>
                  <span className="field-label">功能权限</span>
                  <GrantsChecklist value={newGrants} onChange={setNewGrants} disabled={busy} />
                </>
              )}
            </div>
            <button className="btn-primary sm:col-span-4" disabled={busy}>创建账号</button>
          </form>
        </div>

        <div>
          <h3 className="mb-2 font-semibold">首次迁移经营资料</h3>
          <p className="mb-3 text-xs text-mist">将原电脑导出的完整经营备份导入空的云端账本。商品、库存和历史订单会由服务器核对；已有云端数据时不能覆盖。收钱吧历史交易还需匹配原商户配置。</p>
          <button className="btn-ghost text-sm" disabled={busy} onClick={() => file.current?.click()}>选择原经营备份</button>
          <input
            ref={file}
            type="file"
            hidden
            accept=".json"
            onChange={(event) => {
              const selected = event.target.files?.[0];
              event.target.value = '';
              if (!selected) return;
              if (selected.size > 32 * 1024 * 1024) { setError('备份不能超过 32 MB'); return; }
              if (!window.confirm('确认将此经营备份迁移到空的云端账本？服务器将先校验，已有数据不会被覆盖。')) return;
              run(async () => { const bundle = JSON.parse(await selected.text()); await onImport(bundle); }, '经营资料已迁移到云端');
            }}
          />
        </div>
      </div>
    </section>
  );
}
