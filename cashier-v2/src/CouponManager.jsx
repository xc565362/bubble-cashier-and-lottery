import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { couponBarcodeForDisplay, isAwardBarcode } from './couponBarcode.js';
import { ArrowLeft, ArrowRight, Check, Cloud, Copy, Download, KeyRound, Link, Pause, Play, Plus, QrCode, RefreshCw, Ticket, Trash2, X } from 'lucide-react';
import { sqbCall } from './sqb.jsx';
import { getOnlineSession } from './onlineApi.js';
import { loadCouponWorkspace } from './couponWorkspace.js';
import './coupons.css';

const labels = { AVAILABLE: '可使用', RESERVED: '使用中', PAYMENT_PENDING: '付款待核实', REDEEMED: '已核销', EXPIRED: '已过期', VOID: '已作废' };
const money = value => `¥${(value / 100).toFixed(2)}`;
const date = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
const expiry = value => value.redemptionEndsAt || value.expiresAt;
const localDate = time => { const d = new Date(time); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const request = (action, input = {}) => sqbCall(`coupon-${action}`, input);
const mutation = (action, input = {}) => request(action, { requestId: crypto.randomUUID(), ...input });

function CouponBarcode({ code }) {
  const container = useRef(null);
  const [drawing, setDrawing] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const resize = () => {
      try { setDrawing(couponBarcodeForDisplay(code, container.current.getBoundingClientRect().width, window.devicePixelRatio || 1)); setError(''); }
      catch { setDrawing(null); setError('请横屏查看条形码，或使用下方复制券码'); }
    };
    resize();
    const observer = new ResizeObserver(resize); observer.observe(container.current);
    window.addEventListener('resize', resize);
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); };
  }, [code]);
  return <div className="couponBarcode" ref={container}>{drawing && <svg viewBox={`0 0 ${drawing.width} ${drawing.height}`} role="img" aria-label="优惠券核销条形码" shapeRendering="crispEdges">
    <rect width={drawing.width} height={drawing.height} fill="#fff" />
    {drawing.bars.map(bar => <rect key={bar.x} {...bar} fill="#000" />)}
  </svg>}{error && <small role="status">{error}</small>}<small>结算完成后核销 · 每张券限用一次</small></div>;
}

