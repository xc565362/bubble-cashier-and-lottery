import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from '../lib/motion.js';
import QRCode from 'qrcode';
import { ArrowLeft, ArrowRight, CalendarClock, Check, Cloud, Copy, Download, KeyRound, Link2, Pause, Play, Plus, QrCode, RefreshCw, Ticket, Trash2, TrendingUp } from 'lucide-react';
import { couponBarcodeForDisplay, isAwardBarcode } from '../logic/couponBarcode.js';
import { sqbCall } from '../api/sqb.js';
import { getOnlineSession } from '../api/online.js';
import { loadCouponWorkspace } from '../logic/couponWorkspace.js';
import { Modal, PageShell, Badge, EmptyState } from '../components/ui.jsx';
import { downloadJson } from '../lib/format.js';

const labels = { AVAILABLE: '可使用', RESERVED: '使用中', PAYMENT_PENDING: '付款待核实', REDEEMED: '已核销', EXPIRED: '已过期', VOID: '已作废' };
const badgeTone = { AVAILABLE: 'ok', RESERVED: 'warn', PAYMENT_PENDING: 'warn', REDEEMED: 'neutral', EXPIRED: 'neutral', VOID: 'danger' };
const money = (value) => `¥${(value / 100).toFixed(2)}`;
const date = (value) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const expiry = (value) => value.redemptionEndsAt || value.expiresAt;
const localDate = (time) => { const d = new Date(time); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
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
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    window.addEventListener('resize', resize);
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); };
  }, [code]);
  return (
    <div className="w-full space-y-1" ref={container}>
      {drawing && (
        <svg viewBox={`0 0 ${drawing.width} ${drawing.height}`} role="img" aria-label="优惠券核销条形码" shapeRendering="crispEdges" className="w-full rounded-lg">
          <rect width={drawing.width} height={drawing.height} fill="#fff" />
          {drawing.bars.map((bar) => <rect key={bar.x} {...bar} fill="#000" />)}
        </svg>
      )}
      {error && <small role="status" className="block text-center text-xs text-amber-300">{error}</small>}
      <small className="block text-center text-xs text-mist">结算完成后核销 · 每张券限用一次</small>
    </div>
  );
}

