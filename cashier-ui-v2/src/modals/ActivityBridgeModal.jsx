import React, { useMemo, useState } from 'react';
import { Bot, Check, ClipboardCopy, ListOrdered, Terminal } from 'lucide-react';
import { Modal } from '../components/ui.jsx';

const H5_ORIGIN = 'https://bubble.moody-vip.com';

const fmt = (value) => (value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—');

// The copy-paste prompt a developer feeds to any LLM to generate a static H5
// for this activity. It is deliberately self-contained: endpoints, auth flow,
// action list, error codes, and this activity's concrete config in one block.
function buildPrompt(activity) {
  const id = activity.id;
  const base = `${H5_ORIGIN}/activity/${id}`;
  const prizes = (Array.isArray(activity.prizes) ? activity.prizes : []).map((p) => {
    const kind = p.kind === 'cash' ? 'cash' : 'physical';
    const amount = kind === 'cash' ? ` amount=${p.amount}元` : '';
    const img = p.imageUrl ? `\n  图片: ${p.imageUrl}` : '';
    return `- [${kind}] ${p.name || p.id}（数量 ${p.quantity ?? '—'}，权重 ${p.probability ?? 1}）${amount}${img}`;
  }).join('\n') || '- （无奖品配置）';

  return `# 任务
为「泡泡收银台」内置活动运行时生成一个纯静态 H5 活动页面：单个 index.html，原生 HTML/CSS/JS，无构建工具、无框架、无 npm 依赖、无外部 CDN（图标用 emoji 或内联 SVG）。供微信 miniapp 的 web-view 打开，移动端优先，视觉精致并有动效。

# 运行环境
- 部署在 https 下；业务域名已完成微信校验。
- 活动 ID 从 URL 查询参数 a 读取（36 位 UUID，必填；缺失或非法显示错误提示页）。
- 微信登录凭证由小程序端拼接进 URL：普通用户带 wx_code=<wx.login 的 code>，工作人员链接可能带 wx_ticket=HT1.xxx。优先用 wx_ticket，其次 wx_code；两者都没有则提示「请从小程序重新进入活动」。

# 后端契约（严格遵守，不要自创端点或字段）
Base URL: ${base}
- 全程 JSON；所有 fetch 必须 credentials:'omit'（禁止携带 Cookie）。
- 响应统一信封：成功 {ok:true, data}；失败 {ok:false, code, message, error}。message/error 为中文，直接对用户展示。
- 登录：POST ${base}/session，body 为 {"code":"..."} 或 {"ticket":"..."} → 返回 data.token（24 小时有效，data.expiresAt 为毫秒时间戳）。此后每个请求带请求头 Authorization: Bearer <token>；token 失效（401 AUTH_REQUIRED）时提示用户回小程序重新进入。
- 业务：POST ${base}/call，body {"action":"<动作>","payload":{...}}。本活动可用动作：
  1. state — 无 payload。返回活动公开配置（campaign）、奖品列表（prizes）、库存（inventory）、我的中奖记录（entry，无则为 null）、drawsRemaining。
  2. draw — 无 payload。执行抽奖：每人一次，重复调用返回同一条中奖记录；奖品发完时返回 status:"unavailable" 的持久化结果（code 为空串）。
  - identity — 无 payload。返回 {openId, isAdmin}。isAdmin 为 true 时页面显示「工作人员核销」入口。
  4. lookup / redeem（仅工作人员模式）— payload {"code":"16位十六进制核销码"}，须同时携带请求头 X-Staff-Key${activity.staffKey ? `（本活动的密钥：${activity.staffKey}）` : '（值询问活动管理员，绝不要写死在前端代码里；应让用户在页面上输入后存 sessionStorage）'}。redeem 重复核销返回 409。
- 中奖记录 entry 关键字段：prize{name,kind,amount,imageUrl,checkoutCoupon}、code（16 位大写十六进制）、status（pending/redeemed/expired/unavailable）、expiresAt、minimumGoodsAmountCents、redeemedAt、checkoutCoupon。
- checkoutCoupon=true 的码是收银台抵扣券码：页面必须展示完整 16 位码并提示「结账时出示给收银员扫码抵扣」，付款成功后自动核销，不要在 H5 内提供核销按钮（服务端会拒绝，409 CHECKOUT_COUPON）。
- 实物奖品（kind:"physical"）的码按 4 位分组展示便于人工核对；pending 状态展示码，redeemed 显示已核销时间。
- 错误码：AUTH_REQUIRED 401 / NOT_FOUND 404 / PAUSED·ENDED 410 / NOT_STARTED 400 / SOLD_OUT 400 / INVALID_CODE 400 / ALREADY_REDEEMED 409 / CHECKOUT_COUPON 409 / EXPIRED 410 / RATE_LIMIT 429。每个错误都要有对应的中文提示，不白屏。

# 本活动配置（只读展示用；state 接口返回同结构数据，以接口为准）
活动 ID: ${id}
标题: ${activity.title || activity.name || '—'}
副标题: ${activity.name || '—'}
地点: ${activity.venue || '—'}
开始: ${fmt(activity.startsAt)}
结束: ${fmt(activity.endsAt)}
核销截止: ${fmt(activity.redeemEndsAt)}
规则文案: ${activity.rulesText || '（无）'}
现金券使用说明: ${activity.cashTerms || '（无）'}
奖品池:
${prizes}

# 验收要求
1. 完整流程：进入 → 读取 a/wx_code → 登录 → state 展示活动与奖池 → draw 抽奖 → 展示中奖码与状态（含图片 imageUrl）。
2. 重复进入已中奖用户直接展示自己的记录（state.entry 非空时不再提供抽奖按钮）。
3. 加载中、失败、活动未开始/已结束等空状态都有中文提示。
4. 输出完整可运行的 index.html 全文，不要省略。`;
}

function buildCurl(activity) {
  const base = `${H5_ORIGIN}/activity/${activity.id}`;
  return `# 1) 登录（真实环境把 test12345 换成 wx.login 的 code）
curl -s -X POST ${base}/session \\
  -H 'Content-Type: application/json' \\
  -d '{"code":"test12345"}'

# 2) 活动状态（把 <TOKEN> 换成上一步返回的 data.token）
curl -s -X POST ${base}/call \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer <TOKEN>' \\
  -d '{"action":"state"}'

# 3) 抽奖
curl -s -X POST ${base}/call \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer <TOKEN>' \\
  -d '{"action":"draw"}'

# 4) 工作人员核销（需要 X-Staff-Key）
curl -s -X POST ${base}/call \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer <TOKEN>' \\
  -H 'X-Staff-Key: <STAFF_KEY>' \\
  -d '{"action":"redeem","payload":{"code":"A1B2C3D4E5F60708"}}'`;
}

const STEPS = [
  ['创建并启用活动', '在「活动管理」填好标题、时间、小程序 AppID 与奖池（现金券从券池选、实物从赠品池选），保存后点「启用」。'],
  ['复制 LLM 提示词', '点该活动的「接入助手」，复制下方整段提示词（已自动带入本活动的 UUID、时间与奖池）。'],
  ['让 LLM 生成 H5', '把提示词整段粘贴给任意大模型（Claude / ChatGPT / DeepSeek…），让它输出完整 index.html。'],
  ['部署静态文件', '把 index.html 放到服务器 /statics/huodong-<活动ID>/ 目录，并在 bubble.moody-vip.com 的 nginx 配置加一段 location（见下方模板），确认 https 可访问。'],
  ['小程序接入', '小程序 web-view 指向 https://bubble.moody-vip.com/huodong-<活动ID>/?a=<活动ID>（由小程序端拼接 wx_code=），业务域名保持已校验状态。'],
  ['自测后上线', '先用下方 curl 命令冒烟，再用手机走完整流程：进入 → 抽奖 → 中奖码 → 收银台核销。'],
];

const NGINX_SNIPPET = `location /huodong-<活动ID>/ {
    alias /statics/huodong-<活动ID>/;
    index index.html;
    try_files $uri $uri/ /huodong-<活动ID>/index.html;
    types {
        text/html                             html;
        application/javascript                js mjs;
        text/css                              css;
        image/svg+xml                         svg;
        application/manifest+json             webmanifest;
        application/json                      json;
    }
}`;

function CopyBlock({ text, label }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.08]">
      <div className="flex items-center justify-between border-b border-white/[0.06] bg-white/[0.03] px-3 py-2">
        <span className="text-xs text-mist">{label}</span>
        <button
          type="button"
          className="btn-ghost !min-h-[30px] !px-2.5 !py-0.5 text-xs"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            } catch {
              window.prompt('复制失败，请手动复制：', text);
            }
          }}
        >
          {copied ? <><Check size={13} /> 已复制</> : <><ClipboardCopy size={13} /> 复制</>}
        </button>
      </div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all bg-black/30 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-mist">{text}</pre>
    </div>
  );
}

