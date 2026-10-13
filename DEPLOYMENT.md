# 部署与配置

本仓库提供源码，不包含生产连接凭据。请使用现有账号下的私密备份恢复配置，不重新生成或覆盖正在使用的券中心身份。

## 服务关系

- cashier-system-sqb/lottery-backend：原小程序及“此刻在地”管理接口的业务服务。
- 此刻在地/server/cloudfunctions/bubble-h5-gateway：H5 登录网关及共享业务模块。
- 山野有约/server/cloudfunctions/bubble-scarf-gateway：头巾活动、邀请、奖品管理、券中心接入。
- cashier-system-sqb/coupons：共享券中心；两个活动的新中奖凭证由收银系统管理和核销。
- cashier-system-sqb/payments：收银后端与收钱吧、券中心和活动管理连接。

## 2026-10-13 已部署状态

云端已有两个 H5 与新网关、HTTP 路由、所需集合；原 lottery 函数及原券中心已兼容升级。网页和云函数文件回下载验证通过，原业务数据未改变。本次源码导出没有再次部署或改变活动开关。

两套 H5 的 H5_GATEWAY_ENABLED 和 H5_BACKEND_REVIEWED 为 0；SCARF_MANAGEMENT_ENABLED 为 0。AppSecret 未配置，正式域名和小程序入口发布未完成。

## 从源码部署

1. 为两套页面配置已备案的自有 HTTPS 域名。两页面可共享域名，使用不同路径。
2. 按各 H5 的 server 目录部署说明填写私密环境变量，微信 AppID、AppSecret 与原生入口属于同一个小程序；不要将密钥写进 public 或本仓库。
3. 两个活动与收银端使用同一生产券中心；保留 centerId、既有凭证与原管理权限。
4. 此刻在地 API 路由 /api/bubble-h5，头巾 API /api/scarf-h5，头巾管理 /api/scarf-management；路径应透传给云函数。HTTP 接口由应用自身验证身份/签名。
5. 配置 public/runtime-config.js 的正式 apiBase，执行 npm run build，只部署 dist；原生 web-view 入口模板在 integrations/miniprogram。
6. 在未开放活动前完成登录、权限、奖品管理、库存、抽奖及重复核销的隔离验收，再设置实际时间并开放。不得通过初始化或覆盖旧奖池恢复服务。

头巾活动接入券中心后新产生的实物凭证在收银台核销；接入前 legacy 旧码仍按原现场工作台规则处理，不能假定已自动迁移。

源目录中的历史验证记录代表当时结果；当前验证汇总见 VERIFICATION.md。
