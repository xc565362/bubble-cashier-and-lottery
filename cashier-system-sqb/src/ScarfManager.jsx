import React, { useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, Cloud, Dices, Download, Gift, Link, Pause, Play, RefreshCw, Save, ShoppingCart, Upload, X } from 'lucide-react';
import { sqbCall } from './sqb.jsx';
import { LotteryManager } from './LotteryManager.jsx';
import { availablePrizeProducts, safePrizeImage } from './lotterySettings.js';
import { SCARF_CAMPAIGN_ID, matchingScarfProduct, scarfConnectionProblem, scarfDraft, scarfPayload } from './scarfSettings.js';
import { ActivityRulesEditor } from './ActivityRulesEditor.jsx';
import { RULES_TEXT_CAPABILITY } from './rulesText.js';
import { LotteryRecords } from './LotteryRecords.jsx';
import { DRAW_RECORDS_CAPABILITY } from './lotteryRecords.js';
import { LotteryLocal } from './LotteryLocal.jsx';
import './lottery.css';
import './scarf.css';

const call = (action, payload = {}) => sqbCall('scarf-' + action, payload);
const labels = { pause: '暂停新抽奖', resume: '开启新抽奖', configure: '调整活动' };
const dateText = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '待定';

export function LotteryWorkspace({ products, onCashier }) {
  const [selected, setSelected] = useState('original');
  const [visited, setVisited] = useState(false);
  // Prefer the self-hosted lottery server once it is configured; the cloud
  // management views stay available under their own tabs.
  const touched = useRef(false);
  useEffect(() => {
    let live = true;
    sqbCall('h5lottery-config').then(info => { if (live && info.configured && !touched.current) setSelected('local'); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const choose = value => { touched.current = true; if (value === 'scarf') setVisited(true); setSelected(value); };
  return <div className="lotteryWorkspace">
    <p className="lotteryHelp">选择活动分别管理奖品、名额和概率；两个活动的中奖凭证都在「收银」核销。</p>
    <div className="lotteryCampaignTabs" role="group" aria-label="选择抽奖活动">
      <button type="button" aria-pressed={selected === 'local'} onClick={() => choose('local')}><Dices size={17} /> 此刻在地 · 自托管服务</button>
      <button type="button" aria-pressed={selected === 'original'} onClick={() => choose('original')}><Dices size={17} /> 此刻在地</button>
      <button type="button" aria-pressed={selected === 'scarf'} onClick={() => choose('scarf')}><Gift size={17} /> 山野有约 · 关注抽头巾</button>
    </div>
    <div hidden={selected !== 'local'}><LotteryLocal /></div>
    <div hidden={selected !== 'original'}><LotteryManager products={products} onCashier={onCashier} /></div>
    {visited && <div hidden={selected !== 'scarf'}><ScarfManager products={products} onCashier={onCashier} /></div>}
  </div>;
}

export function ScarfManager({ products = [], onCashier }) {
  const [connection, setConnection] = useState(null), [snapshot, setSnapshot] = useState(null), [coupon, setCoupon] = useState(null);
  const [draft, setDraft] = useState(null), [reason, setReason] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [dialog, setDialog] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [couponError, setCouponError] = useState('');
  const alive = useRef(true), working = useRef(false), generation = useRef(0), request = useRef(null);
  async function load() {
    const current = ++generation.current;
    setLoading(true); setError(''); setCouponError(''); setCoupon(null);
    try {
      const info = await call('config');
      const data = info.configured ? await call('snapshot') : null;
      let center = null, centerError = '';
      if (data) { try { center = await sqbCall('coupon-config'); } catch (e) { centerError = e.message; } }
      if (!alive.current || current !== generation.current) return;
      setConnection(info); setSnapshot(data); setDraft(data ? scarfDraft(data) : null); setCoupon(center); setCouponError(centerError); setConfirmed(false);
    } catch (e) { if (alive.current && current === generation.current) setError(e.message); }
    finally { if (alive.current && current === generation.current) setLoading(false); }
  }
  useEffect(() => { alive.current = true; load(); return () => { alive.current = false; generation.current++; }; }, []);
  async function run(fn, success, refresh = true) {
    if (working.current) return;
    working.current = true; setBusy(true); setError(''); setMessage('');
    try { const result = await fn(); if (alive.current) { success?.(result); if (refresh) await load(); } }
    catch (e) { if (alive.current) setError(e.message); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  }
  function change(field, value) { setDraft(old => ({ ...old, [field]: value })); setConfirmed(false); }
  function changePrize(field, value) { setDraft(old => ({ ...old, prize: { ...old.prize, [field]: value } })); setConfirmed(false); }
  function selectProduct(id) {
    const p = choices.find(item => item.id === id);
    setDraft(old => ({ ...old, prize: { ...old.prize, product: p ? { id: p.id, name: p.name, sku: p.sku || '', barcode: p.barcode || '' } : null,
      name: p?.name || old.prize.name, imageUrl: safePrizeImage(p?.imageUrl) || '' } }));
    setConfirmed(false);
  }
  function update(operation) {
    if (!reason.trim() || !confirmed) return setError('请填写调整原因并勾选确认');
    let payload;
    try {
      payload = operation === 'configure' ? scarfPayload(snapshot, draft, reason, products) : { revision: snapshot.revision, operation, reason: reason.trim() };
      if (operation === 'resume' && centerProblem) throw new Error(centerProblem);
    } catch (e) { setError(e.message); return; }
    const fingerprint = JSON.stringify(payload);
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
    run(() => call('update', { ...payload, requestId: request.current.id }), result => {
      if (result?.campaignId === SCARF_CAMPAIGN_ID && result.campaign && result.inventory && result.prize) {
        setSnapshot(result); setDraft(scarfDraft(result)); setConfirmed(false);
      }
      setMessage(operation === 'configure' ? '活动配置已保存，仍保持暂停；H5 会自动读取新配置' : operation === 'pause' ? '新抽奖已暂停，已有中奖凭证仍可核销' : '新抽奖已开启');
      setReason('');
    });
  }
  const disabled = busy || loading, editingDisabled = disabled || snapshot?.campaign.enabled;
  const choices = availablePrizeProducts(products), boundProduct = matchingScarfProduct(draft?.prize.product, products);
  const dirty = snapshot && draft && JSON.stringify(draft) !== JSON.stringify(scarfDraft(snapshot));
  const centerProblem = snapshot ? scarfConnectionProblem(snapshot, coupon) : '';
  const datesReady = !!(snapshot?.campaign.startsAt && snapshot.campaign.endsAt && snapshot.campaign.redeemEndsAt);
  const imageUrl = safePrizeImage(draft?.prize.imageUrl);
  return <section className="workspace fullWorkspace lotteryManager scarfManager" aria-label="头巾活动管理">
    <div className="sectionHeader"><h2><Gift size={21} /> 山野有约 · 关注抽头巾</h2><div className="lotteryTools">
      <button type="button" className="iconButton" aria-label="刷新头巾活动" title="刷新头巾活动" disabled={disabled} onClick={() => { if (!dirty || window.confirm('刷新会放弃尚未保存的头巾活动修改，继续吗？')) load(); }}><RefreshCw size={18} /></button>
      <button type="button" className="utilityButton" disabled={disabled} onClick={() => setDialog(true)}><Link size={17} /> 头巾活动连接</button>
    </div></div>
    <p className="lotteryHelp">工作人员确认关注小红书后，引导扫码抽奖。中奖凭证在收银台扫码核销，每次发放 1 件。</p>
    {loading && <p role="status">正在读取头巾活动配置</p>}
    {error && <div className="lotteryNotice dangerText" role="alert"><CircleAlert size={18} /><span>{error}</span></div>}
    {message && <div className="lotteryNotice" role="status"><Check size={18} /><span>{message}</span></div>}
    {!loading && !connection?.configured && !snapshot && <div className="lotteryEmpty"><Cloud size={28} /><h3>头巾活动尚未连接</h3><p className="lotteryHelp">使用头巾 H5 的专用管理接口接入；核销时，本机和活动须连接同一个券中心。</p><button className="utilityButton" onClick={() => setDialog(true)}><Link size={17} /> 配置头巾连接</button></div>}
    {snapshot && draft && <>
      <div className="lotteryHeading"><div><strong>{snapshot.campaign.title}</strong><small>配置版本 {snapshot.revision} · {snapshot.campaign.venue || '活动地点待定'}</small></div><span className={`lotteryStatus ${snapshot.campaign.enabled ? 'running' : ''}`}>{snapshot.campaign.enabled ? '允许新抽奖' : '新抽奖已暂停'}</span></div>
      <dl className="lotteryTotals scarfTotals"><div><dt>总名额</dt><dd>{snapshot.inventory.total}</dd></div><div><dt>剩余名额</dt><dd>{snapshot.inventory.remaining}</dd></div><div><dt>已中奖</dt><dd>{snapshot.inventory.awarded}</dd></div><div><dt>已核销</dt><dd>{snapshot.inventory.redeemed ?? '待核对'}</dd></div><div><dt>中奖概率</dt><dd>{(snapshot.campaign.winProbabilityBps / 100).toFixed(2)}<small>%</small></dd></div></dl>
      <div className={`lotteryNotice ${!loading && centerProblem ? 'dangerText' : ''}`} role="status"><Cloud size={18} /><span>{loading ? '正在核对核销连接…' : centerProblem || `核销已接入相同券中心 · ${coupon.environment === 'production' ? '正式环境' : '测试环境'}`}{couponError && ` ${couponError}`}</span></div>
      <div className="scarfRedemption"><div><strong>领奖核销</strong><p>回到「收银」扫描中奖条码 → 奖品免费入单 → 完成 0 元结算后发放。核销成功后扣减本机商品库存，H5 领取状态同步更新。</p></div>{onCashier && <button type="button" className="utilityButton" disabled={disabled} onClick={onCashier}><ShoppingCart size={17} /> 去收银核销</button>}</div>
      <LotteryRecords key={`${connection?.url}:${snapshot.campaignId}`} activity="scarf" campaignId={snapshot.campaignId} connectionKey={connection?.url} supported={snapshot.capabilities?.includes(DRAW_RECORDS_CAPABILITY)} />
      {snapshot.campaign.enabled && <p className="lotteryHelp">修改奖品、概率、时间或活动说明前，请先在下方填写原因并暂停新抽奖。</p>}
      <div className="scarfFields">
        <label>活动名称<input value={draft.title} maxLength={60} disabled={editingDisabled} onChange={e => change('title', e.target.value)} /></label>
        <label>活动地点<input value={draft.venue} maxLength={100} placeholder="越野赛事现场" disabled={editingDisabled} onChange={e => change('venue', e.target.value)} /></label>
        <label className="scarfWide">核销时扣库存的商品<select value={boundProduct?.id || ''} disabled={editingDisabled} onChange={e => selectProduct(e.target.value)}><option value="">选择库存商品</option>{choices.map(p => <option key={p.id} value={p.id}>{p.name} · {p.sku || p.barcode} · 库存 {p.stock}</option>)}</select></label>
        <p className="lotteryHelp scarfWide">只列出编码或条码唯一的实物商品。更换商品后，已中奖用户仍领取原商品；原商品需保留到核销结束。</p>
        <label>奖品名称<input value={draft.prize.name} maxLength={60} disabled={editingDisabled} onChange={e => changePrize('name', e.target.value)} /></label>
        <label>奖品图片地址<input type="url" value={draft.prize.imageUrl} maxLength={2000} placeholder="https://…（留空使用黄橘头巾插图）" disabled={editingDisabled} onChange={e => changePrize('imageUrl', e.target.value)} /></label>
        {imageUrl && <img className="lotteryImagePreview scarfWide" src={imageUrl} alt="头巾奖品图片预览" referrerPolicy="no-referrer" />}
        <label>总名额（含已中奖）<input type="number" min={snapshot.inventory.awarded} max="1000000" step="1" value={draft.total} disabled={editingDisabled} onChange={e => change('total', e.target.value)} /></label>
        <label>中奖概率 %<input type="number" min="0" max="100" step="0.01" value={draft.percentage} disabled={editingDisabled} onChange={e => change('percentage', e.target.value)} /></label>
        <p className="lotteryHelp scarfWide">概率按每次抽奖独立计算。未中奖概率为剩余部分；名额耗尽后停止新抽奖。活动名额与本机实物库存需分别核对。</p>
        <label>活动开始时间<input type="datetime-local" value={draft.startsAt} disabled={editingDisabled} onChange={e => change('startsAt', e.target.value)} /></label>
        <label>活动结束时间<input type="datetime-local" value={draft.endsAt} disabled={editingDisabled} onChange={e => change('endsAt', e.target.value)} /></label>
        <label>核销截止时间<input type="datetime-local" value={draft.redeemEndsAt} disabled={editingDisabled} onChange={e => change('redeemEndsAt', e.target.value)} /></label>
        <p className="lotteryHelp">时间暂未确定时可以全部留空保存，活动保持暂停；填写完整时间并保存后才能开启。</p>
      </div>
      <ActivityRulesEditor id="scarf-rules-text" activity="山野有约" value={draft.rulesText} supported={snapshot.capabilities?.includes(RULES_TEXT_CAPABILITY)} disabled={editingDisabled}
        onChange={value => change('rulesText', value)} />
      <div className="lotteryEdit"><label>调整原因<input value={reason} maxLength={200} disabled={disabled} onChange={e => { setReason(e.target.value); setConfirmed(false); }} /></label>
        <label className={`lotteryConfirm ${confirmed ? 'checked' : ''}`}><input type="checkbox" checked={confirmed} disabled={disabled} onChange={e => setConfirmed(e.target.checked)} /><span>{confirmed ? '已确认' : '待确认'} · 已核对奖品配置和活动说明，已有中奖凭证保持原权益</span></label>
        <div className="lotteryActions">{snapshot.campaign.enabled ? <button className="utilityButton" disabled={disabled || !confirmed || !reason.trim()} onClick={() => update('pause')}><Pause size={17} /> 暂停新抽奖</button> : <>
          <button className="submitButton" disabled={disabled || !confirmed || !reason.trim()} onClick={() => update('configure')}><Save size={17} /> 保存头巾活动</button>
          <button className="utilityButton" disabled={disabled || !confirmed || !reason.trim() || dirty || !datesReady || !!centerProblem || snapshot.inventory.remaining <= 0} onClick={() => update('resume')}><Play size={17} /> 开启新抽奖</button>
        </>}</div>
        {!snapshot.campaign.enabled && <p className="lotteryHelp">开启条件：已保存配置、时间完整、剩余名额充足，并连接相同券中心。</p>}
      </div>
      <section className="lotteryAudit" aria-label="头巾活动调整记录"><h3>调整记录</h3>{!snapshot.audit?.length && <p>暂无调整记录</p>}{(snapshot.audit || []).map(row => <details key={row.revision}><summary><span>{labels[row.operation] || row.operation} · 版本 {row.revision}</span><time>{dateText(row.at)}</time><span>{row.reason}</span></summary>{row.rulesTextChanged && <div className="lotteryAuditRows"><p>活动说明已更新</p></div>}</details>)}</section>
    </>}
    {dialog && <ScarfConnectionDialog connection={connection} busy={disabled} error={error} onClose={() => setDialog(false)} run={(fn, success, refresh = true) => { if (!refresh || !dirty || window.confirm('切换连接会放弃待保存的头巾配置，继续吗？')) return run(fn, success, refresh); }} onSuccess={() => { setDialog(false); setMessage('头巾活动连接已保存'); }} />}
  </section>;
}

function ScarfConnectionDialog({ connection, busy, error, onClose, run, onSuccess }) {
  const fileRef = useRef(null), [password, setPassword] = useState(''), [notice, setNotice] = useState('');
  async function exportConnection() {
    const bundle = await call('export-connection', { password });
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = '头巾活动管理连接-加密.json'; a.click(); URL.revokeObjectURL(url);
    setPassword(''); setNotice('连接包已导出，密码请另行保管');
  }
  return <div className="modalBackdrop"><div className="modal lotteryModal" role="dialog" aria-modal="true" aria-label="头巾活动云端连接"><div className="sectionHeader"><h2>头巾活动云端连接</h2><button className="iconButton" disabled={busy} aria-label="关闭头巾连接" onClick={onClose}><X size={18} /></button></div>
    <p className="lotteryHelp">独立保存此活动连接。券中心连接请在「券管理」中核对。</p>
    {error && <p className="dangerText" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <form onSubmit={e => { e.preventDefault(); const input = Object.fromEntries(new FormData(e.currentTarget)); run(() => call('connect', { ...input, campaignId: SCARF_CAMPAIGN_ID }), onSuccess); }}>
      <label>头巾 HTTPS 管理接口<input name="url" type="url" defaultValue={connection?.url || ''} placeholder="https://活动域名/api/scarf-management" required /></label>
      <label>活动编号<input value={SCARF_CAMPAIGN_ID} readOnly /></label>
      <label>头巾管理密钥<input name="key" type="password" autoComplete="new-password" required minLength={64} maxLength={64} /></label>
      <button className="submitButton" disabled={busy}><Link size={17} /> 验证并保存头巾连接</button>
    </form>
    <div className="lotteryTransfer"><label>连接包密码（至少 12 个字符）<input type="password" autoComplete="new-password" maxLength={200} value={password} onChange={e => setPassword(e.target.value)} /></label><div className="lotteryActions">
      <button className="utilityButton" disabled={busy || !connection?.configured || password.length < 12} onClick={() => run(exportConnection, undefined, false)}><Download size={17} /> 导出头巾连接</button>
      <button className="utilityButton" disabled={busy || password.length < 12} onClick={() => fileRef.current.click()}><Upload size={17} /> 导入头巾连接</button>
      <input ref={fileRef} type="file" accept=".json" hidden onChange={e => { const file = e.target.files[0]; e.target.value = ''; if (file) run(async () => { if (file.size > 50000) throw new Error('连接包文件过大'); return call('import-connection', { bundle: JSON.parse(await file.text()), password }); }, onSuccess); }} />
    </div></div>
  </div></div>;
}