export function ActivityBridgeModal({ activity, onClose }) {
  const prompt = useMemo(() => buildPrompt(activity), [activity]);
  const curl = useMemo(() => buildCurl(activity), [activity]);
  const id = activity.id;
  return (
    <Modal title={`接入助手 · ${activity.title || id}`} onClose={onClose}>
      <div className="space-y-5">
        <p className="text-sm text-mist">
          此活动由收银服务内置运行时托管，H5 不需要任何后端：把下面提示词交给大模型生成静态页面即可，
          券发放与核销全部由收银台在同一数据库内完成。
        </p>

        <div className="grid gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 text-xs sm:grid-cols-2">
          <div>
            <p className="text-mist/70">API Base</p>
            <code className="break-all font-mono text-coral-soft">{H5_ORIGIN}/activity/{id}</code>
          </div>
          <div>
            <p className="text-mist/70">H5 入口（小程序 web-view）</p>
            <code className="break-all font-mono text-coral-soft">{H5_ORIGIN}/huodong-{id}/?a={id}</code>
          </div>
          <div>
            <p className="text-mist/70">登录凭证</p>
            <p className="font-mono">URL 参数 wx_code 或 wx_ticket</p>
          </div>
          <div>
            <p className="text-mist/70">工作人员核销</p>
            {activity.staffKey ? (
              <p className="break-all font-mono">请求头 X-Staff-Key: <span className="text-coral-soft">{activity.staffKey}</span></p>
            ) : (
              <p className="font-mono">请求头 X-Staff-Key（未设置 · 编辑活动可填写）</p>
            )}
          </div>
        </div>

        <section>
          <h4 className="mb-2 flex items-center gap-2 text-sm font-bold"><ListOrdered size={15} className="text-coral" /> 操作步骤</h4>
          <ol className="space-y-2">
            {STEPS.map(([title, body], index) => (
              <li key={title} className="flex gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-coral/15 text-xs font-black text-coral">{index + 1}</span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{title}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-mist">{body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section>
          <h4 className="mb-2 flex items-center gap-2 text-sm font-bold"><Bot size={15} className="text-coral" /> LLM 提示词</h4>
          <CopyBlock text={prompt} label="整段复制 → 粘贴给大模型生成 H5" />
        </section>

        <section>
          <h4 className="mb-2 flex items-center gap-2 text-sm font-bold"><Terminal size={15} className="text-coral" /> 冒烟自测（curl）</h4>
          <CopyBlock text={curl} label="登录 → state → draw → redeem" />
        </section>

        <section>
          <h4 className="mb-2 flex items-center gap-2 text-sm font-bold"><Terminal size={15} className="text-coral" /> nginx 静态目录模板</h4>
          <CopyBlock text={NGINX_SNIPPET.replaceAll('<活动ID>', id)} label="加在 bubble.moody-vip.com 的 server 块内" />
        </section>
      </div>
    </Modal>
  );
}
