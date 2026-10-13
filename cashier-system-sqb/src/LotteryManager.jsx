import React, { useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, Cloud, Dices, Download, Link, Pause, Play, Plus, Pencil, RefreshCw, Save, ShoppingCart, Trash2, Upload, X } from 'lucide-react';
import { sqbCall } from './sqb.jsx';
import { lotteryDraft, lotteryPayload, percentToBps, prizeDefinition, retirePrize, safePrizeImage, lotteryConnectionProblem } from './lotterySettings.js';
import { LotteryPrizeEditor } from './LotteryPrizeEditor.jsx';
import './lottery.css';

const call = (action, input = {}) => sqbCall('lottery-' + action, input);
const time = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
const labels = { pause: '暂停新抽奖', resume: '恢复新抽奖', configure: '调整奖池' };
const auditValues = (side, id) => side?.quantities?.[id] === undefined ? '未创建' : `${side.quantities[id]} 份 / ${(side.weightsBps?.[id] || 0) / 100}%`;
export function LotteryManager({ products = [], onCashier }) {
  const [connection, setConnection] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [draft, setDraft] = useState(null);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [dialog, setDialog] = useState(false);
  const [capacity, setCapacity] = useState(null);
  const [prizeEditor, setPrizeEditor] = useState(null);
  const [coupon, setCoupon] = useState(null), [couponError, setCouponError] = useState('');
  const alive = useRef(true), working = useRef(false), generation = useRef(0), request = useRef(null);
  async function load(preserveDraft = false) {
    const current = ++generation.current;
    setLoading(true); setError(''); setCouponError(''); setCoupon(null);
    try {
      const info = await call('config');
      const data = info.configured ? await call('snapshot') : null;
      let center = null, centerError = '';
      if (data) { try { center = await sqbCall('coupon-config'); } catch (e) { centerError = e.message; } }
      if (!alive.current || current !== generation.current) return;
      if (preserveDraft && data?.revision !== snapshot?.revision) { setError('云端配置已被其他操作修改，待保存内容已保留。请先记录修改，再刷新核对最新版本。'); return; }
      setConnection(info); setSnapshot(data); setCoupon(center); setCouponError(centerError); if (!preserveDraft) setDraft(data ? lotteryDraft(data) : null); setConfirmed(false);
    } catch (e) { if (alive.current && current === generation.current) setError(e.message); }
    finally { if (alive.current && current === generation.current) setLoading(false); }
  }
  useEffect(() => { alive.current = true; load(); return () => { alive.current = false; generation.current++; }; }, []);
  async function run(fn, success, options = {}) {
    if (working.current) return;
    working.current = true; setBusy(true); setError(''); setMessage('');
    try { const result = await fn(); if (alive.current) { success?.(result); if (options.refresh !== false) await load(options.preserveDraft === true); } }
    catch (e) { if (alive.current) setError(e.message); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  }
  function mutation(action, input) {
    const fingerprint = JSON.stringify([action, input]);
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
    return call(action, { ...input, requestId: request.current.id });
  }
  function change(field, id, value) { setDraft(old => ({ ...old, [field]: { ...old[field], [id]: value } })); setConfirmed(false); }
  function editPrize(mode, item) {
    const prize = mode === 'edit' ? prizeDefinition(item) : { ...(item ? prizeDefinition(item) : { name: '', shortName: '', kind: 'physical', amount: 0, minimumCents: 0, label: '', icon: '', imageUrl: '' }), id: 'prize_' + crypto.randomUUID().replaceAll('-', ''), retired: false };
    setPrizeEditor({ mode, prize, previousId: mode === 'replace' ? item.id : null });
  }
  function savePrize(item) {
    let next = { ...draft, catalog: [...draft.catalog], quantities: { ...draft.quantities }, percentages: { ...draft.percentages } };
    const index = next.catalog.findIndex(p => p.id === item.id);
    if (index >= 0) next.catalog[index] = item;
    else {
      const previous = snapshot.prizes.find(p => p.id === prizeEditor.previousId);
      const inherited = prizeEditor.previousId;
      const count = inherited ? Math.max(0, Number(next.quantities[inherited]) - (previous?.allocated || 0)) : 1;
      const percent = inherited ? next.percentages[inherited] : '0';
      if (inherited) next = retirePrize(snapshot, next, inherited);
      next.catalog.push(item); next.quantities[item.id] = String(count); next.percentages[item.id] = percent;
    }
    setDraft(next); setConfirmed(false); setPrizeEditor(null); setMessage('奖品已加入待保存配置，核对名额和概率后再保存');
  }
  function update(operation) {
    if (operation === 'resume' && centerProblem) { setError(centerProblem); return; }
    if (!reason.trim()) { setError('请填写调整原因'); return; }
    if (!confirmed) { setError('请勾选确认后再提交'); return; }
    let payload;
    try { payload = operation === 'configure' ? lotteryPayload(snapshot, draft, reason) : { operation, expectedRevision: snapshot.revision, reason: reason.trim() }; }
    catch (e) { setError(e.message); return; }
    run(() => mutation('update', payload), () => { setMessage(operation === 'configure' ? '配置已保存，活动仍暂停' : operation === 'pause' ? '新抽奖已暂停，已有奖品不受影响' : '新抽奖已恢复'); setReason(''); });
  }
  const disabled = busy || loading;
  const dirty = snapshot && draft && JSON.stringify(draft) !== JSON.stringify(lotteryDraft(snapshot));
  const catalogReady = snapshot?.capabilities?.includes('catalog-v1');
  const centerProblem = snapshot ? lotteryConnectionProblem(snapshot, coupon) : '';
  const displayPrizes = draft?.catalog ? draft.catalog.map(p => ({ allocated: 0, remaining: 0, effectiveProbability: 0, ...snapshot.prizes.find(item => item.id === p.id), ...p })) : snapshot?.prizes || [];
  const retired = displayPrizes.filter(p => p.retired);
  let totalBps = null;
  try { if (draft) totalBps = Object.values(draft.percentages).reduce((sum, n) => sum + percentToBps(n), 0); } catch {}
  return <section className="workspace fullWorkspace lotteryManager" aria-label="抽奖管理">
    <div className="sectionHeader"><h2><Dices size={21} /> 此刻在地 · 奖池管理</h2><div className="lotteryTools">
      <button className="iconButton" aria-label="刷新抽奖配置" title="刷新抽奖配置" disabled={disabled} onClick={() => { if (!dirty || window.confirm('刷新会放弃尚未保存的修改，继续吗？')) load(); }}><RefreshCw size={18} /></button>
      <button className="utilityButton" disabled={disabled} onClick={() => setDialog(true)}><Link size={17} /> 此刻在地连接</button>
    </div></div>
    {loading && <p role="status">正在读取云端奖池</p>}
    {error && <div className="lotteryNotice dangerText" role="alert"><CircleAlert size={18} /><span>{error}</span></div>}
    {message && <div className="lotteryNotice" role="status"><Check size={18} /><span>{message}</span></div>}
    {!loading && !connection?.configured && !snapshot && <div className="lotteryEmpty"><Cloud size={28} /><h3>此刻在地尚未连接</h3><p className="lotteryHelp">连接此刻在地的管理接口后，可管理奖项、商品、图片、名额和概率。领奖核销使用与山野有约相同的券中心。</p><button className="utilityButton" onClick={() => setDialog(true)}><Link size={17} /> 配置连接</button></div>}
    {snapshot && draft && <>
      <div className="lotteryHeading"><div><strong>{snapshot.title}</strong><small>{snapshot.campaignId} · 配置版本 {snapshot.revision}</small></div><span className={`lotteryStatus ${snapshot.enabled && !snapshot.blockedReason ? 'running' : ''}`}>{snapshot.blockedReason ? '名额耗尽 · 已阻止新抽奖' : snapshot.enabled ? '允许新抽奖' : '新抽奖已暂停'}</span></div>
      <dl className="lotteryTotals"><div><dt>总名额</dt><dd>{snapshot.total}</dd></div><div><dt>已抽中</dt><dd>{snapshot.allocated}</dd></div><div><dt>剩余可抽</dt><dd>{snapshot.remaining}</dd></div></dl>
      {snapshot.blockedReason && <p className="lotteryNotice" role="status">{snapshot.blockedReason}</p>}
      {snapshot.centerError && <p className="lotteryNotice dangerText">{snapshot.centerError}</p>}
      <div className={`lotteryNotice ${!loading && centerProblem ? 'dangerText' : ''}`} role="status"><Cloud size={18} /><span>{loading ? '正在核对核销连接…' : centerProblem || `核销已接入相同券中心 · ${coupon.environment === 'production' ? '正式环境' : '测试环境'}`}{couponError && ` ${couponError}`}</span></div>
      <div className="scarfRedemption"><div><strong>领奖核销</strong><p>在「收银」扫描中奖凭证：实物奖品免费入单，点击「零元结算」确认后发放；金额券在购物结算时抵扣。完成后 H5 自动更新为已使用。</p></div>{onCashier && <button type="button" className="utilityButton" disabled={disabled} onClick={onCashier}><ShoppingCart size={17} /> 去收银核销</button>}</div>
      <div className="lotteryMode" role="group" aria-label="抽奖模式">{[['inventory', '按剩余名额'], ['fixed', '固定概率']].map(([key, label]) => <button key={key} type="button" aria-pressed={draft.mode === key} disabled={disabled || snapshot.enabled} onClick={() => { setDraft({ ...draft, mode: key }); setConfirmed(false); }}>{label}</button>)}</div>
      <div className="lotteryCatalogHeader"><div><strong>活动奖品 · {displayPrizes.filter(p => !p.retired).length} 项</strong><p className="lotteryHelp">保存到云端后，H5 首页和规则页会自动更新。已有中奖凭证保留原奖品。</p></div><button className="utilityButton" disabled={disabled || snapshot.enabled || !catalogReady} onClick={() => editPrize('add')}><Plus size={17} /> 新增奖项</button></div>
      {!catalogReady && <p className="lotteryNotice">当前云端版本支持名额与概率管理。升级抽奖服务和券服务后可开启奖品增删、图片和商品更换。</p>}
      {snapshot.enabled && catalogReady && <p className="lotteryHelp">请先填写原因并暂停新抽奖，再编辑奖品。保存后核对手机页面，最后恢复抽奖。</p>}
      <div className="lotteryTableWrap"><table className="lotteryTable"><thead><tr><th>奖品</th><th>已抽中</th><th>剩余</th><th>券中心已核销</th><th>总名额</th><th>{draft.mode === 'fixed' ? '固定概率 %' : '当前概率 %'}</th><th>券发放上限</th></tr></thead><tbody>{displayPrizes.filter(p => !p.retired).map(p => <tr key={p.id}>
        <th scope="row"><div className="lotteryPrizeName">{safePrizeImage(p.imageUrl) && <img src={safePrizeImage(p.imageUrl)} alt="" referrerPolicy="no-referrer" />}<span>{p.name}<small>{p.kind === 'cash' ? `购物抵扣券 · ¥${p.amount}` : p.product ? `实物 · ${p.product.sku || p.product.barcode}` : '实物奖品'}</small></span></div>{catalogReady && <div className="lotteryPrizeActions"><button type="button" title="编辑名称和图片" aria-label={`编辑${p.name}展示`} disabled={disabled || snapshot.enabled} onClick={() => editPrize('edit', p)}><Pencil size={14} /> 展示</button><button type="button" aria-label={`更换${p.name}`} disabled={disabled || snapshot.enabled} onClick={() => editPrize('replace', p)}>更换奖品</button><button type="button" aria-label={`移除${p.name}`} disabled={disabled || snapshot.enabled} onClick={() => { setDraft(retirePrize(snapshot, draft, p.id)); setConfirmed(false); }}><Trash2 size={14} /> 移除</button></div>}</th><td>{p.allocated}</td><td>{p.remaining}</td><td>{snapshot.prizes.some(item => item.id === p.id) ? snapshot.center?.prizes?.[p.id]?.redeemed ?? '待核对' : '新奖项'}</td>
        <td><input aria-label={`${p.name}总名额`} type="number" min={p.allocated} max="1000000" step="1" disabled={disabled || snapshot.enabled} value={draft.quantities[p.id]} onChange={e => change('quantities', p.id, e.target.value)} /></td>
        <td>{draft.mode === 'fixed' ? <input aria-label={`${p.name}固定概率`} type="number" min="0" max="100" step="0.01" disabled={disabled || snapshot.enabled} value={draft.percentages[p.id]} onChange={e => change('percentages', p.id, e.target.value)} /> : <span>{p.effectiveProbability.toFixed(2)}</span>}</td>
        <td><div className="lotteryCapacity"><span>{snapshot.center?.prizes?.[p.id]?.quota ?? (snapshot.prizes.some(item => item.id === p.id) ? '待核对' : '保存时建立')}</span><button className="iconButton" title={`增加${p.name}券发放上限`} aria-label={`增加${p.name}券发放上限`} disabled={disabled || snapshot.enabled || !snapshot.center?.quotaAdjustmentSupported || !snapshot.center?.prizes?.[p.id]} onClick={() => setCapacity({ ...p, current: snapshot.center.prizes[p.id].quota })}><Upload size={16} /></button></div></td>
      </tr>)}</tbody></table></div>
      {retired.length > 0 && <details className="lotteryRetired"><summary>已移除 {retired.length} 项 · 历史凭证保留</summary>{retired.map(p => <p key={p.id}>{p.name} · 已抽中 {p.allocated} 份，不再参与后续抽取</p>)}</details>}
      {draft.mode === 'fixed' && <p className={totalBps === 10000 ? 'lotterySum' : 'lotterySum dangerText'} role="status">概率合计：{totalBps === null ? '数值无效' : `${(totalBps / 100).toFixed(2)}%`} · 缺货处理：暂停新抽奖</p>}
      {!snapshot.center?.quotaAdjustmentSupported && <p className="lotteryNotice">券服务器尚未支持补充发放上限，增加抽奖名额仍受现有上限限制。</p>}
      <div className="lotteryEdit"><label>调整原因<input value={reason} maxLength={200} disabled={disabled} onChange={e => { setReason(e.target.value); setConfirmed(false); }} /></label>
        <label className={`lotteryConfirm ${confirmed ? 'checked' : ''}`}><input type="checkbox" checked={confirmed} disabled={disabled} onChange={e => setConfirmed(e.target.checked)} /><span>{confirmed ? '已确认' : '待确认'} · 已核对名额与概率，调整只影响后续抽奖</span></label>
        <div className="lotteryActions">{snapshot.enabled ? <button className="utilityButton" disabled={disabled || !confirmed || !reason.trim()} onClick={() => update('pause')}><Pause size={17} /> 暂停新抽奖</button> : <>
          <button className="submitButton" disabled={disabled || !confirmed || !reason.trim() || (draft.mode === 'fixed' && totalBps !== 10000)} onClick={() => update('configure')}><Save size={17} /> 保存配置</button>
          <button className="utilityButton" disabled={disabled || !confirmed || !reason.trim() || !!centerProblem || JSON.stringify(draft) !== JSON.stringify(lotteryDraft(snapshot))} onClick={() => update('resume')}><Play size={17} /> 恢复新抽奖</button>
        </>}</div>
      </div>
      <section className="lotteryAudit" aria-label="抽奖调整记录"><h3>调整记录</h3>{!snapshot.audit.length && <p>暂无调整记录</p>}{snapshot.audit.map(row => <details key={row.revision}><summary><span>{labels[row.operation]} · 版本 {row.revision}</span><time>{time(row.at)}</time><span>{row.reason}</span></summary><div className="lotteryAuditRows">{snapshot.prizes.map(p => <p key={p.id}>{p.name}：{auditValues(row.before, p.id)} → {auditValues(row.after, p.id)}</p>)}</div></details>)}</section>
    </>}
    {dialog && <ConnectionDialog connection={connection} busy={disabled} error={error} onClose={() => setDialog(false)} run={(fn, success, options = {}) => { if (options.refresh === false || !dirty || window.confirm('切换连接会放弃待保存配置，继续吗？')) return run(fn, success, options); }} onSuccess={() => setDialog(false)} />}
    {prizeEditor && <LotteryPrizeEditor editor={prizeEditor} products={products} onSave={savePrize} onClose={() => setPrizeEditor(null)} />}
    {capacity && <div className="modalBackdrop"><form className="modal lotteryModal" role="dialog" aria-modal="true" aria-label="补充券发放上限" onSubmit={e => { e.preventDefault(); const form = Object.fromEntries(new FormData(e.currentTarget)); run(() => mutation('increase-capacity', { prizeId: capacity.id, quota: Number(form.quota), reason: form.reason }), () => { setCapacity(null); setMessage('券上限已更新，待保存配置已保留，抽奖总名额仍需单独保存'); }, { preserveDraft: true }); }}><div className="sectionHeader"><h2>补充券发放上限</h2><button type="button" className="iconButton" aria-label="关闭上限调整" disabled={busy} onClick={() => setCapacity(null)}><X size={18} /></button></div><p>{capacity.name} · 当前上限 {capacity.current}</p>{error && <p className="dangerText">{error}</p>}<label>新上限<input name="quota" type="number" min={capacity.current} max="1000000" step="1" required /></label><label>原因<input name="reason" maxLength={200} required /></label><button className="submitButton" disabled={disabled}><Save size={17} /> 确认补充</button></form></div>}
  </section>;
}

function ConnectionDialog({ connection, busy, error, onClose, run, onSuccess }) {
  const fileRef = useRef(null);
  const [password, setPassword] = useState('');
  async function exportConnection() {
    const bundle = await call('export-connection', { password });
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = '抽奖管理连接-加密.json'; a.click(); URL.revokeObjectURL(url);
  }
  return <div className="modalBackdrop"><div className="modal lotteryModal" role="dialog" aria-modal="true" aria-label="抽奖云端连接"><div className="sectionHeader"><h2>此刻在地 · 云端连接</h2><button className="iconButton" disabled={busy} aria-label="关闭抽奖连接" onClick={onClose}><X size={18} /></button></div>
    {error && <p className="dangerText">{error}</p>}
    <form onSubmit={e => { e.preventDefault(); const input = Object.fromEntries(new FormData(e.currentTarget)); run(() => call('connect', input), onSuccess); }}>
      <label>HTTPS 管理接口<input name="url" type="url" defaultValue={connection?.url || ''} required /></label>
      <label>活动编号<input name="campaignId" defaultValue={connection?.campaignId || 'bubble-race-2026-500'} required /></label>
      <label>管理密钥<input name="key" type="password" autoComplete="new-password" required minLength={64} maxLength={64} /></label>
      <button className="submitButton" disabled={busy}><Link size={17} /> 验证并保存</button>
    </form>
    <div className="lotteryTransfer"><label>连接包密码<input type="password" autoComplete="new-password" minLength={12} maxLength={200} value={password} onChange={e => setPassword(e.target.value)} /></label><div className="lotteryActions">
      <button className="utilityButton" disabled={busy || !connection?.configured || password.length < 12} onClick={() => run(exportConnection, undefined, { refresh: false })}><Download size={17} /> 导出连接</button>
      <button className="utilityButton" disabled={busy || password.length < 12} onClick={() => fileRef.current.click()}><Upload size={17} /> 导入连接</button>
      <input ref={fileRef} type="file" accept=".json" hidden onChange={e => { const file = e.target.files[0]; e.target.value = ''; if (file) run(async () => { if (file.size > 50000) throw new Error('连接包文件过大'); return call('import-connection', { bundle: JSON.parse(await file.text()), password }); }, onSuccess); }} />
    </div></div>
  </div></div>;
}
