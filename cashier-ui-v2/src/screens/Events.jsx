import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from '../lib/motion.js';
import {
  Camera, Check, ChevronDown, ChevronUp, CircleAlert, Copy, Download, PackagePlus, Pause, Pencil, Play, Plus,
  RefreshCw, ScanLine, Sparkles, Trash2, Wand2,
} from 'lucide-react';
import { sqbCall } from '../api/sqb.js';
import { Badge, EmptyState, Modal, PageShell, spring } from '../components/ui.jsx';
import { ScannerModal } from '../modals/ScannerModal.jsx';
import { ActivityBridgeModal } from '../modals/ActivityBridgeModal.jsx';
import { downloadBlob, todayKey } from '../lib/format.js';
import { canBePromoGift } from '../logic/cartLogic.js';

const call = (action, payload = {}) => sqbCall(`activity-${action}`, payload);

// 参与页由活动后端按活动 id 提供；复制链接分发给参与者，也可做成小程序太阳码。
const H5_ORIGIN = 'https://bubble.moody-vip.com';
const h5Link = (id) => `${H5_ORIGIN}/huodong-${encodeURIComponent(id)}/?a=${encodeURIComponent(id)}`;

const timeText = (value) => (value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—');
const normalizeCode = (value) => String(value ?? '').replace(/\s+/g, '').toUpperCase();
const toLocalInput = (value) => {
  const time = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

const STATE_META = {
  draft: { label: '草稿', tone: 'neutral' },
  active: { label: '进行中', tone: 'ok' },
  paused: { label: '已暂停', tone: 'warn' },
  ended: { label: '已结束', tone: 'danger' },
};
const stateMeta = (state) => STATE_META[state] || { label: state || '未知', tone: 'neutral' };

const enumTone = (value) => {
  const text = String(value ?? '');
  if (/已核销|已使用|已完成|成功|redeemed|done|ok/i.test(text)) return 'ok';
  if (/待|pending|未核销|未使用/i.test(text)) return 'coral';
  if (/过期|失效|失败|不可用|取消|expired|failed|unavailable/i.test(text)) return 'danger';
  return 'neutral';
};

const STATUS_ZH = {
  pending: '待核销', redeemed: '已核销', expired: '已过期', voided: '已作废',
  none: '未中奖', using: '使用中', issuing: '发券中', unavailable: '待同步', not_started: '未开始',
};
// Records may carry structured values (e.g. prize as {id,name,kind}); render
// their display name instead of "[object Object]".
const displayValue = (value) => {
  if (value && typeof value === 'object') return value.name || value.label || value.title || JSON.stringify(value);
  const text = String(value ?? '');
  return STATUS_ZH[text] || text;
};

function renderField(field, value) {
  if (value === null || value === undefined || value === '') return <span className="text-mist/50">—</span>;
  if (field.type === 'code') return <code className="font-mono text-xs text-coral-soft">{String(value)}</code>;
  if (field.type === 'timestamp') return <time className="text-xs text-mist">{timeText(value)}</time>;
  if (field.type === 'enum') return <Badge tone={enumTone(value)}>{displayValue(value)}</Badge>;
  return <span>{displayValue(value)}</span>;
}

// Local equivalent of the old manifest display.recordFields: activity-records
// rows are flat objects with these keys.
const RECORD_FIELDS = [
  { key: 'code', label: '核销码', type: 'code' },
  { key: 'prize', label: '奖品', type: 'text' },
  { key: 'status', label: '状态', type: 'enum' },
  // 参与者身份说明：H5 只做微信登录，没有采集手机号；完整 openid 是管理端
  // 定位某个人的唯一标识（点击可复制）。
  { key: 'openid', label: '参与者（微信 ID）', type: 'text' },
  { key: 'createdAt', label: '参与时间', type: 'timestamp' },
  { key: 'redeemedAt', label: '核销时间', type: 'timestamp' },
];
// Lookup returns a single entry (prize object + winner), not a records row.
const ENTRY_FIELDS = [
  { key: 'prize', label: '奖品', type: 'text' },
  { key: 'status', label: '状态', type: 'enum' },
  { key: 'code', label: '核销码', type: 'code' },
  { key: 'winner', label: '中奖人', type: 'text' },
  { key: 'createdAt', label: '抽奖时间', type: 'timestamp' },
  { key: 'redeemedAt', label: '核销时间', type: 'timestamp' },
];
const SUMMARY_LABELS = {
  entries: '参与', pending: '待核销', redeemed: '已核销', expired: '已过期',
  noPrize: '未中奖', stockTotal: '总名额', stockRemaining: '剩余名额', couponIssuesPending: '发券中',
};

function entryPairs(entry, fields) {
  if (!entry || typeof entry !== 'object') return [];
  return (fields || []).map((field) => [field, entry[field.key]]);
}

function prizeKindBadge(prize, checkoutCoupon) {
  const kind = prize?.kind || (checkoutCoupon ? 'cash' : '');
  if (!kind) return null;
  // Convention: prize.amount is in YUAN (coupon center multiplies by 100);
  // amountCents, when present, is already cents.
  const cents = Number.isFinite(prize?.amountCents) ? prize.amountCents
    : (Number.isFinite(Number(prize?.amount)) ? Math.round(Number(prize.amount) * 100) : null);
  const amount = kind === 'cash' && cents ? ` ¥${(cents / 100).toFixed(2)}` : '';
  return <Badge tone={kind === 'cash' ? 'coral' : 'ok'}>{kind === 'cash' ? '现金券' : '实物'}{amount}</Badge>;
}

// Count fields are not pinned by the contract; read the common shapes.
const countOf = (activity, keys) => {
  for (const source of [activity?.counts, activity?.stats, activity]) {
    for (const key of keys) if (Number.isFinite(source?.[key])) return source[key];
  }
  return null;
};
const entryCount = (activity) => countOf(activity, ['entries', 'participants', 'total']);
const redeemCount = (activity) => countOf(activity, ['redeemed', 'redeemedCount']);

const emptyPrize = () => ({ id: '', kind: 'physical', campaignId: '', productId: '', qty: '', weight: 1, imageUrl: '' });

// Live thumbnail for the prize image link input; mirrors ProductImage's
// img + onError fallback pattern.
function PrizeThumb({ url }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [url]);
  if (url && !failed) {
    return <img className="h-10 w-10 shrink-0 rounded-xl border border-white/10 object-cover" src={url} alt="奖品图片预览" onError={() => setFailed(true)} />;
  }
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/[0.07] bg-white/[0.05] text-mist/50" aria-hidden="true">
      <PackagePlus size={16} />
    </div>
  );
}

