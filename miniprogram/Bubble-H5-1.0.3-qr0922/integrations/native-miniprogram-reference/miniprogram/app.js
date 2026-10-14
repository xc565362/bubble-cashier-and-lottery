const settings = require('./settings');
App({
  globalData: { settings, startupError: '' },
  onLaunch() {
    const version = wx.getAccountInfoSync().miniProgram.envVersion;
    if (settings.mode === 'demo' && version !== 'develop') {
      this.globalData.startupError = '当前版本尚未配置正式活动，请联系主办方';
      return;
    }
    if (settings.mode === 'cloud') {
      if (!wx.cloud || !settings.cloudEnv) {
        this.globalData.startupError = '请先配置云开发环境';
        return;
      }
      wx.cloud.init({ env: settings.cloudEnv, traceUser: false });
    } else if (settings.mode !== 'demo') {
      this.globalData.startupError = '运行模式配置错误';
    }
  }
});
