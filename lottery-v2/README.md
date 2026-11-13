# lottery-v2 — 活动 H5 静态模板

这是一个**纯静态** H5（无后端、无构建、无依赖），作为「泡泡收银台」内置活动运行时的
参考前端。活动 API 由 cashier-v2 单体后端在 `/activity/<uuid>/*` 提供，本目录的
`public/` 只负责界面与客户端 fetch。

> 旧独立后端（`server.mjs`，:8787，pm2 `bubble-lottery`）已退役并已从本仓库移除。
> 线上回滚副本仍在服务器 `/root/bubble-lottery`（及 `/root/bubble-lottery-v2`），
> 与本地仓库无关。券发放、核销、库存、抽奖事务全部在 cashier-v2 进程内完成。

## 运行方式

由微信 miniapp 的 web-view 打开，URL 必须带活动 ID：

```
https://bubble.moody-vip.com/huodong-<活动UUID>/?a=<活动UUID>
```

- `?a=` 是唯一活动来源（36 位 UUID，缺失或非法显示错误页）。
- 登录凭证由小程序端拼接：`wx_code=`（wx.login）或 `wx_ticket=`（工作人员），
  优先 ticket，其次 code。
- API base 同源：`/activity/<uuid>/session`（登录）与 `/activity/<uuid>/call`
  （`state` / `draw` / `identity` / 工作人员 `lookup`+`redeem`），
  `fetch` 一律 `credentials:'omit'`，凭证走 `Authorization: Bearer`。
- 完整契约见 `../cashier-v2/docs/activity-h5-contract.md`。

## 部署（每个活动一次）

```bash
./scripts/deploy.sh <活动UUID>
# 或 ACTIVITY_ID=<uuid> ./scripts/deploy.sh
# 预览计划：DRY_RUN=1 ./scripts/deploy.sh <uuid>
```

脚本按服务器既定拓扑依次完成（幂等，每步带备份与回滚）：

1. rsync `public/` → 服务器 `/statics/huodong-<uuid>/`（主机源目录）。
2. 若缺失则向 nginx 的 `docker-compose.yml` 追加卷
   `- /statics/huodong-<uuid>:/data/huodong-<uuid>` 并 `docker compose up -d` 重建容器。
3. 若缺失则在 bubble.moody-vip.com 的 server 块插入精确路由：
   `location = /huodong-<uuid>`（入口）+ `/huodong-<uuid>/`（该活动自身子树），
   然后 `nginx -t` 并 reload。
4. 本地 curl 校验 200，打印 web-view 入口地址。

## 目录

```
public/          H5 静态文件（index.html + 原生 ES modules，直接部署）
scripts/deploy.sh  每活动静态部署脚本（唯一需要的东西）
```

## 新活动要做什么

1. cashier 管理端「活动管理」创建并启用活动（奖池引用券池/赠品池）。
2. 可以原样部署本 H5，或把「接入助手」生成的提示词交给大模型产出新的
   `index.html` 再部署 —— 两者都走同一个 `./scripts/deploy.sh <uuid>`。