function emptyDraft() {
  return {
    id: '', title: '', appid: '', secret: '', hasSecret: false, venue: '', staffKey: '',
    startsAt: toLocalInput(Date.now()), endsAt: toLocalInput(Date.now() + 7 * 86400000),
    prizes: [emptyPrize()],
    redeemEndsAt: '', rulesText: '', cashTerms: '', requireInvite: false,
  };
}

// Reads the backend adminView shape: wx.{appid,secretSet} nested, prize
// probability/quantity plus the admin-only pool references (couponCampaignId
// for cash, product for physical) that the editor reads back.
function draftFrom(activity) {
  const prizes = Array.isArray(activity.prizes) && activity.prizes.length ? activity.prizes : [null];
  return {
    id: activity.id,
    title: activity.title || activity.name || '',
    appid: activity.wx?.appid || activity.appid || '',
    secret: '',
    hasSecret: Boolean(activity.wx?.secretSet ?? activity.hasSecret ?? activity.secretConfigured),
    venue: activity.venue || activity.branding?.venue || '',
    staffKey: activity.staffKey || '',
    startsAt: toLocalInput(activity.startsAt),
    endsAt: toLocalInput(activity.endsAt),
    prizes: prizes.map((prize) => {
      if (!prize) return emptyPrize();
      const qty = Number.isFinite(prize.quantity) ? prize.quantity : prize.qty;
      return {
        id: prize.id || '',
        kind: prize.kind === 'cash' ? 'cash' : 'physical',
        campaignId: prize.couponCampaignId || '',
        productId: prize.product?.id || '',
        imageUrl: prize.imageUrl || '',
        weight: prize.probability ?? prize.weight ?? 1,
        qty: Number.isSafeInteger(qty) && qty > 0 ? qty : '',
      };
    }),
    redeemEndsAt: toLocalInput(activity.redeemEndsAt ?? activity.rules?.redeemEndsAt),
    rulesText: activity.rulesText || activity.rules?.rulesText || '',
    cashTerms: activity.cashTerms || activity.rules?.cashTerms || '',
    requireInvite: !!activity.requireInvite,
  };
}

// Throws Error(中文提示) on the first validation problem; returns
// { config: <activity config> } — secret rides inside config.wx and only when
// the user typed one. Prize ids are stable: existing rows keep theirs, new
// rows get a random one (stock reconciles by id on the backend). Prizes are
// pool references: cash → couponCampaignId, physical → product.id; the server
// copies name/amount/etc. from the pool, so nothing term-like is sent here.
function buildPayload(draft) {
  const title = String(draft.title || '').trim();
  if (!title) throw new Error('请填写活动标题');
  const startsAt = Date.parse(draft.startsAt);
  const endsAt = Date.parse(draft.endsAt);
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) throw new Error('请选择活动的开始与结束时间');
  if (endsAt <= startsAt) throw new Error('结束时间必须晚于开始时间');
  const appid = String(draft.appid || '').trim();
  if (!appid) throw new Error('请填写小程序 AppID');
  if (!draft.prizes.length) throw new Error('请至少添加一个奖品');
  const usedIds = new Set();
  const prizes = draft.prizes.map((prize, index) => {
    const where = `第 ${index + 1} 个奖品`;
    const weight = Math.round(Number(prize.weight) * 100) / 100;
    if (!Number.isFinite(weight) || weight < 0.01) throw new Error(`${where}的权重必须是 ≥0.01 的数字（最多两位小数）`);
    const kind = ['cash', 'physical', 'none'].includes(prize.kind) ? prize.kind : 'physical';
    const qty = Number(prize.qty);
    if (kind !== 'none' && (!Number.isSafeInteger(qty) || qty <= 0)) throw new Error(`请填写${where}的数量（正整数）`);
    let id = String(prize.id || '').trim();
    if (!id) id = `p-${Math.random().toString(36).slice(2, 10)}`;
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new Error(`${where}的 id 格式不正确`);
    if (usedIds.has(id)) throw new Error(`奖品 id 重复：${id}`);
    usedIds.add(id);
    const imageUrl = String(prize.imageUrl || '').trim();
    if (imageUrl.length > 200000) throw new Error(`${where}的图片链接过长`);
    if (imageUrl && !/^(https?:\/\/|data:image\/)/.test(imageUrl)) throw new Error(`${where}的图片链接须以 http://、https:// 或 data:image/ 开头`);
    // 谢谢惠顾格没有数量与图片的概念：不扣库存，只按权重参与抽取。
    const row = { id, kind, qty: kind === 'none' ? 1 : qty, probability: weight };
    if (imageUrl && kind !== 'none') row.imageUrl = imageUrl;
    if (kind === 'cash') {
      const campaignId = String(prize.campaignId || '').trim();
      if (!campaignId) throw new Error(`请为${where}选择现金券活动`);
      row.couponCampaignId = campaignId;
    } else if (kind === 'physical') {
      const productId = String(prize.productId || '').trim();
      if (!productId) throw new Error(`请为${where}选择赠品商品`);
      row.product = { id: productId };
    }
    return row;
  });
  const config = {
    name: title, title,
    venue: String(draft.venue || '').trim(),
    rulesText: String(draft.rulesText || '').trim(),
    cashTerms: String(draft.cashTerms || '').trim(),
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(endsAt).toISOString(),
    prizes,
    wx: { appid },
    requireInvite: !!draft.requireInvite,
  };
  const redeemEnds = String(draft.redeemEndsAt || '').trim();
  if (redeemEnds) {
    const redeemEndsAt = Date.parse(redeemEnds);
    if (!Number.isFinite(redeemEndsAt)) throw new Error('核销截止时间无效');
    config.redeemEndsAt = new Date(redeemEndsAt).toISOString();
  }
  const secret = String(draft.secret || '').trim();
  if (secret) config.wx.secret = secret;
  const staffKey = String(draft.staffKey || '').trim();
  if (staffKey) {
    if (staffKey.length < 8 || staffKey.length > 128) throw new Error('工作人员密钥须为 8–128 个字符');
    config.staffKey = staffKey;
  }
  return { config };
}

