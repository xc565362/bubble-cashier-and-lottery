# 在线收银与券中心 Linux 更新工具

此目录保存可复用的更新、隔离验收与数据保全源码。运行要求 Node.js 24；实际应用更新需要 Linux、root 权限和已核对的 systemd 服务。不会初始化账号、覆盖原环境文件、重置密钥或导入业务数据。原始交付目录中的脚本与证据仍保留。

## 在收银项目根目录准备更新包

先安装项目依赖，再从 `cashier-system-sqb` 根目录执行：

```sh
npm run build -- --base /cashier/ --outDir deployment/linux/online-dist
node deployment/linux/package-update.cjs --date YYYYMMDD
```

将 `YYYYMMDD` 替换为本次实际发布日期，例如 `20261014`。包名由发布日期和内容摘要组成；已有同名归档不会被覆盖。脚本生成独立 `stage-*`、归档以及 `cashier-release-state.json`，保留历史版本清单。运行时源目录仍以 `../..` 定位收银项目根目录。

生成目录、JSON 清单/报告、压缩包、日志、数据库、环境文件和密钥已通过本目录 `.gitignore` 排除。只提交工具源码和说明；不要将真实业务备份或私有配置放进提交。

## 只运行工具的 20 项测试

```sh
node --test deployment/linux/update-linux.test.cjs deployment/linux/server-preservation-reconcile.test.cjs
```

共 20 项：更新器 15 项、保全复核 5 项，覆盖现有覆盖配置校验、维护期间阻止新收银、SQLite WAL 备份、失败回滚、只允许经过逻辑验证的辅助文件，以及异常变更拒绝。测试使用临时文件，不访问正式服务。

完成打包后，可额外验证实际包内运行时：

```sh
node --test deployment/linux/release-smoke.test.cjs
node deployment/linux/isolated-release-acceptance.cjs --release /absolute/path/to/generated/stage
```

`release-smoke.test.cjs` 从本目录生成的 `cashier-release-state.json` 读取包位置。独立验收脚本可单独上传服务器，针对已经安装的版本执行：

```sh
/opt/node-v24.19.0-linux-x64/bin/node /path/to/isolated-release-acceptance.cjs \
  --release /opt/bubble/cashier-online-RELEASE_ID
```

验收校验包清单，然后创建全新的临时账户、密钥和数据库。实际券服务仅监听临时 localhost 端口；检查真实 HTTP 发券、状态、占用、零元核销、独立 SQLite 连接读回、进程重启与重复核销拒绝。在线收银部分检查登录、资源、未登录 401、只读查询和收银租约限制，并阻止出站请求。结束后清理测试进程和临时数据。不要加载正式环境文件；它不执行真实抽奖、真实付款或正式凭证核销，也不能证明微信真机链路已验收。

## 更新现有 Linux 服务

先查验服务单元、覆盖配置、环境文件位置、实际 Node 路径和当前版本目录；确认没有有效收银租约或未决交易。将更新包解压到新的独立目录，核对 SHA-256。

下面只产生 dry-run 计划，路径占位符必须替换：

```sh
sudo /opt/node-v24.19.0-linux-x64/bin/node /path/to/stage/update-linux.cjs \
  --source /path/to/stage \
  --target online \
  --node /opt/node-v24.19.0-linux-x64/bin/node \
  --expected-release /opt/bubble/EXISTING_ONLINE_RELEASE
```

核对计划后，在同一命令追加 `--apply` 才进行更新。工具保留现有账号、账本、环境和密钥，创建私有备份，切换版本目录，并检查健康与未登录 401。失败时恢复旧代码；不会自动用旧数据库覆盖新产生的业务数据。

券服务升级另需已核对的 `--unit`、`--env-file`、`--expected-release` 和 `--origin`。`--coupon-drop-in-profile h5-20261013` **只适用于代码中严格定义的那组历史基础单元及四份覆盖配置**；已有服务再次升级后不再符合该旧配置，不能照抄重用或绕过校验。需先重新核对并适配实际配置。券服务升级期间会暂停在线收银，阻止新结算进入；既有覆盖文件保留，新文件仅在内容仍匹配时由回滚移除。

## 数据保全脚本

`server-preservation-audit.cjs` 为已核对的服务器布局保存升级前/后只读状态摘要；`server-preservation-reconcile.cjs` 在保留原证据的前提下生成新的复核报告。报告路径必须位于 root 私有的 `/var/lib/bubble-online-deploy-backups`，不得上传到 Git。

```sh
sudo /opt/node-v24.19.0-linux-x64/bin/node /path/to/server-preservation-audit.cjs before /var/lib/bubble-online-deploy-backups/BEFORE.json
sudo /opt/node-v24.19.0-linux-x64/bin/node /path/to/server-preservation-audit.cjs after /var/lib/bubble-online-deploy-backups/BEFORE.json
sudo /opt/node-v24.19.0-linux-x64/bin/node /path/to/server-preservation-reconcile.cjs \
  --before /var/lib/bubble-online-deploy-backups/BEFORE.json \
  --after /var/lib/bubble-online-deploy-backups/BEFORE.json.after.json \
  --report /var/lib/bubble-online-deploy-backups/NEW_RECONCILIATION.json
```

脚本依赖现有部署布局，应先读源码核对路径。保全结论仅针对实际观测时间点；后续正常查询可能执行过期状态整理，不能把一次通过理解为数据库永远不再变化。
