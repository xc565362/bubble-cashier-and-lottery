# 活动 H5 接入契约（folded-in activity API）

线上收银服务（cashier-v2 `online/server.cjs`）内置了活动运行时。H5 只需把
`apiBase` 指向下面任何一个活动地址即可，请求/响应结构与 lottery-v2 完全
一致（`{ok:true,data}` / `{ok:false,code,message,error}`）。

## Base URL

```
https://<收银服务域名>/activity/<uuid>
```

`<uuid>` 是活动编号（收银后台「活动管理」创建后获得）。全程 JSON；
**不允许携带 Cookie**（`credentials: 'omit'`），参与凭证走
`Authorization: Bearer <token>`。跨域已开放（`Access-Control-Allow-Origin: *`，
预检缓存 600s）。

## 端点一览

### POST /activity/\<uuid\>/session — 登录

请求：`{"code": "<微信 wx.login 凭证>"}`（1–256 字符）。

```json
{ "ok": true, "data": { "token": "bsv1....", "expiresAt": 1761000000000 } }
```

- `token` 24 小时有效（`expiresAt` 为毫秒时间戳），失效后任何 `/call` 返回
  401 `AUTH_REQUIRED`，H5 应引导用户回小程序重新进入。
- 活动未配置微信密钥时按 mock 模式签发（与 lottery-v2 的 WX_MOCK 约定一致）。
- `draft`（未发布）活动返回 404；`paused`/`ended` 活动**仍可登录**，中奖者
  随时能回来查看自己的奖品码。

### POST /activity/\<uuid\>/call — 业务调用

请求：`{"action": "<动作>", "payload": {...}}`，必须带 `Authorization: Bearer`。

| action | 说明 |
| --- | --- |
| `state` | 活动公开配置 + 奖品列表 + 库存 + 我的中奖记录 |
| `draw` | 执行抽奖（每人一次；重复调用返回同一条中奖记录） |
| `identity` | `{openId, isAdmin}`（`isAdmin` 为是否同时带了正确的工作人员密钥） |
| `lookup` | 工作人员扫码查询，`payload.code` 为核销码 |
| `redeem` | 工作人员核销实物奖品，`payload.code`（幂等单用，二次核销 409） |
| `retry-coupon-issue` | 运维兼容动作；本实现发券与抽奖同事务，恒返回零扫描结果 |

`state` 响应（关键字段）：

```json
{
  "ok": true,
  "data": {
    "campaign": {
      "id": "<uuid>", "title": "此刻在地", "name": "赛场同行", "venue": "Bubble展位",
      "enabled": true, "startsAt": 1761000000000, "endsAt": 1768000000000,
      "redeemEndsAt": 1768000000000, "cashTerms": "每单限一张", "rulesText": "",
      "inventory": { "version": 1, "total": 2 }
    },
    "prizes": [ { "id": "cash10", "name": "10元立减金", "kind": "cash", "amount": 10,
      "probability": 1, "label": "", "icon": "", "quantity": 1,
      "imageUrl": "https://cdn.example.com/prize-cap.png" } ],
    "inventory": { "total": 2, "remaining": 1 },
    "drawError": null,
    "drawsRemaining": 1,
    "entry": null
  }
}
```

`draw` / `entry` 结构：

```json
{ "prize": { "id": "cash10", "name": "10元立减金", "kind": "cash", "amount": 10,
    "shortName": "10元立减金", "label": "", "icon": "", "checkoutCoupon": true,
    "imageUrl": "https://cdn.example.com/prize-cap.png" },
  "code": "A1B2C3D4E5F60708", "createdAt": 1761000000000, "status": "pending",
  "checkoutCoupon": true, "expiresAt": 1768000000000, "minimumGoodsAmountCents": 0,
  "redeemedAt": null }
```

- `status`: `pending` | `redeemed` | `expired`（超过 `redeemEndsAt` 自动呈现）|
  `unavailable`（名额已发完的持久化结果，此时 `code` 为空串）。
- 奖池是「池化引用」而非自由配置：现金券奖品引用券中心里已启用的现金券活动
  （名称/面额/门槛在保存时从券活动拷贝成快照），实物奖品引用商品管理里的赠品；
  `imageUrl` 公开下发，H5 用它渲染奖品图（缺省时现金券显示面额图案）。
- `checkoutCoupon: true` 表示该码同时是收银台抵扣券码（16 位大写十六进制），
  付款成功后自动核销；工作人员**不能**在现场核销它（`CHECKOUT_COUPON` 409）。
- 现金券与中奖记录同一事务写入：要么同时成功，要么都失败重抽，不存在
  「中了奖但没券」的中间态。

工作人员动作用请求头 `X-Staff-Key: <活动的工作人员密钥>` 鉴权（密钥由管理员
在创建活动时设置）。未登录带错密钥 → 401 `UNAUTHORIZED`；已登录但非工作人员
→ 403 `FORBIDDEN`（H5 不应因此丢弃登录态）。

## 错误信封

```json
{ "ok": false, "code": "PAUSED", "message": "活动暂未开放，请留意现场通知", "error": "活动暂未开放，请留意现场通知" }
```

`message` 与 `error` 相同，直接展示给用户即可。关键错误码：

| code | HTTP | 场景 |
| --- | --- | --- |
| `AUTH_REQUIRED` | 401 | 未登录或 token 过期/伪造/串活动 |
| `NOT_FOUND` | 404 | 活动不存在或未发布（draft） |
| `PAUSED` / `ENDED` | 410 | 活动暂停/结束（仅拦截 `draw`；登录与查奖品不受影响） |
| `NOT_STARTED` | 400 | 未到开始时间 |
| `SOLD_OUT` | 400 | 名额发完（draw 会持久化「奖品已发完」结果） |
| `INVALID_CREDENTIAL` | 400 | 登录凭证格式错误 |
| `WX_LOGIN_FAILED` | 502 | 微信 code2session 失败 |
| `INVALID_CODE` / `NOT_FOUND` | 400/404 | 核销码格式错误 / 不存在 |
| `ALREADY_REDEEMED` | 409 | 重复核销 |
| `CHECKOUT_COUPON` | 409 | 立减金须在收银台结算抵扣 |
| `EXPIRED` | 410 | 超过核销期限 |
| `RATE_LIMIT` | 429 | 触发限流 |
| `INVALID_ACTION` | 400 | 不支持的 action |

## 限流

按来源 IP 每分钟计数（与券中心相同的分钟桶实现）：

- `/session`：60 次/分钟/IP
- 全部 `/activity/*` 合计：300 次/分钟/IP

超限返回 429 `RATE_LIMIT`，下一分钟自动恢复。

## 安全约定

- 微信 secret 仅保存在服务端（AES-256-GCM 加密落库），任何接口不返回。
- 参与 token 是加密不透明串，不落地存储；按活动隔离，跨活动使用视为未登录。
- 管理接口（创建/上下架/记录/核销/导出）不在本公网路径上，走收银台会话的
  `/api/sqb/activity-*`，受角色 + 模块权限（`events`）控制。
