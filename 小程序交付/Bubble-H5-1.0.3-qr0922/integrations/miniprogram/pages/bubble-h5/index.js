// Copy this NEW page into the maintained 1.0.5 source project when it is available.
// Set a fixed, verified business-domain URL. Never accept a destination URL from query parameters.
const H5_URL = 'https://h5.example.com/bubble/';
const PAGE_PATH = '/pages/bubble-h5/index';
const ROUTES = ['/home', '/prize', '/rules', '/staff'];
Page({
  data: {src: '', loading: true, error: ''},
  onLoad(options) {
    this.returnRoute = ROUTES.indexOf(options.return_route) >= 0 ? options.return_route : '/home';
    this.openActivity();
  },
  openActivity() {
    if (this.loggingIn) return;
    if (H5_URL.indexOf('https://h5.example.com/') === 0 || !/^https:\/\/[^?#]+\/$/.test(H5_URL)) {
      this.setData({loading: false, error: '活动网页地址尚未配置'});
      return;
    }
    this.loggingIn = true;
    this.setData({loading: true, error: '', src: ''});
    wx.login({
      timeout: 10000,
      success: result => {
        if (!result.code) { this.setData({loading: false, error: '微信登录未完成，请重试'}); return; }
        // The temporary code stays in the fragment. The H5 immediately erases it before rendering.
        const fragment = '#/home?wx_code=' + encodeURIComponent(result.code) + '&return_route=' + encodeURIComponent(this.returnRoute);
        this.setData({src: H5_URL + fragment, loading: false});
      },
      fail: () => this.setData({loading: false, error: '微信登录未完成，请重试'}),
      complete: () => { this.loggingIn = false; }
    });
  },
  handleError() {
    // Never log event.detail: the failing URL may contain the one-time login code.
    this.setData({src: '', loading: false, error: '活动网页暂时无法打开，请稍后重试'});
  },
  onShareAppMessage() { return {title: 'Bubble · 此刻在地', path: PAGE_PATH}; },
  onShareTimeline() { return {title: 'Bubble · 此刻在地', query: ''}; }
});
