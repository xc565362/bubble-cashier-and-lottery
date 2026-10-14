# Bubble 抽奖活动（自托管版）

Node.js 24+ + MySQL 8，唯一 npm 依赖是 `mysql2`（promise pool），无框架、无构建步骤。

## 本地运行

```bash
cp .env.example .env.local   # 填写 DB_* 等；WX_MOCK=1 或 WX_SECRET 留空即进入模拟登录模式
npm install                  # 安装 mysql2
npm start                    # http://localhost:8787
npm test                     # 连接真实配置的 DB 跑测试（随机活动 id，跑完自动清理测试行）
```

模拟模式下 `POST /api/session` 的 `code` 任意，不同 code 映射为不同的本地测试用户。
浏览器中可用 `http://localhost:8787/#/home?wx_code=任意至少8位字符` 直接进入。

真实模式：在 `.env.local` 填 `WX_APPID` / `WX_SECRET`，服务端用 `code` 调
`api.weixin.qq.com/sns/jscode2session` 换 openid（8 秒超时，不落日志）。

## 数据库

连接配置：`DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD`（见 `.env.example`）。
服务启动时先探测连接，连不上会打印明确错误并以退出码 1 终止。

表结构由部署方预先建好（本项目不含、也不会执行任何 DDL）。使用的表：
`hd_campaigns`（活动 + config JSON）、`hd_prizes`（库存）、`hd_entries`（中奖记录，
`UNIQUE(campaign_id,openid)`、`UNIQUE(code)`）、`hd_sessions`（会话，仅存 token 的 sha256）。
所有 DATETIME 均为北京时间：连接会话设置 `time_zone = '+08:00'`，读写经由统一的
毫秒 ↔ `YYYY-MM-DD HH:MM:SS.mmm` 转换（`src/db.js`），配置文件里的 `+08:00` ISO 时间可无损往返。

## 配置

`campaign.config.json` 是活动定义的源头：`active`、`startsAt`/`endsAt`/`redeemEndsAt`
（ISO 时间，建议带 `+08:00`）、`prizes`（`id/name/kind(cash|physical)/qty/probability/label/icon/amount`）。
每次启动会把活动行 upsert 进 `hd_campaigns`、把奖品同步进 `hd_prizes`；改文件后重启生效，
或用下方管理接口热更新（同样会同步到 DB）。

库存同步语义：新奖项按全额入库；调大 `qty` 补足库存，调小只钳制 `qty_remaining`，
已发出的奖品不回收。删除某奖品不影响已发出的记录。

## API 约定

全部返回 `{ok:true,data}` 或 `{ok:false,code,message}`。

- `POST /api/session` `{code}` → `{token, expiresAt}`（token 24 小时有效，服务端只存哈希）
- `POST /api/call`（`Authorization: Bearer <token>`）`{action, payload}`：
  - `state` → 活动配置 + 库存 + 当前用户 entry（只读，不触发任何发奖）
  - `draw` → 每人一次（`UNIQUE(campaign_id, openid)`），重复调用返回同一 entry；
    单事务内加权抽取（仅 remaining>0 的奖项参与）、扣库存、生成 16 位核销码；
    库存抽完会持久化一个“未中奖”结果，重试不会重抽
  - `identity` → `{openId, isAdmin}`
  - `lookup {code}` / `redeem {code}` → 仅工作人员

工作人员认定：请求带 `X-Staff-Key: <STAFF_KEY>`，或登录 openid 在 `STAFF_OPENIDS` 列表中。

### 收银台集成（无需微信会话）

`lookup` / `redeem` 只凭工作人员密钥即可调用：

```bash
curl -X POST http://localhost:8787/api/call \
  -H 'Content-Type: application/json' \
  -H 'X-Staff-Key: 你的STAFF_KEY' \
  -d '{"action":"redeem","payload":{"code":"A1B2C3D4E5F67890"}}'
```

重复核销返回 `{ok:false,code:"ALREADY_REDEEMED"}`（409）；未知码 `NOT_FOUND`（404）。
核销规则：只要在 `redeemEndsAt` 之前、状态为待核销即可核销；过期后拒绝（`EXPIRED`，410），
与用户在 H5 看到的“已过期”一致。

### 管理接口（均需 `X-Staff-Key`）

- `GET /api/admin/records` → 全部记录（openid 已脱敏）+ 汇总
- `GET /api/admin/records.csv` → CSV 导出（带 BOM，Excel 可直接打开）
- `POST /api/admin/config` → 局部更新 `campaign.config.json`（`active`、日期、`prizes` 等），
  校验通过后原子写文件并热加载

## H5 工作人员入口

`#/staff` 页面：非工作人员可输入工作人员密钥验证（密钥保存在 sessionStorage，
随 `X-Staff-Key` 请求头发送），或让管理员把自己的 openid（页面可复制）加入 `STAFF_OPENIDS`。

## 与旧系统的差异

- 立减金不再对接微信收银券体系：所有奖品统一为“现场出示核销码 → 收银/工作人员核销”。
  `checkoutCoupon` 恒为 false，没有 `using`/`issuing` 等中间态。
- `state` 只读；旧系统的懒重发行为已移除。
- 不支持 `wx_ticket` 登录方式，小程序跳转请传 `wx_code`。
- 库存抽完时持久化“未中奖”entry，前端显示为“券状态待同步”样式的占位（边界情况，500 份发完才会出现）。
