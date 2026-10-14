// 同源部署：API 经 nginx /huodong-api/ 前缀代理到本服务，页面与接口同域。
window.BUBBLE_H5_CONFIG = Object.freeze({
  mode: 'production',
  apiBase: '/huodong-api',
  miniProgramLoginPage: '/pages/bubble-h5/index'
});