export function CouponsScreen({ products = [] }) {
  const staff = getOnlineSession()?.user?.role !== 'admin';
  const [bindings, setBindings] = useState({ prizes: {} });
  const prizeOptions = [['cap', '户外棒球帽（砾石灰）', 'BB250005'], ['bucket', '户外渔夫帽（晨雾蓝）', 'BB250003'], ['waist', '轻量化运动腰包（海雾蓝）', 'BB240011'], ['tote', '超大编织袋', 'BB260057']];
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
      const next = await loadCouponWorkspace(request, { staff, filter });
      if (!alive.current || version !== generation.current) return;
      setConfig(next.config); setCampaigns(next.campaigns); setCoupons(next.coupons); setKeys(next.keys); setPending(next.pending); setBindings(next.bindings);
    } catch (error) {
      if (alive.current && version === generation.current) setLoadError(error.message.includes('不支持') ? '券服务尚未更新，请重新启动新版收银服务' : error.message);
    } finally {
      if (alive.current && version === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; generation.current++; };
  }, [filter.campaignId, filter.state, filter.page]);

  useEffect(() => {
    let cancelled = false; setQr('');
    if (detail?.state === 'AVAILABLE' && detail.code && !isAwardBarcode(detail.code)) {
      QRCode.toDataURL(detail.code, { width: 280, margin: 2, errorCorrectionLevel: 'M' }).then((value) => { if (!cancelled) setQr(value); }).catch(() => { if (!cancelled) setMessage('二维码生成失败'); });
    }
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

  const submit = async (event) => {
    event.preventDefault();
    const input = Object.fromEntries(new FormData(event.currentTarget));
    if (editor.type === 'campaign') run(() => mutation('create-campaign', {
      requestId: editorRequest.current, name: input.name, kind: input.kind || 'cash',
      ...(input.kind === 'physical' ? { physical: { prizeId: input.prizeId, quantity: 1 } } : {}),
      amountCents: input.kind === 'physical' ? 0 : Math.round(Number(input.amount) * 100),
      minimumCents: input.kind === 'physical' ? 0 : Math.round(Number(input.minimum) * 100),
      quota: Number(input.quota),
      startsAt: new Date(input.startsAt).toISOString(),
      expiresAt: new Date(input.expiresAt).toISOString(),
    }), () => setEditor(null));
    else if (editor.type === 'issue') run(() => mutation('issue', { campaignId: editor.campaign.id, owner: input.owner, awardId: input.awardId }), (value) => { setEditor(null); setDetail(value); });
    else if (editor.type === 'quota') run(() => mutation('increase-quota', { id: editor.campaign.id, quota: Number(input.quota), reason: input.reason }), () => setEditor(null));
    else if (editor.type === 'deadline') run(() => mutation('set-deadline', { campaignIds: [editor.campaign.id], redemptionEndsAt: new Date(input.deadline).toISOString(), reason: input.reason }), () => setEditor(null));
    else if (editor.type === 'key') run(() => mutation('create-key', { requestId: editorRequest.current, name: input.name, role: 'lottery', campaignId: input.campaignId }), (value) => { setEditor(null); setSecret(value); });
    else if (editor.type === 'connect') run(() => request('connect', { mode: 'remote', baseUrl: input.baseUrl, adminToken: input.adminToken }), () => setEditor(null));
  };

  if (staff) {
    return (
      <PageShell
        kicker="Recovery"
        title="兑奖恢复"
        actions={<button className="btn-ghost text-sm" disabled={busy || loading} onClick={load}><RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> 核对券状态</button>}
      >
        <p className="mb-4 text-sm text-mist">扫码后遇到断网或刷新，可在这里核对尚未完成的领取。未发起结算的占用可释放后重新扫码，已进入结算的订单请回到收银台继续核对。</p>
        {message && <Notice>{message}</Notice>}
        {loadError && <Notice tone="danger">{loadError}</Notice>}
        {loading ? (
          <p className="py-14 text-center text-mist" role="status">正在核对领取状态</p>
        ) : loadError ? null : pending.length ? (
          <div className="space-y-2.5">{pending.map((row) => <PendingRow key={row.id} row={row} busy={busy} onRelease={() => run(() => request('release', { id: row.id }))} />)}</div>
        ) : (
          <EmptyState icon={Ticket} title="暂无待处理领取" />
        )}
      </PageShell>
    );
  }

  return (
    <PageShell
      kicker="Coupons"
      title="券管理"
      actions={
        <>
          <button className="btn-icon" title="刷新券状态" aria-label="刷新券状态" disabled={busy || loading} onClick={load}><RefreshCw size={17} className={loading ? 'animate-spin' : ''} /></button>
          <button className="btn-ghost text-sm" disabled={busy} onClick={() => setEditor({ type: 'connect' })}><Link2 size={16} /> 云端连接</button>
        </>
      }
    >
      <div className={`mb-4 flex items-center gap-3 rounded-xl border px-4 py-3 ${!loading && !loadError && config?.integrationReady ? 'border-emerald-400/30 bg-emerald-400/[0.07]' : 'border-white/10 bg-white/[0.04]'}`} role="status">
        <Cloud size={18} className={!loading && !loadError && config?.integrationReady ? 'text-emerald-300' : 'text-mist'} />
        <div>
          <strong className="text-sm">
            {loading ? '正在核对券服务连接…' : loadError ? '券服务连接待核对' : config?.integrationReady ? '正式券服务已连接' : config?.mode === 'remote' ? '云端测试环境' : config ? '本机联调 · 尚未连接小程序券中心' : '券服务连接待核对'}
          </strong>
          {config?.baseUrl && <p className="text-xs text-mist">{config.baseUrl}</p>}
          {config?.mode === 'remote' && <p className="text-xs text-mist">{config.physicalSupported ? '实物兑奖接口已支持 · 商品绑定另行核对' : '实物兑奖接口待服务器升级'}</p>}
        </div>
      </div>

      {message && <Notice onClose={() => setMessage('')}>{message}</Notice>}
      {loadError && <Notice tone="danger">{loadError} · 本次未能核对最新券数据，请刷新重试。</Notice>}

      <div className="mb-5 flex gap-1.5 overflow-x-auto rounded-xl border border-white/[0.06] bg-white/[0.03] p-1.5" role="tablist" aria-label="券管理视图">
        {[['campaigns', '券活动'], ['coupons', '发放记录'], ['physical', '实物商品绑定'], ['integration', '小程序接入']].map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`min-h-[40px] flex-1 whitespace-nowrap rounded-lg px-4 text-sm font-medium transition ${tab === key ? 'bg-coral/20 text-coral-soft shadow-pop' : 'text-mist hover:text-milk'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading && <p className="py-14 text-center text-mist" role="status">正在读取券数据</p>}
      {!loading && !loadError && (
        <>
          {tab === 'campaigns' && (
            <div role="tabpanel" aria-label="券活动">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm text-mist">{campaigns.length} 个活动</span>
                <button className="btn-primary" disabled={busy || !config} onClick={() => setEditor({ type: 'campaign' })}><Plus size={16} /> 创建券活动</button>
              </div>
              {!campaigns.length && <EmptyState icon={Ticket} title="暂无券活动" />}
              <div className="grid gap-3 md:grid-cols-2">
                <AnimatePresence initial={false}>
                  {campaigns.map((c) => (
                    <motion.article layout className="glass p-5" key={c.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <h3 className="truncate font-bold">{c.name}</h3>
                        <Badge tone={new Date(expiry(c)) <= new Date() ? 'neutral' : c.enabled ? 'ok' : 'danger'}>
                          {new Date(expiry(c)) <= new Date() ? '已结束' : c.enabled ? '发放中' : '已暂停'}
                        </Badge>
                      </div>
                      <div className="mb-3">
                        <strong className="text-2xl text-coral-soft">{c.kind === 'physical' ? '实物奖品 · 1 件' : money(c.amountCents)}</strong>
                        <p className="text-xs text-mist">{c.kind === 'physical' ? '由抽奖后台生成兑奖码' : c.minimumCents ? `满 ${money(c.minimumCents)} 可用` : '无门槛'}</p>
                      </div>
                      <dl className="mb-4 space-y-1 text-xs text-mist">
                        <div className="flex justify-between"><dt>已发 / 总量</dt><dd className="text-milk">{c.issued} / {c.quota}</dd></div>
                        <div className="flex justify-between gap-4"><dt>有效期</dt><dd className="text-right text-milk">{date(c.startsAt)} 至 {date(expiry(c))}</dd></div>
                        <div className="flex items-center justify-between gap-2">
                          <dt>活动编号</dt>
                          <dd className="flex items-center gap-1 font-mono text-[11px]">
                            <code className="truncate">{c.id}</code>
                            <button className="btn-icon !h-7 !w-7" title="复制活动编号" aria-label={`复制${c.name}活动编号`} onClick={() => copy(c.id)}><Copy size={12} /></button>
                          </dd>
                        </div>
                      </dl>
                      <div className="flex gap-2">
                        <button className="btn-primary flex-1 !min-h-[40px] !py-2 text-sm" disabled={busy || c.kind === 'physical' || !c.enabled || c.issued >= c.quota || new Date(expiry(c)) <= new Date()} onClick={() => setEditor({ type: 'issue', campaign: c, awardId: crypto.randomUUID() })}>
                          <Plus size={15} /> 发券
                        </button>
                        <button className="btn-ghost !min-h-[40px] !py-2 text-sm" onClick={() => { setFilter({ campaignId: c.id, state: '', page: 1 }); setTab('coupons'); }}>发放记录</button>
                        <button className="btn-icon !h-10 !w-10" title={c.enabled ? '暂停发放' : '恢复发放'} aria-label={`${c.enabled ? '暂停' : '恢复'}${c.name}`} disabled={busy} onClick={() => run(() => mutation('set-campaign', { id: c.id, enabled: !c.enabled }))}>
                          {c.enabled ? <Pause size={15} /> : <Play size={15} />}
                        </button>
                        <button className="btn-icon !h-10 !w-10" title="增加发放上限" aria-label={`增加${c.name}发放上限`} disabled={busy} onClick={() => setEditor({ type: 'quota', campaign: c })}>
                          <TrendingUp size={15} />
                        </button>
                        <button className="btn-icon !h-10 !w-10" title="缩短兑奖截止" aria-label={`缩短${c.name}兑奖截止`} disabled={busy || new Date(expiry(c)) <= new Date()} onClick={() => setEditor({ type: 'deadline', campaign: c })}>
                          <CalendarClock size={15} />
                        </button>
                      </div>
                    </motion.article>
                  ))}
                </AnimatePresence>
              </div>
            </div>
          )}

          {tab === 'coupons' && (
            <div role="tabpanel" aria-label="发放记录">
              <div className="mb-3 flex flex-wrap gap-3">
                <label className="block">
                  <span className="field-label">活动</span>
                  <select className="field !w-52" value={filter.campaignId} onChange={(e) => setFilter({ ...filter, campaignId: e.target.value, page: 1 })}>
                    <option value="">全部活动</option>
                    {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="field-label">券状态</span>
                  <select className="field !w-44" value={filter.state} onChange={(e) => setFilter({ ...filter, state: e.target.value, page: 1 })}>
                    <option value="">全部状态</option>
                    {Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                  </select>
                </label>
              </div>
              <div className="table-shell">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/[0.07] text-left text-xs text-mist">
                      <th className="px-4 py-3 font-medium">券 / 领取人</th>
                      <th className="px-4 py-3 font-medium">奖品 / 面额</th>
                      <th className="px-4 py-3 font-medium">状态</th>
                      <th className="px-4 py-3 font-medium">发放 / 核销时间</th>
                      <th className="px-4 py-3 font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {coupons.items.map((c) => (
                      <tr key={c.id} className="table-row">
                        <td className="px-4 py-3">
                          <strong className="block">{c.name}</strong>
                          <small className="block text-xs text-mist">{c.owner}</small>
                          <small className="font-mono text-[11px] text-mist/60">{c.id.slice(0, 8)}</small>
                        </td>
                        <td className="px-4 py-3">
                          {c.kind === 'physical' ? '实物奖品 · 1 件' : money(c.amountCents)}
                          {c.reservation?.discountCents !== undefined && <small className="block text-xs text-coral-soft">抵扣 {money(c.reservation.discountCents)}</small>}
                        </td>
                        <td className="px-4 py-3"><Badge tone={badgeTone[c.state]}>{labels[c.state]}</Badge></td>
                        <td className="px-4 py-3 text-xs text-mist">
                          {date(c.issuedAt)}
                          {c.redeemedAt && <small className="block">{date(c.redeemedAt)}</small>}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1.5">
                            <button className="btn-icon !h-9 !w-9" title="查看券详情" aria-label={`查看券${c.id.slice(0, 8)}`} disabled={busy} onClick={() => run(() => request('coupon', { id: c.id }), setDetail)}><QrCode size={16} /></button>
                            {c.state === 'AVAILABLE' && (
                              <button className="btn-icon !h-9 !w-9 hover:!border-red-400/50 hover:!text-red-300" title="作废券" aria-label={`作废券${c.id.slice(0, 8)}`} disabled={busy} onClick={() => { const reason = window.prompt('请输入作废原因'); if (reason?.trim()) run(() => mutation('void', { id: c.id, reason })); }}>
                                <Trash2 size={16} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!coupons.items.length && <p className="py-10 text-center text-sm text-mist">暂无符合条件的券</p>}
              </div>
              <div className="mt-3 flex items-center justify-end gap-3 text-sm text-mist">
                <span>共 {coupons.total} 张 · 第 {coupons.page} 页</span>
                <button className="btn-icon !h-9 !w-9" title="上一页" aria-label="上一页券" disabled={loading || filter.page <= 1} onClick={() => setFilter({ ...filter, page: filter.page - 1 })}><ArrowLeft size={16} /></button>
                <button className="btn-icon !h-9 !w-9" title="下一页" aria-label="下一页券" disabled={loading || filter.page * coupons.pageSize >= coupons.total} onClick={() => setFilter({ ...filter, page: filter.page + 1 })}><ArrowRight size={16} /></button>
              </div>
            </div>
          )}

          {tab === 'physical' && (
            <div role="tabpanel" aria-label="实物商品绑定" className="space-y-3">
              <h3 className="font-semibold">抽奖奖品与现有商品库存</h3>
              {!config?.integrationReady && <Notice tone="warn">正式券中心尚未连接，当前不能核销小程序正式奖品。</Notice>}
              {config?.mode === 'remote' && !config.physicalSupported && <Notice tone="warn">券服务器尚未支持实物兑奖。</Notice>}
              {prizeOptions.map(([id, name, code, names]) => {
                const matches = products.filter((p) => code ? [p.sku, p.barcode].some((value) => String(value || '').trim() === code) : (names || [name]).includes(String(p.name || '').trim()));
                const saved = bindings.prizes[id]?.product;
                const matchesSaved = saved && matches.length === 1 && ['id', 'name', 'sku', 'barcode'].every((field) => (saved[field] || '') === (matches[0][field] || ''));
                return (
                  <div className="glass flex items-center justify-between gap-4 px-4 py-3" key={id}>
                    <div>
                      <strong className="text-sm">{name} · {code || '按完整名称匹配'}</strong>
                      <p className="text-xs text-mist">{matches.length === 1 ? `${matches[0].name} · 库存 ${matches[0].stock}` : matches.length ? '匹配到多个商品，请修正重复编码或名称' : '未找到商品，请先维护商品资料'}</p>
                      <p className={`text-xs ${saved && !matchesSaved ? 'text-red-300' : 'text-mist/70'}`}>{saved ? (matchesSaved ? `已绑定：${saved.name}` : '原绑定商品已变更，待重新核对') : '尚未绑定'}</p>
                    </div>
                  </div>
                );
              })}
              <button className="btn-primary" disabled={busy || loading || pending.length > 0} onClick={() => run(() => request('bind-physical-products', { products }), setBindings)}>
                <Check size={16} /> 确认四种奖品商品绑定
              </button>
              {pending.length > 0 && <Notice tone="warn">存在未完成领取，暂不能修改商品绑定。</Notice>}
            </div>
          )}

          {tab === 'integration' && (
            <div role="tabpanel" aria-label="小程序接入" className="space-y-5">
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="font-semibold">抽奖后台凭证</h3>
                  <button className="btn-ghost text-sm" disabled={busy || !campaigns.length} onClick={() => setEditor({ type: 'key' })}><KeyRound size={15} /> 新建接入凭证</button>
                </div>
                <div className="space-y-2">
                  {keys.filter((k) => k.role === 'lottery').map((k) => (
                    <div className="glass flex items-center justify-between gap-4 px-4 py-3" key={k.id}>
                      <div>
                        <strong className="text-sm">{k.name}</strong>
                        <p className="text-xs text-mist">{campaigns.find((c) => c.id === k.campaignId)?.name} · {k.enabled ? '有效' : '已停用'}</p>
                      </div>
                      <button className="btn-icon !h-9 !w-9 hover:!border-red-400/50 hover:!text-red-300" title="停用凭证" aria-label={`停用${k.name}`} disabled={busy || !k.enabled} onClick={() => { if (window.confirm('停用后，此凭证将无法发券和查询。确认停用？')) run(() => mutation('revoke-key', { id: k.id })); }}>
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))}
                </div>
                <dl className="glass mt-3 space-y-1.5 px-4 py-3 text-xs">
                  <div className="flex justify-between"><dt className="text-mist">服务地址</dt><dd>{config?.baseUrl || '未配置线上地址'}</dd></div>
                  <div className="flex justify-between"><dt className="text-mist">发券接口</dt><dd><code className="font-mono">POST /v1/coupons/issue</code></dd></div>
                  <div className="flex justify-between"><dt className="text-mist">用户券列表</dt><dd><code className="font-mono">GET /v1/coupons?owner=用户标识</code></dd></div>
                  <div className="flex justify-between"><dt className="text-mist">接口版本</dt><dd>v1 · 仅限后台凭证调用</dd></div>
                </dl>
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="font-semibold">收银占用 / 待同步</h3>
                  <button className="btn-ghost text-sm" disabled={busy} onClick={() => run(() => request('sync'), setPending)}><RefreshCw size={15} /> 核对券状态</button>
                </div>
                {pending.length ? (
                  <div className="space-y-2">{pending.map((row) => <PendingRow key={row.id} row={row} busy={busy} onRelease={() => run(() => request('release', { id: row.id }))} />)}</div>
                ) : (
                  <p className="py-6 text-center text-sm text-mist">暂无待处理券</p>
                )}
              </div>
            </div>
          )}
        </>
      )}

      <AnimatePresence>
        {editor && (
          <Modal
            title={{ campaign: '创建券活动', issue: '发券', key: '新建接入凭证', connect: '云端连接', quota: '增加发放上限', deadline: '缩短兑奖截止' }[editor.type]}
            onClose={() => !busy && setEditor(null)}
            footer={
              <>
                {message && <p className="mb-2 text-sm text-red-300" role="alert">{message}</p>}
                <button className="btn-primary w-full" form="coupon-editor" disabled={busy}>
                  <Check size={16} /> {busy ? '正在处理' : editor.type === 'connect' ? '验证并连接' : editor.type === 'issue' ? '确认发券' : '保存'}
                </button>
              </>
            }
          >
            <form id="coupon-editor" className="grid grid-cols-2 gap-4" onSubmit={submit}>
              <fieldset disabled={busy} className="contents">
                {editor.type === 'campaign' && (
                  <>
                    <label className="col-span-2 block"><span className="field-label">券名称</span><input className="field" name="name" maxLength={60} required autoFocus /></label>
                    <label className="block">
                      <span className="field-label">奖品类型</span>
                      <select className="field" name="kind" value={editor.kind || 'cash'} onChange={(e) => setEditor({ ...editor, kind: e.target.value })}>
                        <option value="cash">购物抵扣券</option>
                        <option value="physical">实物奖品</option>
                      </select>
                    </label>
                    {editor.kind === 'physical' ? (
                      <label className="block"><span className="field-label">对应奖品</span>
                        <select className="field" name="prizeId">{prizeOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
                      </label>
                    ) : (
                      <>
                        <label className="block"><span className="field-label">面额（元）</span><input className="field" name="amount" type="number" min="0.01" max="10000" step="0.01" required /></label>
                        <label className="block"><span className="field-label">使用门槛（元）</span><input className="field" name="minimum" type="number" min="0" step="0.01" defaultValue="0" required /></label>
                      </>
                    )}
                    <label className="col-span-2 block"><span className="field-label">发放上限（张）</span><input className="field" name="quota" type="number" min="1" max="1000000" step="1" required defaultValue="100" /></label>
                    <label className="block"><span className="field-label">生效时间</span><input className="field" name="startsAt" type="datetime-local" defaultValue={localDate(Date.now())} required /></label>
                    <label className="block"><span className="field-label">到期时间</span><input className="field" name="expiresAt" type="datetime-local" defaultValue={localDate(Date.now() + 30 * 86400000)} required /></label>
                  </>
                )}
                {editor.type === 'quota' && (
                  <>
                    <p className="col-span-2 text-sm text-mist">{editor.campaign.name} · 当前上限 {editor.campaign.quota} 张（已发 {editor.campaign.issued} 张）· 只能上调，不能减少已承诺的奖品</p>
                    <label className="col-span-2 block"><span className="field-label">新发放上限（张）</span><input className="field" name="quota" type="number" min={editor.campaign.issued + 1} step="1" required autoFocus /></label>
                    <label className="col-span-2 block"><span className="field-label">调整原因</span><input className="field" name="reason" maxLength={200} required placeholder="例如：追加活动预算 50 张" /></label>
                  </>
                )}
                {editor.type === 'deadline' && (
                  <>
                    <p className="col-span-2 text-sm text-mist">{editor.campaign.name} · 当前兑奖截止 {date(expiry(editor.campaign))} · 只能缩短，不能延长原有效期</p>
                    <label className="col-span-2 block"><span className="field-label">新兑奖截止时间</span><input className="field" name="deadline" type="datetime-local" min={localDate(Date.now())} max={localDate(expiry(editor.campaign))} required autoFocus /></label>
                    <label className="col-span-2 block"><span className="field-label">调整原因</span><input className="field" name="reason" maxLength={200} required placeholder="例如：活动提前结束" /></label>
                  </>
                )}
                {editor.type === 'issue' && (
                  <>
                    <p className="col-span-2 text-sm text-mist">{editor.campaign.name} · {money(editor.campaign.amountCents)}</p>
                    <label className="col-span-2 block"><span className="field-label">领取人标识</span><input className="field" name="owner" maxLength={120} required autoFocus /></label>
                    <label className="col-span-2 block"><span className="field-label">发放记录号</span><input className="field" name="awardId" maxLength={120} required defaultValue={editor.awardId} /></label>
                  </>
                )}
                {editor.type === 'key' && (
                  <>
                    <label className="col-span-2 block"><span className="field-label">凭证名称</span><input className="field" name="name" maxLength={60} required autoFocus /></label>
                    <label className="col-span-2 block"><span className="field-label">授权活动</span>
                      <select className="field" name="campaignId" required>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                    </label>
                  </>
                )}
                {editor.type === 'connect' && (
                  <>
                    <label className="col-span-2 block"><span className="field-label">券服务 HTTPS 地址</span><input className="field" name="baseUrl" type="url" placeholder="https://coupons.example.com" defaultValue={config?.baseUrl || ''} required autoFocus /></label>
                    <label className="col-span-2 block"><span className="field-label">管理密钥</span><input className="field" name="adminToken" type="password" minLength={32} maxLength={300} autoComplete="off" required /></label>
                  </>
                )}
              </fieldset>
            </form>
          </Modal>
        )}
        {detail && (
          <Modal title={detail.name} onClose={() => setDetail(null)}>
            <div className="space-y-4 text-center">
              <strong className="block text-3xl text-coral-soft">{detail.kind === 'physical' ? '实物奖品 · 免费 1 件' : money(detail.amountCents)}</strong>
              <Badge tone={badgeTone[detail.state]}>{labels[detail.state]}</Badge>
              {detail.environment !== 'production' && <Notice tone="warn">联调券 · 非正式营业券</Notice>}
              {detail.state === 'AVAILABLE' && isAwardBarcode(detail.code) && <CouponBarcode code={detail.code} />}
              {detail.state === 'AVAILABLE' && detail.code && !isAwardBarcode(detail.code) && qr && <img className="mx-auto rounded-xl bg-[#fff] p-2" src={qr} alt="优惠券核销二维码" />}
              <dl className="space-y-1.5 text-left text-sm">
                <div className="flex justify-between"><dt className="text-mist">领取人</dt><dd>{detail.owner}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-mist">券编号</dt><dd className="truncate font-mono text-xs">{detail.id}</dd></div>
                <div className="flex justify-between"><dt className="text-mist">有效期至</dt><dd>{date(expiry(detail))}</dd></div>
                {detail.reservation?.orderNo && <div className="flex justify-between"><dt className="text-mist">关联订单</dt><dd>{detail.reservation.orderNo}</dd></div>}
                {detail.paymentReference && <div className="flex justify-between"><dt className="text-mist">支付编号</dt><dd>{detail.paymentReference}</dd></div>}
              </dl>
              {detail.state === 'AVAILABLE' && detail.code && (
                <button className="btn-ghost w-full" onClick={() => copy(detail.code)}><Copy size={16} /> 复制券码</button>
              )}
            </div>
          </Modal>
        )}
        {secret && (
          <Modal title="接入凭证已生成" onClose={() => setSecret(null)}>
            <div className="space-y-3">
              <Notice tone="warn">仅供抽奖后台使用，不可放入小程序前端或公开分享。</Notice>
              <textarea readOnly aria-label="抽奖后台接入密钥" rows={4} value={secret.token} className="field font-mono text-xs" />
              <div className="flex gap-2">
                <button className="btn-ghost flex-1" onClick={() => copy(secret.token)}><Copy size={15} /> 复制</button>
                <button className="btn-ghost flex-1" onClick={() => downloadJson({ baseUrl: config?.baseUrl || null, environment: config?.environment, campaignId: secret.campaignId, token: secret.token }, '抽奖后台接入凭证.json')}>
                  <Download size={15} /> 下载凭证
                </button>
              </div>
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </PageShell>
  );
}

function Notice({ tone = 'info', onClose, children }) {
  const tones = {
    info: 'border-coral/30 bg-coral/[0.08] text-coral-soft',
    warn: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
    danger: 'border-red-400/30 bg-red-400/10 text-red-300',
  };
  return (
    <div className={`mb-4 flex items-center justify-between gap-3 rounded-xl border px-4 py-2.5 text-sm ${tones[tone]}`} role="status">
      <span>{children}</span>
      {onClose && <button className="btn-icon !h-7 !w-7 !border-0" aria-label="关闭券提示" onClick={onClose}>×</button>}
    </div>
  );
}

function PendingRow({ row, busy, onRelease }) {
  return (
    <div className="glass flex items-center justify-between gap-4 px-4 py-3">
      <div>
        <strong className="text-sm">{row.coupon?.name || '抽奖奖品'}</strong>
        <p className="text-xs text-mist">{labels[row.coupon?.state] || '待核对'} · {row.error || row.orderId || row.id}</p>
      </div>
      {row.canRelease === true ? (
        <button className="btn-ghost !min-h-[38px] !px-3 !py-1.5 text-sm" disabled={busy} onClick={onRelease}>释放并重新扫码</button>
      ) : (
        <span className="text-xs text-mist">请在收银台继续核对</span>
      )}
    </div>
  );
}
