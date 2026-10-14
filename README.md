# Bubble 收银与双 H5 抽奖源码

更新日期：2026-10-14。仓库包含在线收银、共享券中心及两个 H5 抽奖项目，三个项目保持相对位置以便联调。

| 项目 | 源码目录 |
| --- | --- |
| 在线收银、管理员登录、共享账本、收钱吧、活动管理与核销 | `cashier-system-sqb` |
| 此刻在地 H5、登录网关和小程序接入 | `小程序交付/Bubble-H5-1.0.3-qr0922` |
| 山野有约 H5、头巾九宫格、邀请和核销 | `小程序交付/Bubble-H5-小红书头巾-50` |

## 当前部署

在线收银和券中心已升级至 `20261014-b82dd53ca561`，两套 H5 与三个 CloudBase 云函数也已部署。收银后台可管理奖品、概率和活动说明，查看云端抽奖记录，并关联券中心的权威核销状态。

H5 使用 `cloud-ticket` 登录：原生小程序通过平台身份取得一次性票据，H5 兑换短期会话。网关已部署且 readiness 检查通过；两个活动仍暂停。正式业务域名、小程序入口发布、微信真机全流程、备货与活动时间、赛事容量仍待验收。默认测试域名和 readiness 成功不代表公众活动已开放。

当前收银 package 版本仍为 `0.7.13`，部署版本以发布标识为准。完整原生小程序参考工程位于此刻在地的 `integrations/native-miniprogram-reference`，参考源码不代表入口已经发布。

## 开发与验证

收银运行环境使用 Node.js 24；H5 要求 Node.js 20 或更新版本。以下命令在 `cashier-system-sqb` 中执行：

```sh
npm ci
npm test
npm run build
npm run activities:preview
```

`activities:preview` 启动隔离演示，不能作为正式经营入口。两个 H5 可分别在各自目录运行 `npm install`、`npm test`、`npm run build` 和 `npm start`。生产构建须使用各项目文档中的正式接口配置，不能使用演示配置。

部署与数据流见 [DEPLOYMENT.md](DEPLOYMENT.md)，测试范围见 [VERIFICATION.md](VERIFICATION.md)，可复用用例见 [抽奖测试用例](cashier-system-sqb/docs/lottery-test-cases.md)。

## 数据与密钥

源码备份不包含业务数据库、商户配置、登录密钥、支付密钥或私有审计资料。敏感配置和经营备份应独立加密保存，不得提交 Git；源码备份不能替代业务数据备份。浏览器本地版、桌面版和在线共享账本不会自动互相同步。
