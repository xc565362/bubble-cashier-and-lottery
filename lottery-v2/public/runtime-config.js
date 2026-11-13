// 同源部署：H5 静态页与活动 API 同域。API 基地址不再固定——页面在运行时从 URL
// 的 ?a=<uuid> 查询参数解析活动 id（该 H5 按活动部署在
// /huodong-<uuid>/?a=<uuid>，见 app.mjs 与 core.mjs 的 resolveActivityId），
// 拼接为 /activity/<uuid>（session / call，相对当前 origin）。
window.BUBBLE_H5_CONFIG = Object.freeze({
  mode: 'production',
  miniProgramLoginPage: '/pages/webview/webview'
});