// 现金券活动的下拉文案：面额、门槛与剩余可发数量一目了然。
const campaignOptionText = (c) => `${c.name} · ¥${(c.amountCents / 100).toFixed(2)}${c.minimumCents ? ` · 满¥${(c.minimumCents / 100).toFixed(2)}可用` : ' · 无门槛'} · 可发 ${c.quota - c.issued}`;

// Live share of one prize's weight inside the whole pool, shown next to the
// weight input so adjustments read as percentages while staying weights.
const weightShare = (prizes, prize) => {
  const value = Number(prize.weight);
  if (!Number.isFinite(value) || value <= 0) return '0.00';
  const total = prizes.reduce((sum, p) => {
    const w = Number(p.weight);
    return sum + (Number.isFinite(w) && w > 0 ? w : 0);
  }, 0);
  return total > 0 ? ((value / total) * 100).toFixed(2) : '0.00';
};

function ActivityEditor({ initial, campaigns, giftProducts, onClose, onSubmit }) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [weightHelpOpen, setWeightHelpOpen] = useState(false);
  const editing = Boolean(initial.id);
  const update = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const updatePrize = (index, field, value) => setDraft((current) => ({
    ...current,
    prizes: current.prizes.map((prize, i) => (i === index ? { ...prize, [field]: value } : prize)),
  }));

  async function submit(event) {
    event.preventDefault();
    let payload;
    try { payload = buildPayload(draft); } catch (issue) { setError(issue.message); return; }
    setSaving(true); setError('');
    try { await onSubmit(payload, editing); onClose(); }
    catch (issue) { setError(issue.message); }
    finally { setSaving(false); }
  }

  return (
    <>
      <Modal
        wide
        title={editing ? '编辑活动' : '创建活动'}
        subtitle="本地抽奖活动：配置时间、奖池与规则后，分享 H5 链接给参与者"
      onClose={() => !saving && onClose()}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          {error && <p className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-red-300" role="alert"><CircleAlert size={15} className="shrink-0" /> <span>{error}</span></p>}
          <button type="button" className="btn-ghost ml-auto" onClick={onClose} disabled={saving}>取消</button>
          <button type="submit" form="activity-form" className="btn-primary" disabled={saving}>
            <Check size={16} /> {saving ? '保存中…' : editing ? '保存修改' : '创建活动'}
          </button>
        </div>
      }
    >
      <form id="activity-form" className="grid grid-cols-2 gap-4" onSubmit={submit}>
        <label className="col-span-2 block">
          <span className="field-label">活动标题</span>
          <input className="field" value={draft.title} maxLength={60} autoComplete="off" onChange={(e) => update('title', e.target.value)} placeholder="例如 此刻在地 · 赛场同行" />
        </label>
        <div className="col-span-2 flex items-center gap-2 text-sm text-mist">
          活动类型 <Badge tone="coral">抽奖</Badge>
        </div>
        <label className="block">
          <span className="field-label">开始时间</span>
          <input className="field" type="datetime-local" value={draft.startsAt} onChange={(e) => update('startsAt', e.target.value)} />
        </label>
        <label className="block">
          <span className="field-label">结束时间</span>
          <input className="field" type="datetime-local" value={draft.endsAt} onChange={(e) => update('endsAt', e.target.value)} />
        </label>
        <label className="block">
          <span className="field-label">小程序 AppID</span>
          <input className="field" value={draft.appid} maxLength={64} autoComplete="off" spellCheck="false" onChange={(e) => update('appid', e.target.value)} placeholder="wx 开头的微信小程序 AppID" />
        </label>
        <label className="block">
          <span className="field-label">微信 Secret</span>
          <input
            className="field"
            type="password"
            value={draft.secret}
            maxLength={128}
            autoComplete="new-password"
            onChange={(e) => update('secret', e.target.value)}
            placeholder={editing ? (draft.hasSecret ? '已配置 · 输入新密钥以更换' : '未配置') : '用于校验微信登录，可稍后配置'}
          />
        </label>
        <label className="block">
          <span className="field-label">工作人员密钥（H5 核销模式用，8–128 位）</span>
          <input
            className="field font-mono"
            value={draft.staffKey}
            maxLength={128}
            autoComplete="off"
            spellCheck="false"
            onChange={(e) => update('staffKey', e.target.value)}
            placeholder={editing ? '留空则保持原有密钥' : '例如 8 位以上随机字符串；留空则关闭 H5 核销模式'}
          />
        </label>
        <label className="block">
          <span className="field-label">领奖地点（展示在 H5 页面）</span>
          <input className="field" value={draft.venue} maxLength={80} onChange={(e) => update('venue', e.target.value)} placeholder="例如 赛事现场 · Bubble 展位" />
        </label>

        <div className="col-span-2">
          <div className="mb-2 flex items-center justify-between">
            <span className="field-label !mb-0 flex items-center gap-1.5">
              奖池 · 按权重随机抽取
              <button type="button" className="btn-icon !h-6 !w-6 align-middle" aria-label="权重说明" title="权重与中奖率怎么算" onClick={() => setWeightHelpOpen(true)}>
                <CircleAlert size={14} />
              </button>
            </span>
            <button type="button" className="btn-ghost !min-h-[34px] !px-3 !py-1 text-xs" onClick={() => setDraft((c) => ({ ...c, prizes: [...c.prizes, emptyPrize()] }))}>
              <Plus size={13} /> 添加奖品
            </button>
          </div>
          <div className="space-y-2.5">
            {draft.prizes.map((prize, index) => {
              const cashPoolEmpty = campaigns !== null && campaigns.length === 0;
              const giftPoolEmpty = giftProducts.length === 0;
              return (
              <div key={index} className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-3">
                <div className="flex items-center gap-2">
                  <select className="field !w-28 shrink-0" value={prize.kind} aria-label={`奖品${index + 1}类型`} onChange={(e) => updatePrize(index, 'kind', e.target.value)}>
                    <option value="physical">实物</option>
                    <option value="cash">现金券</option>
                    <option value="none">谢谢惠顾</option>
                  </select>
                  {prize.kind === 'none' ? (
                    <p className="min-w-0 flex-1 self-center text-xs leading-5 text-mist">未中奖格：不扣库存、无需选择来源，按权重参与抽取（与奖品同权重即 50% 中奖率）</p>
                  ) : prize.kind === 'cash' ? (
                    <select
                      className="field min-w-0 flex-1"
                      value={prize.campaignId}
                      disabled={campaigns === null || cashPoolEmpty}
                      aria-label={`奖品${index + 1}现金券活动`}
                      onChange={(e) => updatePrize(index, 'campaignId', e.target.value)}
                    >
                      <option value="">{campaigns === null ? '正在加载券活动…' : '选择现金券活动'}</option>
                      {(campaigns || []).map((c) => (
                        <option key={c.id} value={c.id} disabled={!c.enabled || c.quota - c.issued <= 0}>{campaignOptionText(c)}</option>
                      ))}
                    </select>
                  ) : (
                    <select
                      className="field min-w-0 flex-1"
                      value={prize.productId}
                      disabled={giftPoolEmpty}
                      aria-label={`奖品${index + 1}赠品商品`}
                      onChange={(e) => {
                        const productId = e.target.value;
                        const product = giftProducts.find((p) => p.id === productId);
                        updatePrize(index, 'productId', productId);
                        if (product?.imageUrl) updatePrize(index, 'imageUrl', product.imageUrl);
                      }}
                    >
                      <option value="">{giftPoolEmpty ? '赠品池为空' : '选择赠品商品'}</option>
                      {giftProducts.map((p) => (
                        <option key={p.id} value={p.id}>{`${p.name}${p.sku ? ` · ${p.sku}` : ''}${p.productType === 'sale' ? '（可售可赠）' : ''}`}</option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    className="btn-icon !h-10 !w-10 shrink-0 hover:!border-red-400/50 hover:!text-red-300"
                    aria-label={`删除奖品${index + 1}`}
                    disabled={draft.prizes.length <= 1}
                    onClick={() => setDraft((c) => ({ ...c, prizes: c.prizes.filter((_, i) => i !== index) }))}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                {prize.kind === 'cash' && cashPoolEmpty && (
                  <p className="mt-1.5 text-xs text-mist">券池为空：请先在「优惠券」页创建现金券活动</p>
                )}
                {prize.kind === 'physical' && giftPoolEmpty && (
                  <p className="mt-1.5 text-xs text-mist">赠品池为空：请先在「商品」页添加赠品，或将售卖品勾选“可参与买赠”</p>
                )}
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  {prize.kind !== 'none' && (
                    <label className="block w-24 shrink-0">
                      <span className="field-label">数量</span>
                      <input className="field" type="number" min="1" step="1" value={prize.qty} onChange={(e) => updatePrize(index, 'qty', e.target.value)} placeholder="100" />
                    </label>
                  )}
                  <label className="block w-24 shrink-0">
                    <span className="field-label">权重</span>
                    <input className="field" type="number" min="0.01" step="0.01" value={prize.weight} onChange={(e) => updatePrize(index, 'weight', e.target.value)} />
                  </label>
                  <span className="pb-2.5 text-xs text-mist" title="该奖品在全部奖品权重中的占比">
                    ≈ {weightShare(draft.prizes, prize)}%
                  </span>
                  {prize.kind !== 'none' && (
                    <>
                      <label className="block min-w-0 flex-1">
                        <span className="field-label">图片链接</span>
                        <input
                          className="field"
                          value={prize.imageUrl}
                          spellCheck="false"
                          onChange={(e) => updatePrize(index, 'imageUrl', e.target.value)}
                          placeholder="可填图片网址或直接粘贴 data 图片；留空则券显示面额图案"
                        />
                      </label>
                      <PrizeThumb url={prize.imageUrl} />
                    </>
                  )}
                </div>
              </div>
              );
            })}
          </div>
        </div>

        <div className="col-span-2 grid grid-cols-2 gap-4 rounded-xl border border-white/[0.07] bg-white/[0.03] p-4">
          <span className="field-label col-span-2 !mb-0">活动规则</span>
          <p className="col-span-2 -mb-1 text-xs text-mist">每位微信用户限抽 1 次；按奖池权重抽取（含谢谢惠顾格时不保证中奖），名额抽完即止。</p>
          <label className="col-span-2 flex cursor-pointer items-start gap-2">
            <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[#ff652e]" checked={draft.requireInvite} onChange={(e) => update('requireInvite', e.target.checked)} />
            <span className="text-sm leading-5 text-fog">
              需要工作人员参与码（现场工作人员在 H5「工作台」确认参与后生成一次性参与码，顾客凭码获得抽奖机会；适合关注打卡类活动）
            </span>
          </label>
          <label className="col-span-2 block">
            <span className="field-label">核销截止时间（可留空，默认同活动结束时间）</span>
            <input className="field" type="datetime-local" value={draft.redeemEndsAt} onChange={(e) => update('redeemEndsAt', e.target.value)} />
          </label>
          <label className="col-span-2 block">
            <span className="field-label">活动说明（展示在 H5 规则页，可留空）</span>
            <textarea className="field" rows={3} maxLength={5000} value={draft.rulesText} onChange={(e) => update('rulesText', e.target.value)} placeholder="例如 参与方式、领取方式与注意事项" />
          </label>
          <label className="col-span-2 block">
            <span className="field-label">现金券使用说明（可留空）</span>
            <textarea className="field" rows={2} maxLength={2000} value={draft.cashTerms} onChange={(e) => update('cashTerms', e.target.value)} placeholder="例如 立减金每单限用一张，不找零、不留余额" />
          </label>
        </div>
      </form>
      </Modal>
      {weightHelpOpen && (
        <Modal title="权重与中奖率怎么算" onClose={() => setWeightHelpOpen(false)}>
          <div className="space-y-3 text-sm leading-6 text-fog">
            <p><strong className="text-milk">权重是相对比例，不需要凑成 100。</strong>每个奖品格（包括「谢谢惠顾」）都按自己的权重占总权重的比例分配中奖几率。</p>
            <p>单个奖品中奖率 = 该奖品权重 ÷ 全部格子权重之和。<br />例：10元券权重 43、5元券权重 20 → 10元券的中奖几率是 5元券的 2.15 倍（43 ÷ 20）。</p>
            <p>H5 上显示的「中奖概率」= 所有真实奖品权重和 ÷ 总权重。不添加「谢谢惠顾」格时就是 100%，人人中奖；加一个与奖品同权重的谢谢格，中奖率立刻减半。</p>
            <p>权重支持两位小数，最小 0.01。每个奖品行右侧实时显示它当前的占比，调整时会跟着变化。</p>
            <p>库存为 0 的奖品会自动从奖池下架，剩余奖品按原权重重新分配，实际中奖率会升高；现金券还受券活动发放上限约束，发完的券同样自动下架。</p>
            <p>权重修改立即影响之后的每一次抽取；已经中奖的记录不受影响。</p>
          </div>
        </Modal>
      )}
    </>
  );
}

export function EventsScreen({ isAdmin, flash, products = [] }) {
  const [activities, setActivities] = useState(null);
  const [selectedId, setSelectedId] = useState('');
  const [records, setRecords] = useState(null);
  const [recordsPage, setRecordsPage] = useState(1);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editor, setEditor] = useState(null);
  const [campaigns, setCampaigns] = useState(null);
  const [code, setCode] = useState('');
  const [found, setFound] = useState(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [bridge, setBridge] = useState(null);
  const alive = useRef(true);
  const working = useRef(false);
  const generation = useRef(0);
  const detailGeneration = useRef(0);
  const giftProducts = products.filter(canBePromoGift);

  // 编辑器打开时拉取一次券池（仅管理员可编辑）；失败时降级为空池提示。
  async function openEditor(draft) {
    setEditor(draft);
    if (!isAdmin) return;
    try {
      const result = await sqbCall('coupon-campaigns');
      if (!alive.current) return;
      const list = Array.isArray(result) ? result : result?.campaigns || [];
      setCampaigns(list.filter((c) => c.kind === 'cash'));
    } catch {
      if (alive.current) setCampaigns([]);
    }
  }

  async function load() {
    const current = ++generation.current;
    setLoading(true); setError('');
    try {
      const result = await call('list');
      if (!alive.current || current !== generation.current) return;
      const list = Array.isArray(result) ? result : result?.activities || [];
      setActivities(list);
      if (selectedId && !list.some((item) => item.id === selectedId)) {
        setSelectedId(''); setRecords(null); setFound(null);
      }
    } catch (issue) {
      if (alive.current && current === generation.current) { setError(issue.message); setActivities([]); }
    } finally {
      if (alive.current && current === generation.current) setLoading(false);
    }
  }

  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; generation.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(fn, success, refresh = false) {
    if (working.current) return;
    working.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const result = await fn();
      if (alive.current) {
        success?.(result);
        if (refresh) await load();
      }
    } catch (issue) { if (alive.current) setError(issue.message); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  }

  async function loadRecords(id, page = 1, append = false) {
    const current = ++detailGeneration.current;
    if (!append) setDetailLoading(true);
    setError('');
    try {
      const result = await call('records', { id, page });
      if (!alive.current || current !== detailGeneration.current) return;
      const list = Array.isArray(result) ? result : result?.records || [];
      const summary = Array.isArray(result) ? null : result?.summary || null;
      const hasMore = Boolean(result?.hasMore);
      setRecords((prev) => (append && prev
        ? { records: [...prev.records, ...list], summary: summary || prev.summary, hasMore }
        : { records: list, summary, hasMore }));
      setRecordsPage(page);
    } catch (issue) {
      if (alive.current && current === detailGeneration.current) { setError(issue.message); if (!append) setRecords(null); }
    } finally {
      if (alive.current && current === detailGeneration.current) setDetailLoading(false);
    }
  }

  function toggleSelect(activity) {
    setFound(null); setCode('');
    if (selectedId === activity.id) { setSelectedId(''); setRecords(null); detailGeneration.current++; return; }
    setSelectedId(activity.id); setRecords(null);
    loadRecords(activity.id);
  }

  async function submitEditor(payload, editing) {
    if (editing) await call('update', { id: editor.id, ...payload });
    else await call('create', payload);
    const text = editing ? '活动已保存' : '活动已创建';
    setMessage(text);
    flash?.(text);
    await load();
  }

  function resetActivity(activity) {
    if (!isAdmin) return;
    if (!window.confirm(`确定清空「${activity.title || activity.id}」的全部参与记录并恢复奖池到初始数量？\n所有人将可以重新抽奖；已发放的现金券不会被收回。`)) return;
    run(() => call('reset', { id: activity.id }), () => {
      setMessage('活动记录已清空，奖池已恢复');
      flash?.('活动记录已清空，奖池已恢复');
      loadRecords(activity.id);
    });
  }

  function removeRecord(activity, record) {
    if (!isAdmin) return;
    const code = record.rawCode || record.code;
    if (!code) return;
    if (record.status === 'redeemed') { window.alert('该记录已核销，为保留发放凭证不能删除。'); return; }
    if (!window.confirm(`确定删除这条参与记录？\n奖品：${record.prize}\n参与者：${record.openid}\n删除后该用户可以重新抽奖。`)) return;
    run(() => call('record-delete', { id: activity.id, code }), () => {
      setMessage('记录已删除');
      flash?.('记录已删除');
      loadRecords(activity.id);
    });
  }

  function toggleState(activity) {
    const next = activity.state === 'active' ? 'paused' : 'active';
    if (next === 'paused' && !window.confirm(`确定暂停「${activity.title || activity.id}」？暂停期间参与者无法抽奖。`)) return;    run(
      () => call('set-status', { id: activity.id, state: next }),
      () => {
        const text = next === 'active' ? '活动已启用' : '活动已暂停';
        setMessage(text); flash?.(text);
      },
      true,
    );
  }

  function exportCsv(activity) {
    run(async () => {
      const result = await call('export', { id: activity.id });
      const csv = typeof result === 'string' ? result : result?.csv;
      if (!csv) throw new Error('活动服务未返回导出内容');
      const safeTitle = String(activity.title || '活动').replace(/[\\/:*?"<>|\s]+/g, '_') || '活动';
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `活动-${safeTitle}-${todayKey()}.csv`);
    }, () => { setMessage('活动记录已导出'); flash?.('活动记录已导出'); }, false);
  }

  async function copyLink(activity) {
    const link = h5Link(activity.id);
    try {
      await navigator.clipboard.writeText(link);
      flash?.('已复制 H5 链接');
    } catch {
      setError(`复制失败，请手动复制：${link}`);
    }
  }

  function lookup(event, override) {
    event?.preventDefault();
    const value = normalizeCode(override ?? code);
    if (!/^[0-9A-F]{16}$/.test(value)) { setError('请输入或扫描 16 位十六进制核销码（可带空格）'); return; }
    setFound(null);
    run(() => call('lookup', { id: selectedId, code: value }), (entry) => setFound(entry), false);
  }

  // H5 QRs encode the bare 16-hex code; stay tolerant of URL-wrapped payloads.
  function onScan(raw) {
    const match = String(raw || '').toUpperCase().match(/[0-9A-F]{16}/);
    const value = match ? match[0] : normalizeCode(raw);
    setCode(value);
    lookup(null, value);
  }

  // USB keyboard-wedge scanners deliver the same payload as the camera
  // ScannerModal; route both through the identical normalization + lookup.
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  useEffect(() => {
    const handler = (event) => onScanRef.current(String(event.detail ?? ''));
    window.addEventListener('bubble-scan', handler);
    return () => window.removeEventListener('bubble-scan', handler);
  }, []);

  function redeem() {
    const value = normalizeCode(found?.code || code);
    if (!value || !selectedId) return;
    const prizeName = found?.prize ? displayValue(found.prize) : '';
    if (!window.confirm(`确认核销该凭证${prizeName ? `（${prizeName}）` : ''}？核销后不可重复使用。`)) return;
    run(async () => {
      try {
        return await call('redeem', { id: selectedId, code: value });
      } catch (issue) {
        if (issue?.status === 409 || issue?.code === 'ALREADY_REDEEMED') {
          flash?.('该凭证已核销，请勿重复核销');
          throw new Error('该凭证已核销，请勿重复核销');
        }
        throw issue;
      }
    }, (entry) => {
      setFound(entry || null);
      setMessage('已核销，请按活动规则发放奖品');
      flash?.('已核销');
      loadRecords(selectedId);
    }, false);
  }

  const disabled = busy || loading;
  const selected = (activities || []).find((item) => item.id === selectedId) || null;
  const foundKind = found?.prize?.kind || (found?.checkoutCoupon ? 'cash' : '');
  const redeemBlocked = Boolean(found && (foundKind === 'cash' || found?.checkoutCoupon));
  const redeemable = Boolean(found && !redeemBlocked && (!found.status || found.status === 'pending'));

  return (
    <PageShell
      kicker="Events"
      title="活动管理"
      actions={
        <>
          <button className="btn-icon" aria-label="刷新活动" title="刷新活动" disabled={disabled} onClick={load}>
            <RefreshCw size={17} className={loading ? 'animate-spin' : ''} />
          </button>
          {isAdmin && (
            <button className="btn-primary" onClick={() => openEditor(emptyDraft())} disabled={disabled}>
              <Plus size={16} /> 创建活动
            </button>
          )}
        </>
      }
    >
      <p className="mb-4 text-sm text-mist">创建并管理本地抽奖活动：配置奖池与规则、分享 H5 参与链接，并在收银台查询、核销中奖凭证。</p>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-300" role="alert">
          <CircleAlert size={17} className="shrink-0" /> <span>{error}</span>
        </div>
      )}
      {message && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-300" role="status">
          <Check size={17} className="shrink-0" /> <span>{message}</span>
        </div>
      )}

      <section aria-label="本地活动列表">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 font-bold"><Sparkles size={18} className="text-coral" /> 本地活动</h3>
          <span className="text-sm text-mist">{activities?.length ?? 0} 个活动</span>
        </div>

        {loading && !activities && <p className="py-10 text-center text-mist" role="status">正在读取活动列表…</p>}
        {activities && !activities.length && (
          <motion.div
            className="glass flex flex-col items-center gap-4 px-6 py-14 text-center"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={spring}
          >
            <motion.span animate={{ y: [0, -8, 0] }} transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}>
              <Sparkles size={36} className="text-coral" />
            </motion.span>
            <div>
              <p className="font-semibold">还没有活动</p>
              <p className="mt-1 max-w-sm text-sm text-mist">
                {isAdmin ? '创建第一场抽奖活动，配置奖池与规则后，把 H5 链接分享给参与者。' : '暂无活动，请联系管理员创建。'}
              </p>
            </div>
            {isAdmin && (
              <button type="button" className="btn-primary" onClick={() => openEditor(emptyDraft())}>
                <Plus size={16} /> 创建活动
              </button>
            )}
          </motion.div>
        )}

        <div className="space-y-3">
          {(activities || []).map((activity) => {
            const meta = stateMeta(activity.state);
            const open = selectedId === activity.id;
            const entries = entryCount(activity);
            const redeemed = redeemCount(activity);
            return (
              <motion.article
                layout
                key={activity.id}
                className="glass overflow-hidden"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={spring}
              >
                <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => toggleSelect(activity)}>
                    <span className="flex flex-wrap items-center gap-2">
                      <strong className="truncate text-[15px]">{activity.title || activity.id}</strong>
                      <Badge tone="coral">抽奖</Badge>
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                      {open ? <ChevronUp size={15} className="shrink-0 text-mist" /> : <ChevronDown size={15} className="shrink-0 text-mist" />}
                    </span>
                    <span className="mt-1 block text-xs text-mist">
                      {timeText(activity.startsAt)} ~ {timeText(activity.endsAt)} · 参与 {entries ?? '—'} · 核销 {redeemed ?? '—'}
                    </span>
                  </button>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <button type="button" className="btn-ghost !min-h-[36px] !px-3 !py-1 text-xs" onClick={() => toggleSelect(activity)}>
                      记录 {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                    </button>
                    {isAdmin && (
                      <button type="button" className="btn-ghost !min-h-[36px] !px-3 !py-1 text-xs" disabled={busy} onClick={() => openEditor(draftFrom(activity))}>
                        <Pencil size={13} /> 编辑
                      </button>
                    )}
                    {isAdmin && (
                      <button type="button" className="btn-ghost !min-h-[36px] !px-3 !py-1 text-xs" disabled={busy} onClick={() => setBridge(activity)}>
                        <Wand2 size={13} /> 接入助手
                      </button>
                    )}
                    {isAdmin && activity.state !== 'ended' && (
                      <button type="button" className="btn-ghost !min-h-[36px] !px-3 !py-1 text-xs" disabled={busy} onClick={() => toggleState(activity)}>
                        {activity.state === 'active' ? <><Pause size={13} /> 暂停</> : <><Play size={13} /> 启用</>}
                      </button>
                    )}
                    {isAdmin && (
                      <button type="button" className="btn-icon !h-10 !w-10" aria-label={`导出${activity.title || '活动'}记录`} title="导出 CSV" disabled={busy} onClick={() => exportCsv(activity)}>
                        <Download size={15} />
                      </button>
                    )}
                    <button type="button" className="btn-icon !h-10 !w-10" aria-label="复制 H5 参与链接" title="复制 H5 参与链接" disabled={busy} onClick={() => copyLink(activity)}>
                      <Copy size={15} />
                    </button>
                  </div>
                </div>

                <AnimatePresence initial={false}>
                  {open && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25 }}
                      className="overflow-hidden"
                    >
                      <div className="border-t border-white/[0.06] px-4 py-4">
                        {detailLoading && !records && <p className="py-6 text-center text-sm text-mist" role="status">正在读取活动记录…</p>}
                        {!detailLoading && !records && !error && (
                          <p className="py-4 text-center text-sm text-mist">点击右上角刷新重试读取活动记录。</p>
                        )}
                        {records && (
                          <>
                            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                              <div className="min-w-0">
                                <strong className="block text-sm">{selected?.title || activity.title || activity.id}</strong>
                                <span className="text-xs text-mist">活动 ID <code className="font-mono">{activity.id}</code></span>
                                {activity.staffKey && (
                                  <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-mist">
                                    工作人员密钥
                                    <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono">{activity.staffKey}</code>
                                    <button
                                      type="button"
                                      className="btn-ghost !min-h-[24px] !px-2 !py-0 text-[11px]"
                                      title="复制工作人员密钥"
                                      onClick={async () => {
                                        try {
                                          await navigator.clipboard.writeText(activity.staffKey);
                                          flash?.('已复制工作人员密钥');
                                        } catch {
                                          setError(`复制失败，请手动复制：${activity.staffKey}`);
                                        }
                                      }}
                                    >
                                      <Copy size={11} /> 复制
                                    </button>
                                    <span className="text-mist/60">（用于 H5 工作人员核销与接入助手提示词）</span>
                                  </span>
                                )}
                                {!activity.staffKey && activity.staffKeySet === false && isAdmin && (
                                  <span className="mt-1 block text-xs text-mist/60">未设置工作人员密钥；编辑活动时可填写，用于 H5 工作人员核销模式。</span>
                                )}
                              </div>
                              <div className="flex items-center gap-2">
                                {isAdmin && records.records.length > 0 && (
                                  <button type="button" className="btn-ghost !min-h-[38px] !px-3 !py-1.5 text-xs hover:!border-red-400/50 hover:!text-red-300" disabled={busy} onClick={() => resetActivity(activity)} title="清空全部参与记录并恢复奖池">
                                    <Trash2 size={14} /> 清空记录
                                  </button>
                                )}
                                <button type="button" className="btn-icon" aria-label="刷新活动记录" title="刷新活动记录" disabled={busy || detailLoading} onClick={() => loadRecords(activity.id)}>
                                  <RefreshCw size={16} className={detailLoading ? 'animate-spin' : ''} />
                                </button>
                              </div>
                            </div>

                            <div className="mb-4 rounded-xl border border-white/[0.06] bg-white/[0.03] p-4">
                              <form className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end" onSubmit={lookup}>
                                <label className="block">
                                  <span className="field-label">核销 · 输入或扫描核销码</span>
                                  <input
                                    className="field font-mono"
                                    value={code}
                                    maxLength={64}
                                    autoComplete="off"
                                    autoCapitalize="off"
                                    spellCheck="false"
                                    disabled={busy}
                                    placeholder="例如 A1B2 C3D4 E5F6 7890"
                                    onChange={(event) => { setCode(event.target.value); setFound(null); }}
                                  />
                                </label>
                                <button type="button" className="btn-ghost !min-h-[44px]" disabled={busy} onClick={() => setScannerOpen(true)} title="摄像头扫码">
                                  <Camera size={16} /> 扫码
                                </button>
                                <button type="submit" className="btn-primary" disabled={busy || !code.trim()}>
                                  <ScanLine size={16} /> 查询凭证
                                </button>
                                <motion.button
                                  type="button"
                                  className="btn-primary !from-emerald-500 !to-emerald-600"
                                  disabled={busy || !redeemable}
                                  onClick={redeem}
                                  initial={{ scale: 0.9, opacity: 0 }}
                                  animate={{ scale: 1, opacity: 1 }}
                                >
                                  <Check size={16} /> 确认核销
                                </motion.button>
                              </form>
                              <AnimatePresence>
                                {found && (
                                  <motion.div
                                    className="mt-3 rounded-xl border border-coral/30 bg-coral/[0.08] px-4 py-3 text-sm"
                                    role="status"
                                    initial={{ opacity: 0, y: 10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0 }}
                                  >
                                    <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                                      {entryPairs(found, ENTRY_FIELDS).map(([field, value]) => (
                                        <div key={field.key} className="flex items-center gap-2">
                                          <dt className="shrink-0 text-xs text-mist">{field.label}</dt>
                                          <dd className="min-w-0 truncate">{renderField(field, value)}</dd>
                                        </div>
                                      ))}
                                    </dl>
                                    <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-mist">
                                      权益 {prizeKindBadge(found.prize, found.checkoutCoupon)}
                                    </p>
                                    {redeemBlocked && (
                                      <p className="mt-2 text-xs text-mist">现金券奖品请在收银结算时扫码抵扣，付款成功后自动核销，无需在此操作。</p>
                                    )}
                                    {found.status === 'redeemed' && (
                                      <p className="mt-2 text-xs text-mist">该凭证已核销，请勿重复发放。</p>
                                    )}
                                  </motion.div>
                                )}
                              </AnimatePresence>
                            </div>

                            {records.summary && typeof records.summary === 'object' && Object.keys(records.summary).length > 0 && (
                              <div className="mb-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
                                {Object.entries(records.summary)
                                  .filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value))
                                  .slice(0, 6)
                                  .map(([key, value]) => (
                                    <div key={key} className="glass px-3 py-3 text-center">
                                      <p className="text-[11px] text-mist">{SUMMARY_LABELS[key] || key}</p>
                                      <p className="mt-0.5 text-lg font-black text-coral-soft">{String(value ?? '—')}</p>
                                    </div>
                                  ))}
                              </div>
                            )}

                            {records.records.length ? (
                              <>
                                <div className="table-shell overflow-x-auto">
                                  <table className="w-full min-w-[640px] text-sm">
                                    <thead>
                                      <tr className="border-b border-white/[0.07] text-left text-xs text-mist">
                                        {RECORD_FIELDS.map((field) => <th key={field.key} className="px-4 py-3 font-medium">{field.label}</th>)}
                                        {isAdmin && <th className="px-4 py-3 font-medium">操作</th>}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {records.records.map((record, index) => (
                                        <tr key={record.code || record.id || index} className="table-row">
                                          {RECORD_FIELDS.map((field) => (
                                            <td key={field.key} className="px-4 py-3">{renderField(field, record[field.key])}</td>
                                          ))}
                                          {isAdmin && (
                                            <td className="px-4 py-3">
                                              {(record.code || record.rawCode) && record.status !== 'redeemed' ? (
                                                <button type="button" className="btn-ghost !min-h-[30px] !px-2.5 !py-0.5 text-xs hover:!border-red-400/50 hover:!text-red-300" disabled={busy} title="删除该用户的参与记录，删除后其可重新抽奖" onClick={() => removeRecord(activity, record)}>
                                                  <Trash2 size={12} /> 删除
                                                </button>
                                              ) : (
                                                <span className="text-xs text-mist/50" title={record.status === 'redeemed' ? '已核销记录保留发放凭证，不能删除' : ''}>—</span>
                                              )}
                                            </td>
                                          )}
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                                {records.hasMore && (
                                  <div className="mt-3 text-center">
                                    <button type="button" className="btn-ghost !min-h-[38px] !px-4 !py-1.5 text-sm" disabled={detailLoading} onClick={() => loadRecords(activity.id, recordsPage + 1, true)}>
                                      {detailLoading ? '正在加载…' : '加载更多'}
                                    </button>
                                  </div>
                                )}
                              </>
                            ) : (
                              <EmptyState icon={Sparkles} title="暂无活动记录" hint="活动产生数据后会显示在这里。" />
                            )}
                          </>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.article>
            );
          })}
        </div>
      </section>

      <AnimatePresence>
        {editor && (
          <ActivityEditor
            key={editor.id || 'new'}
            initial={editor}
            campaigns={campaigns}
            giftProducts={giftProducts}
            onClose={() => setEditor(null)}
            onSubmit={submitEditor}
          />
        )}
      </AnimatePresence>
      {scannerOpen && <ScannerModal onClose={() => setScannerOpen(false)} onDetected={onScan} />}
      {bridge && <ActivityBridgeModal activity={bridge} onClose={() => setBridge(null)} />}
    </PageShell>
  );
}