export function CouponManager({products = [], canRecover = true}) {
  const staff = getOnlineSession()?.user?.role === 'cashier';
  const [bindings,setBindings] = useState({prizes:{}});
  const prizeOptions = [['cap','户外棒球帽（砾石灰）','BB250005'],['bucket','户外渔夫帽（晨雾蓝）','BB250003'],['waist','轻量化运动腰包（海雾蓝）','BB240011'],['tote','超大编织袋','BB260057']];
  const [tab, setTab] = useState('campaigns');
  const [config, setConfig] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [coupons, setCoupons] = useState({ items: [], total: 0, page: 1, pageSize: 30 });
  const [keys, setKeys] = useState([]);
  const [pending, setPending] = useState([]);
  const [filter, setFilter] = useState({ campaignId: '', state: '', page: 1 });
  const [message, setMessage] = useState('');
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState(null);
  const [detail, setDetail] = useState(null);
  const [qr, setQr] = useState('');
  const [secret, setSecret] = useState(null);
  const working = useRef(false);
  const alive = useRef(true);
  const generation = useRef(0);
  const editorRequest = useRef(crypto.randomUUID());
  useEffect(() => { editorRequest.current = crypto.randomUUID(); }, [editor]);
  async function load() {
    const version = ++generation.current;
    setLoading(true); setLoadError('');
    try {
      const next = await loadCouponWorkspace(request, { staff, filter, canRecover });
      if (!alive.current || version !== generation.current) return;
      setConfig(next.config); setCampaigns(next.campaigns); setCoupons(next.coupons); setKeys(next.keys); setPending(next.pending); setBindings(next.bindings);
    } catch (error) { if (alive.current && version === generation.current) setLoadError(error.message.includes('不支持') ? '券服务尚未更新，请重新启动新版收银服务' : error.message); }
    finally { if (alive.current && version === generation.current) setLoading(false); }
  }
  useEffect(() => { alive.current = true; load(); return () => { alive.current = false; generation.current++; }; }, [filter.campaignId, filter.state, filter.page, canRecover]);
  useEffect(() => {
    let cancelled = false; setQr('');
    if (detail?.state === 'AVAILABLE' && detail.code && !isAwardBarcode(detail.code)) QRCode.toDataURL(detail.code, { width: 280, margin: 2, errorCorrectionLevel: 'M' }).then(value => { if (!cancelled) setQr(value); }).catch(() => { if (!cancelled) setMessage('二维码生成失败'); });
    return () => { cancelled = true; };
  }, [detail]);
  async function run(task, success) {
    if (working.current) return;
    working.current = true; setBusy(true); setMessage('');
    try { const result = await task(); if (success) success(result); await load(); }
    catch (error) { setMessage(error.message); }
    finally { working.current = false; setBusy(false); }
  }
  async function copy(value) {
    try { await navigator.clipboard.writeText(value); setMessage('已复制'); } catch { setMessage('复制失败，请手动选择内容'); }
  }
  function download(value, name) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url);
  }
  const submit = async event => {
    event.preventDefault(); const input = Object.fromEntries(new FormData(event.currentTarget));
    if (editor.type === 'campaign') run(() => mutation('create-campaign', { requestId: editorRequest.current, name: input.name, kind:input.kind || 'cash', ...(input.kind === 'physical' ? {physical:{prizeId:input.prizeId,quantity:1}} : {}), amountCents: input.kind === 'physical' ? 0 : Math.round(Number(input.amount) * 100), minimumCents: input.kind === 'physical' ? 0 : Math.round(Number(input.minimum) * 100),
      quota: Number(input.quota), startsAt: new Date(input.startsAt).toISOString(), expiresAt: new Date(input.expiresAt).toISOString() }), () => setEditor(null));
    else if (editor.type === 'issue') run(() => mutation('issue', { campaignId: editor.campaign.id, owner: input.owner, awardId: input.awardId }), value => { setEditor(null); setDetail(value); });
    else if (editor.type === 'key') run(() => mutation('create-key', { requestId: editorRequest.current, name: input.name, role: 'lottery', campaignId: input.campaignId }), value => { setEditor(null); setSecret(value); });
    else if (editor.type === 'connect') run(() => request('connect', { mode: 'remote', baseUrl: input.baseUrl, adminToken: input.adminToken }), () => setEditor(null));
  };
  if (staff) return <section className="workspace fullWorkspace couponManager" aria-label="兑奖恢复">
    <div className="sectionHeader"><h2><Ticket size={21} /> 兑奖恢复</h2><button className="utilityButton" disabled={busy || loading} onClick={load}><RefreshCw size={18} /> 核对券状态</button></div>
    <p>扫码后遇到断网或刷新，可在这里核对尚未完成的领取。先取得收银权限；未发起结算的占用可释放后重新扫码，已进入结算的订单请回到收银台继续核对。</p>
    {!canRecover && <p className="lotteryHelp">当前显示服务器最近保存的待处理记录；取得收银权限后才能重新核对或释放占用。</p>}
    {message && <div className="couponMessage" role="status">{message}</div>}
    {loadError && <p className="dangerText" role="alert">{loadError}</p>}
    {loading ? <div className="couponLoading" role="status">正在核对领取状态</div> : loadError ? null : pending.length ? pending.map(row => <div className="couponKey" key={row.id}>
      <div><strong>{row.coupon?.name || '抽奖奖品'}</strong><small>{labels[row.coupon?.state] || '待核对'} · {row.error || row.orderId || row.id}</small></div>
      {row.canRelease === true ? <button className="utilityButton" disabled={busy || !canRecover} onClick={() => run(() => request('release', { id: row.id }))}>释放并重新扫码</button> : <span>请在收银台继续核对</span>}
    </div>) : <p className="couponEmpty">暂无待处理领取</p>}
  </section>;
  return <section className="workspace fullWorkspace couponManager" aria-label="券管理">
    <div className="sectionHeader"><h2><Ticket size={21} /> 券管理</h2><div className="couponTools">
      <button className="iconButton" title="刷新券状态" aria-label="刷新券状态" disabled={busy || loading} onClick={load}><RefreshCw size={18} /></button>
      <button className="utilityButton" disabled={busy} onClick={() => setEditor({ type: 'connect' })}><Link size={17} /> 云端连接</button>
    </div></div>
    <div className={`couponConnection ${!loading && !loadError && config?.integrationReady ? 'connected' : ''}`} role="status"><Cloud size={18} /><div>
      <strong>{loading ? '正在核对券服务连接…' : loadError ? '券服务连接待核对' : config?.integrationReady ? '正式券服务已连接' : config?.mode === 'remote' ? '云端测试环境' : config ? '本机联调 · 尚未连接小程序券中心' : '券服务连接待核对'}</strong>
      {config?.baseUrl && <small>{config.baseUrl}</small>}
      {config?.mode === 'remote' && <small>{config.physicalSupported ? '实物兑奖接口已支持 · 商品绑定另行核对' : '实物兑奖接口待服务器升级'}</small>}
    </div></div>
    {message && <div className="couponMessage" role="status"><span>{message}</span><button className="iconButton" aria-label="关闭券提示" onClick={() => setMessage('')}><X size={16} /></button></div>}
    <div className="couponTabs" role="tablist" aria-label="券管理视图">
      {[['campaigns', '券活动'], ['coupons', '发放记录'], ['physical','实物商品绑定'], ['integration', '小程序接入']].map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>{label}</button>)}
    </div>
    {loading && <div className="couponLoading" role="status">正在读取券数据</div>}
    {loadError && <p className="dangerText" role="alert">{loadError} · 本次未能核对最新券数据，请刷新重试。</p>}
    {!loading && !loadError && <>
    {tab === 'campaigns' && <div role="tabpanel" aria-label="券活动">
      <div className="couponToolbar"><span>{campaigns.length} 个活动</span><button className="submitButton" disabled={busy || !config} onClick={() => setEditor({ type: 'campaign' })}><Plus size={17} /> 创建券活动</button></div>
      {!loading && !campaigns.length && <div className="couponEmpty"><Ticket size={28} /><h3>暂无券活动</h3></div>}
      <div className="couponCampaigns">{campaigns.map(c => <article className="couponCampaign" key={c.id}>
        <div className="couponCampaignHeading"><h3>{c.name}</h3><span className={`couponBadge ${c.enabled ? 'AVAILABLE' : 'VOID'}`}>{new Date(expiry(c)) <= new Date() ? '已结束' : c.enabled ? '发放中' : '已暂停'}</span></div>
        <div className="couponValue"><strong>{c.kind === 'physical' ? '实物奖品 · 1 件' : money(c.amountCents)}</strong><span>{c.kind === 'physical' ? '由抽奖后台生成兑奖码' : c.minimumCents ? `满 ${money(c.minimumCents)} 可用` : '无门槛'}</span></div>
        <dl><div><dt>已发 / 总量</dt><dd>{c.issued} / {c.quota}</dd></div><div><dt>有效期</dt><dd>{date(c.startsAt)} 至 {date(expiry(c))}</dd></div>
          <div><dt>活动编号</dt><dd className="couponIdentifier"><code>{c.id}</code><button className="iconButton" title="复制活动编号" aria-label={`复制${c.name}活动编号`} onClick={() => copy(c.id)}><Copy size={14} /></button></dd></div></dl>
        <div className="couponCampaignActions"><button className="utilityButton" disabled={busy || c.kind === 'physical' || !c.enabled || c.issued >= c.quota || new Date(expiry(c)) <= new Date()} onClick={() => setEditor({ type: 'issue', campaign: c, awardId: crypto.randomUUID() })}><Plus size={16} /> 发券</button>
          <button className="utilityButton" onClick={() => { setFilter({ campaignId: c.id, state: '', page: 1 }); setTab('coupons'); }}>发放记录</button>
          <button className="iconButton" title={c.enabled ? '暂停发放' : '恢复发放'} aria-label={`${c.enabled ? '暂停' : '恢复'}${c.name}`} disabled={busy} onClick={() => run(() => mutation('set-campaign', { id: c.id, enabled: !c.enabled }))}>{c.enabled ? <Pause size={17} /> : <Play size={17} />}</button>
        </div>
      </article>)}</div>
    </div>}
    {tab === 'coupons' && <div role="tabpanel" aria-label="发放记录">
      <div className="couponFilters"><label>活动<select value={filter.campaignId} onChange={event => setFilter({ ...filter, campaignId: event.target.value, page: 1 })}><option value="">全部活动</option>{campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label>券状态<select value={filter.state} onChange={event => setFilter({ ...filter, state: event.target.value, page: 1 })}><option value="">全部状态</option>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div>
      <div className="couponTableWrap"><table className="couponTable"><thead><tr><th>券 / 领取人</th><th>奖品 / 面额</th><th>状态</th><th>发放 / 核销时间</th><th>操作</th></tr></thead><tbody>
        {coupons.items.map(c => <tr key={c.id}><td><strong>{c.name}</strong><small>{c.owner}</small><small>{c.id.slice(0, 8)}</small></td><td>{c.kind === 'physical' ? '实物奖品 · 1 件' : money(c.amountCents)}{c.reservation?.discountCents !== undefined && <small>抵扣 {money(c.reservation.discountCents)}</small>}</td>
          <td><span className={`couponBadge ${c.state}`}>{labels[c.state]}</span></td><td>{date(c.issuedAt)}{c.redeemedAt && <small>{date(c.redeemedAt)}</small>}</td><td><div className="couponRowActions">
            <button className="iconButton" title="查看券详情" aria-label={`查看券${c.id.slice(0, 8)}`} disabled={busy} onClick={() => run(() => request('coupon', { id: c.id }), setDetail)}><QrCode size={18} /></button>
            {c.state === 'AVAILABLE' && <button className="iconButton dangerIcon" title="作废券" aria-label={`作废券${c.id.slice(0, 8)}`} disabled={busy} onClick={() => { const reason = window.prompt('请输入作废原因'); if (reason?.trim()) run(() => mutation('void', { id: c.id, reason })); }}><Trash2 size={18} /></button>}
          </div></td></tr>)}
      </tbody></table></div>
      {!loading && !coupons.items.length && <p className="couponEmpty">暂无符合条件的券</p>}
      <div className="couponPagination"><span>共 {coupons.total} 张 · 第 {coupons.page} 页</span><button className="iconButton" title="上一页" aria-label="上一页券" disabled={loading || filter.page <= 1} onClick={() => setFilter({ ...filter, page: filter.page - 1 })}><ArrowLeft size={18} /></button><button className="iconButton" title="下一页" aria-label="下一页券" disabled={loading || filter.page * coupons.pageSize >= coupons.total} onClick={() => setFilter({ ...filter, page: filter.page + 1 })}><ArrowRight size={18} /></button></div>
    </div>}
    {tab === 'physical' && <div role="tabpanel" aria-label="实物商品绑定" className="couponIntegration"><h3>抽奖奖品与现有商品库存</h3>
      {!config?.integrationReady && <p className="couponWarning">正式券中心尚未连接，当前不能核销小程序正式奖品。</p>}
      {config?.mode === 'remote' && !config.physicalSupported && <p className="couponWarning">券服务器尚未支持实物兑奖。</p>}
      {prizeOptions.map(([id,name,code,names]) => {
      const matches=products.filter(p => code ? [p.sku,p.barcode].some(value => String(value || '').trim() === code) : (names || [name]).includes(String(p.name || '').trim()));
      const saved=bindings.prizes[id]?.product;
      const matchesSaved = saved && matches.length === 1 && ['id','name','sku','barcode'].every(field => (saved[field] || '') === (matches[0][field] || ''));
      return <div className="couponKey" key={id}><div><strong>{name} · {code || '按完整名称匹配'}</strong><small>{matches.length === 1 ? matches[0].name + ' · 库存 ' + matches[0].stock : matches.length ? '匹配到多个商品，请修正重复编码或名称' : '未找到商品，请先维护商品资料'}</small><small className={saved && !matchesSaved ? 'dangerText' : ''}>{saved ? matchesSaved ? '已绑定：'+saved.name : '原绑定商品已变更，待重新核对' : '尚未绑定'}</small></div></div>;
    })}<button className="submitButton" disabled={busy || loading || pending.length > 0} onClick={() => run(() => request('bind-physical-products',{products}),setBindings)}><Check size={18} /> 确认四种奖品商品绑定</button>
      {pending.length > 0 && <p className="couponWarning">存在未完成领取，暂不能修改商品绑定。</p>}
    </div>}
    {tab === 'integration' && <div role="tabpanel" aria-label="小程序接入" className="couponIntegration">
      <div className="couponToolbar"><h3>抽奖后台凭证</h3><button className="utilityButton" disabled={busy || !campaigns.length} onClick={() => setEditor({ type: 'key' })}><KeyRound size={17} /> 新建接入凭证</button></div>
      {keys.filter(k => k.role === 'lottery').map(k => <div className="couponKey" key={k.id}><div><strong>{k.name}</strong><small>{campaigns.find(c => c.id === k.campaignId)?.name} · {k.enabled ? '有效' : '已停用'}</small></div><button className="iconButton" title="停用凭证" aria-label={`停用${k.name}`} disabled={busy || !k.enabled} onClick={() => { if (window.confirm('停用后，此凭证将无法发券和查询。确认停用？')) run(() => mutation('revoke-key', { id: k.id })); }}><Trash2 size={17} /></button></div>)}
      <dl className="couponEndpoint"><div><dt>服务地址</dt><dd>{config?.baseUrl || '未配置线上地址'}</dd></div><div><dt>发券接口</dt><dd><code>POST /v1/coupons/issue</code></dd></div><div><dt>用户券列表</dt><dd><code>GET /v1/coupons?owner=用户标识</code></dd></div><div><dt>接口版本</dt><dd>v1 · 仅限后台凭证调用</dd></div></dl>
      <div className="couponToolbar"><h3>收银占用 / 待同步</h3><button className="utilityButton" disabled={busy || !canRecover} onClick={() => run(() => request('sync'), setPending)}><RefreshCw size={17} /> 核对券状态</button></div>
      {!canRecover && <p className="lotteryHelp">待处理领取显示服务器最近保存的记录；取得收银权限后才能重新核对或释放占用。</p>}
      {pending.length ? pending.map(row => <div className="couponKey" key={row.id}><div><strong>{row.coupon.name}</strong><small>{labels[row.coupon.state]} · {row.error || row.orderId || row.id}</small></div>{row.canRelease && <button className="utilityButton" disabled={busy || !canRecover} onClick={() => run(() => request('release', { id: row.id }))}>释放</button>}</div>) : <p className="couponEmpty">暂无待处理券</p>}
    </div>}
    </>}
    {editor && <div className="modalBackdrop"><form className="modal couponEditor" role="dialog" aria-modal="true" aria-label={{ campaign: '创建券活动', issue: '发券', key: '新建接入凭证', connect: '云端连接' }[editor.type]} onSubmit={submit}>
      <div className="modalHead"><h2>{{ campaign: '创建券活动', issue: '发券', key: '新建接入凭证', connect: '云端连接' }[editor.type]}</h2><button className="iconButton" type="button" aria-label="关闭券编辑" disabled={busy} onClick={() => setEditor(null)}><X size={20} /></button></div>
      <fieldset disabled={busy} className="couponForm">
        {editor.type === 'campaign' && <><label className="fullField">券名称<input name="name" maxLength={60} required autoFocus /></label><label>奖品类型<select name="kind" value={editor.kind || 'cash'} onChange={e => setEditor({...editor,kind:e.target.value})}><option value="cash">购物抵扣券</option><option value="physical">实物奖品</option></select></label>{editor.kind === 'physical' ? <label>对应奖品<select name="prizeId">{prizeOptions.map(([id,name]) => <option key={id} value={id}>{name}</option>)}</select></label> : <><label>面额（元）<input name="amount" type="number" min="0.01" max="10000" step="0.01" required /></label><label>使用门槛（元）<input name="minimum" type="number" min="0" step="0.01" defaultValue="0" required /></label></>}<label className="fullField">发放上限（张）<input name="quota" type="number" min="1" max="1000000" step="1" required defaultValue="100" /></label><label>生效时间<input name="startsAt" type="datetime-local" defaultValue={localDate(Date.now())} required /></label><label>到期时间<input name="expiresAt" type="datetime-local" defaultValue={localDate(Date.now() + 30 * 86400000)} required /></label></>}
        {editor.type === 'issue' && <><p className="fullField">{editor.campaign.name} · {money(editor.campaign.amountCents)}</p><label className="fullField">领取人标识<input name="owner" maxLength={120} required autoFocus /></label><label className="fullField">发放记录号<input name="awardId" maxLength={120} required defaultValue={editor.awardId} /></label></>}
        {editor.type === 'key' && <><label className="fullField">凭证名称<input name="name" maxLength={60} required autoFocus /></label><label className="fullField">授权活动<select name="campaignId" required>{campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label></>}
        {editor.type === 'connect' && <><label className="fullField">券服务 HTTPS 地址<input name="baseUrl" type="url" placeholder="https://coupons.example.com" defaultValue={config?.baseUrl || ''} required autoFocus /></label><label className="fullField">管理密钥<input name="adminToken" type="password" minLength={32} maxLength={300} autoComplete="off" required /></label></>}
      </fieldset>
      {message && <p className="dangerText" role="alert">{message}</p>}
      <button className="submitButton" disabled={busy}><Check size={18} /> {busy ? '正在处理' : editor.type === 'connect' ? '验证并连接' : editor.type === 'issue' ? '确认发券' : '保存'}</button>
    </form></div>}
    {detail && <div className="modalBackdrop"><div className="modal couponDetail" role="dialog" aria-modal="true" aria-label="券详情"><div className="modalHead"><h2>{detail.name}</h2><button className="iconButton" aria-label="关闭券详情" onClick={() => setDetail(null)}><X size={20} /></button></div>
      <strong className="couponDetailAmount">{detail.kind === 'physical' ? '实物奖品 · 免费 1 件' : money(detail.amountCents)}</strong><span className={`couponBadge ${detail.state}`}>{labels[detail.state]}</span>
      {detail.environment !== 'production' && <p className="couponWarning">联调券 · 非正式营业券</p>}
      {detail.state === 'AVAILABLE' && isAwardBarcode(detail.code) && <CouponBarcode code={detail.code} />}
      {detail.state === 'AVAILABLE' && detail.code && !isAwardBarcode(detail.code) && qr && <img className="couponQr" src={qr} alt="优惠券核销二维码" />}
      <dl><div><dt>领取人</dt><dd>{detail.owner}</dd></div><div><dt>券编号</dt><dd>{detail.id}</dd></div><div><dt>有效期至</dt><dd>{date(expiry(detail))}</dd></div>{detail.reservation?.orderNo && <div><dt>关联订单</dt><dd>{detail.reservation.orderNo}</dd></div>}{detail.paymentReference && <div><dt>支付编号</dt><dd>{detail.paymentReference}</dd></div>}</dl>
      {detail.state === 'AVAILABLE' && detail.code && <button className="utilityButton" onClick={() => copy(detail.code)}><Copy size={17} /> 复制券码</button>}
    </div></div>}
    {secret && <div className="modalBackdrop"><div className="modal couponEditor" role="dialog" aria-modal="true" aria-label="接入凭证已生成"><div className="modalHead"><h2>接入凭证已生成</h2><button className="iconButton" aria-label="关闭接入凭证" onClick={() => setSecret(null)}><X size={20} /></button></div><p className="couponWarning">仅供抽奖后台使用，不可放入小程序前端或公开分享。</p><textarea readOnly aria-label="抽奖后台接入密钥" rows={4} value={secret.token} /><div className="couponTools"><button className="utilityButton" onClick={() => copy(secret.token)}><Copy size={17} /> 复制</button><button className="utilityButton" onClick={() => download({ baseUrl: config?.baseUrl || null, environment: config?.environment, campaignId: secret.campaignId, token: secret.token }, '抽奖后台接入凭证.json')}><Download size={17} /> 下载凭证</button></div></div></div>}
  </section>;
}
