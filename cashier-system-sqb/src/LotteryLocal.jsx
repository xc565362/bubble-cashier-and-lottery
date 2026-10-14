import React, { useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, Cloud, Dices, Download, Link, RefreshCw, ScanLine, X } from 'lucide-react';
import { sqbCall } from './sqb.jsx';

const call = (action, payload = {}) => sqbCall('h5lottery-' + action, payload);
const statusLabel = value => ({ pending: '待核销', redeemed: '已核销', expired: '已过期', unavailable: '不可用', none: '未中奖' }[value] || value);
const timeText = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '';

// Activity view + POS redemption for the self-hosted lottery server
// (lottery/server.mjs). Unreachable server only affects this panel.
export function LotteryLocal() {
  const [connection, setConnection] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [dialog, setDialog] = useState(false);
  const [code, setCode] = useState('');
  const [found, setFound] = useState(null);
  const alive = useRef(true), working = useRef(false), generation = useRef(0);

  async function load() {
    const current = ++generation.current;
    setLoading(true); setError('');
    try {
      const info = await call('config');
      const records = info.configured ? await call('records') : null;
      if (!alive.current || current !== generation.current) return;
      setConnection(info); setData(records);
    } catch (issue) {
      if (alive.current && current === generation.current) { setError(issue.message); setData(null); }
    } finally {
      if (alive.current && current === generation.current) setLoading(false);
    }
  }
  useEffect(() => { alive.current = true; load(); return () => { alive.current = false; generation.current++; }; }, []);

  async function run(fn, success, refresh = true) {
    if (working.current) return;
    working.current = true; setBusy(true); setError(''); setMessage('');
    try { const result = await fn(); if (alive.current) { success?.(result); if (refresh) await load(); } }
    catch (issue) { if (alive.current) setError(issue.message); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  }

  function lookup(event) {
    event?.preventDefault();
    const value = code.replace(/\s+/g, '');
    if (!value) return setError('请输入或扫描完整核销码');
    setFound(null);
    run(() => call('lookup', { code: value }), entry => setFound(entry), false);
  }
  function redeem() {
    if (!found?.code || found.status !== 'pending') return;
    if (!window.confirm(`确认核销并发放「${found.prize.name}」？核销后不可重复发放。`)) return;
    run(() => call('redeem', { code: found.code }), entry => {
      setFound(entry); setMessage(`已核销：${entry.prize.name}，请发放奖品`);
    });
  }
  function exportCsv() {
    run(async () => {
      const { csv } = await call('export-csv');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const link = document.createElement('a'); link.href = url; link.download = '抽奖记录.csv'; link.click(); URL.revokeObjectURL(url);
    }, () => setMessage('抽奖记录已导出'), false);
  }

  const disabled = busy || loading;
  const summary = data?.summary;
  return <section className="workspace fullWorkspace lotteryManager" aria-label="自托管抽奖服务">
    <div className="sectionHeader"><h2><Dices size={21} /> 此刻在地 · 自托管抽奖服务</h2><div className="lotteryTools">
      <button type="button" className="iconButton" aria-label="刷新抽奖数据" title="刷新抽奖数据" disabled={disabled || !connection?.configured} onClick={load}><RefreshCw size={18} /></button>
      <button type="button" className="utilityButton" disabled={busy} onClick={() => setDialog(true)}><Link size={17} /> 抽奖服务连接</button>
    </div></div>
    <p className="lotteryHelp">连接本机自建的抽奖服务（默认 http://127.0.0.1:8787），查看实时活动数据并在此核销中奖凭证。</p>
    {loading && <p role="status">正在读取抽奖服务数据…</p>}
    {error && <div className="lotteryNotice dangerText" role="alert"><CircleAlert size={18} /><span>{error}</span></div>}
    {message && <div className="lotteryNotice" role="status"><Check size={18} /><span>{message}</span></div>}
    {!loading && !connection?.configured && <div className="lotteryEmpty"><Cloud size={28} /><h3>抽奖服务尚未连接</h3><p className="lotteryHelp">填写自托管抽奖服务地址和工作人员密钥。上方的云端活动管理保持原样，互不影响。</p><button className="utilityButton" onClick={() => setDialog(true)}><Link size={17} /> 配置抽奖服务</button></div>}
    {connection?.configured && !loading && !data && !error && <p className="lotteryNotice" role="status">已连接 {connection.baseUrl}，点击刷新读取数据。</p>}
    {summary && <>
      <dl className="lotteryTotals">
        <div><dt>总名额</dt><dd>{summary.stockTotal}</dd></div>
        <div><dt>剩余名额</dt><dd>{summary.stockRemaining}</dd></div>
        <div><dt>已参与</dt><dd>{summary.entries}</dd></div>
        <div><dt>待核销</dt><dd>{summary.pending}</dd></div>
        <div><dt>已核销</dt><dd>{summary.redeemed}</dd></div>
        <div><dt>未中奖</dt><dd>{summary.noPrize}</dd></div>
      </dl>
      <div className="lotteryEdit">
        <form onSubmit={lookup} style={{ display: 'grid', gap: 14 }}>
          <label>领奖核销 · 输入或扫描核销码<input value={code} maxLength={64} autoComplete="off" autoCapitalize="off" spellCheck="false" disabled={disabled} placeholder="例如 A1B2 C3D4 E5F6 7890" onChange={event => { setCode(event.target.value); setFound(null); }} /></label>
          <div className="lotteryActions">
            <button type="submit" className="submitButton" disabled={disabled || !code.trim()}><ScanLine size={17} /> 查询奖品</button>
            {found?.status === 'pending' && <button type="button" className="submitButton" disabled={disabled} onClick={redeem}><Check size={17} /> 确认核销并发放</button>}
          </div>
        </form>
        {found && <div className="lotteryNotice" role="status">
          <span>{found.prize.name} · <span className={`lotteryStatus ${found.status === 'pending' ? 'running' : ''}`}>{statusLabel(found.status)}</span> · 中奖账号 {found.winner}
            {found.redeemedAt ? ` · 核销于 ${timeText(found.redeemedAt)}` : ''}</span>
        </div>}
      </div>
      <section className="lotteryRecords" aria-label="抽奖记录">
        <div className="sectionHeader"><div><h3>抽奖记录</h3><p className="lotteryHelp">来自自托管抽奖服务的实时数据；参与账号已脱敏。</p></div>
          <button type="button" className="utilityButton" disabled={disabled} onClick={exportCsv}><Download size={16} /> 导出 CSV</button></div>
        {data.records.length ? <div className="lotteryTableWrap"><table className="lotteryTable lotteryRecordsTable"><thead><tr>
          <th>核销码</th><th>奖品</th><th>状态</th><th>中奖账号</th><th>抽奖时间</th><th>核销时间</th>
        </tr></thead><tbody>{data.records.map(row => <tr key={row.code || row.createdAt + row.openid}>
          <td><code>{row.code || '—'}</code></td>
          <td><strong>{row.prize}</strong></td>
          <td><span className={`lotteryStatus ${row.status === 'pending' ? 'running' : ''}`}>{statusLabel(row.status)}</span></td>
          <td><code>{row.openid}</code></td>
          <td><time>{timeText(row.createdAt)}</time></td>
          <td><time>{timeText(row.redeemedAt) || '—'}</time></td>
        </tr>)}</tbody></table></div> : <p className="lotteryEmpty">暂无抽奖记录</p>}
      </section>
    </>}
    {dialog && <LotteryLocalDialog connection={connection} busy={busy} onClose={() => setDialog(false)}
      onSubmit={(baseUrl, key) => run(() => call('connect', { baseUrl, key }), () => { setDialog(false); setMessage('抽奖服务连接已保存'); })} />}
  </section>;
}

function LotteryLocalDialog({ connection, busy, onClose, onSubmit }) {
  return <div className="modalBackdrop"><div className="modal lotteryModal" role="dialog" aria-modal="true" aria-label="抽奖服务连接"><div className="sectionHeader"><h2>抽奖服务连接</h2><button className="iconButton" disabled={busy} aria-label="关闭抽奖服务连接" onClick={onClose}><X size={18} /></button></div>
    <p className="lotteryHelp">连接保存在本机。密钥只用于本机访问抽奖服务，不会上传。</p>
    <form onSubmit={event => { event.preventDefault(); const input = Object.fromEntries(new FormData(event.currentTarget)); onSubmit(input.baseUrl, input.key); }}>
      <label>抽奖服务地址<input name="baseUrl" type="text" defaultValue={connection?.baseUrl || 'http://127.0.0.1:8787'} placeholder="http://127.0.0.1:8787" required /></label>
      <label>工作人员密钥<input name="key" type="password" autoComplete="new-password" maxLength={200} required /></label>
      <button className="submitButton" disabled={busy}><Link size={17} /> 验证并保存连接</button>
    </form>
  </div></div>;
}
