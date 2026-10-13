# 历史部署与维护脚本

本目录保留既有部署、迁移、核验及收尾源码，方便维护人员理解旧版本。它们不是新项目的一键部署工具，不由 npm install、npm test 或预览命令自动执行。

这些脚本曾针对特定活动、日期、目录、券中心和迁移阶段编写，部分操作会调整云端配置、创建券、备份经营数据、修改 SSH 授权或删除历史维护文件。运行前必须逐行审查逻辑和输入，完成当前环境的备份、目标身份核对及人工授权；不能直接对生产运行，也不能仅填写环境变量就视为具备执行条件。

## 此次源码导出的处理

以下四个脚本已在导出副本中移除原生产地址、中心身份、云域名或 SSH 公钥。原工作目录中的文件未修改。变量不设默认生产值，缺失或格式不正确时，在读取私有备份、联网或写入之前终止。

| 脚本 | 必须显式配置的环境变量 | 用途 |
| --- | --- | --- |
| configure-redemption-deadline.cjs | BUBBLE_EXPECTED_CENTER_URL、BUBBLE_EXPECTED_CENTER_ID | 预期的 HTTPS 券中心源地址和中心身份；必须与私有配置一致 |
| preflight-physical-cutover.cjs | BUBBLE_EXPECTED_CENTER_URL、BUBBLE_EXPECTED_CENTER_ID | 核对目标券中心；脚本仍依赖旧迁移备份及额外小程序源码 |
| prepare-lottery-management.cjs | BUBBLE_LOTTERY_MANAGEMENT_ORIGIN | 经人工核对的 HTTPS 管理服务源地址，不能包含路径、查询串或账号密码 |
| finish-deadline-maintenance.cjs | BUBBLE_MAINTENANCE_HOME | 明确的非根绝对维护目录；脚本仅适用于人工审查后的 Linux root 环境 |
| finish-deadline-maintenance.cjs backup | BUBBLE_COUPON_BACKUPS_DIR | 明确的非根绝对备份目录 |
| finish-deadline-maintenance.cjs revoke | BUBBLE_MAINTENANCE_SSH_PUBLIC_KEY | 待撤销 authorized_keys 项中的 Base64 公钥段，不是私钥，也不是整行 SSH 文本 |

原有固定活动日期、文件名、迁移阶段断言和命令行参数格式予以保留，防止脱敏时改变历史操作的含义。使用新活动时，须另外审查这些旧前提；不要通过删除断言来强行运行。

## 私有输入与输出

cloudbaserc.before.json、coupon-connection.json、发券配置、商户密钥、真实 .env、数据库、账本、备份及脚本生成的连接文件均由运维人员在仓库外提供和保存，不包含在源码导出中。产生的新配置包、券码、账号信息或备份也不得提交仓库。

## 验证范围

本次仅核对脱敏差异、环境变量守卫以及 JavaScript 语法，没有执行这些运维脚本，没有连接券中心、云环境或支付系统，也没有修改服务器文件。
