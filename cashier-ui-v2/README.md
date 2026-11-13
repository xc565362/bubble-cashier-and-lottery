# Bubble 收银台 · cashier-ui-v2

对原有摆摊收银系统（`cashier-system-sqb`）的独立现代化前端重写。深色未来主义 POS 界面，保持与原后端完全一致的 API 契约。

## 技术栈

- Vite 6 + React 18（纯 JSX，无 TypeScript）
- Tailwind CSS 3 + framer-motion（弹性微动效）
- lucide-react 图标、qrcode（券二维码）、@zxing/browser（摄像头扫码）、read-excel-file（商品导入）
- 内嵌 `src/vendor/jsbarcode.js`（沿用原项目的 Code128 券条形码渲染，见 `src/vendor/jsbarcode-LICENSE.txt`）

## 开发

```bash
npm install
npm run dev
```

开发服务器默认端口 **5174**，`vite.config.js` 已配置代理：

```
/cashier-api  →  http://127.0.0.1:5175
```

即本机收银后端（原项目的 `payments/web.cjs` / online 服务）。先启动后端，再启动本前端即可正常登录。

## 构建

```bash
npm run build     # 输出到 dist/
npm run preview   # 本地预览构建产物
```

## API 基址配置

所有请求经由单一常量：

- `src/config.js` → `API_BASE`（默认 `/cashier-api`，可用环境变量 `VITE_API_BASE` 覆盖）

## API 契约（与原系统一致）

### 在线账务 `${API_BASE}/online/<path>`（cookie 会话 + `X-Terminal-Id` + `X-CSRF-Token`）

- `GET session` — 检测/恢复会话（401 → 登录页）
- `POST login {username, password}` / `POST logout`
- `GET ledger` — 账本快照 `{ ledger, revision, lease }`
- `POST command { type, payload, expectedRevision, requestId }` — 全部写操作：
  `product-save` `product-delete` `products-import` `order-revise` `legacy-confirm`
  `hold` `retrieve` `held-delete` `settings-save`（收款码 / 加赠规则）
  `payment-prepare` `payment-sync` `payment-review` `payment-clear`
  `manual-complete` `zero-complete` `physical-sync`
  `adjustment-prepare` `adjustment-sync` `adjustment-clear`
  `recovery` `initial-import`
- `POST lease/acquire {takeover}` / `POST lease/release` — 收银权限（含 20 秒心跳续期）
- `GET export` — 完整经营备份导出
- `GET users` / `POST users` / `PATCH users/:id` / `POST users/:id/password` — 账号管理（管理员）

### 收钱吧 / 券 / 抽奖 `${API_BASE}/sqb/<action>`（POST JSON，信封 `{ok, data}` / `{ok:false, code, error}`）

- 支付：`config` `save-config` `import-credentials` `export-credentials` `generate-key` `check-connection` `diagnostics` `start` `query` `pending` `acknowledge` `resolve-missing-payment` `claim-payment-notification` `preview-adjustment` `start-adjustment`
- 券：`coupon-config` `coupon-campaigns` `coupon-coupons` `coupon-keys` `coupon-sync` `coupon-pending` `coupon-physical-bindings` `coupon-connect` `coupon-create-campaign` `coupon-set-campaign` `coupon-issue` `coupon-coupon` `coupon-void` `coupon-create-key` `coupon-revoke-key` `coupon-bind-physical-products` `coupon-release` `coupon-reserve` `coupon-zero` `coupon-zero-ack` `coupon-fulfilment`
- 自托管抽奖：`h5lottery-config` `h5lottery-connect` `h5lottery-records` `h5lottery-lookup` `h5lottery-redeem` `h5lottery-export-csv`

## 与原系统的差异（有意为之）

- 仅保留云端在线模式：无 electron / `window.sqb` 桥、无 localStorage 离线账本。会话失效或后端不可达时回到登录 / 重连页。
- 已移除旧活动模块：ScarfManager、LotteryManager、LotteryPrizeEditor、LotteryRecords、ActivityRulesEditor（抽奖面板改用 `LotteryLocal` 自托管服务流）。
- 「赠品规则」并入「商品」页底部；「账号与资料」和收钱吧设置并入「设置」页。
