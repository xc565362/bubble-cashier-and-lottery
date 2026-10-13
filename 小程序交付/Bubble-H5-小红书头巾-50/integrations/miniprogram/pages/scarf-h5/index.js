// Integrate this NEW page into the maintained source of the original AppID.
// The target must be fixed and verified. Do not accept an H5 URL from options or scene.
const H5_URL = 'https://h5.example.com/scarf/';
const PAGE_PATH = '/pages/scarf-h5/index';
const ROUTES = ['/home', '/result', '/rules', '/staff'];
Page({
  data: {src: '', loading: true, error: ''},
  onLoad(options) {
    this.returnRoute = ROUTES.indexOf(options.return_route) >= 0 ? options.return_route : '/home';
    let scene = '';
    try { scene = decodeURIComponent(options.scene || ''); } catch {}
    const candidate = /^s_[A-F0-9]{16}$/.test(scene) ? scene.slice(2) : options.inviteCode;
    this.inviteCode = typeof candidate === 'string' && /^[A-F0-9]{16}$/.test(candidate) ? candidate : '';
    this.openActivity();
  },
  openActivity() {
    if (this.loggingIn) return;
    if (H5_URL.indexOf('https://h5.example.com/') === 0 || !/^https:\/\/[^?#]+\/$/.test(H5_URL)) { this.setData({loading: false, error: '活动网页地址尚未配置'}); return; }
    this.loggingIn = true;
    this.setData({loading: true, error: '', src: ''});
    wx.login({
      timeout: 10000,
      success: result => {
        if (!result.code) { this.setData({loading: false, error: '微信登录未完成，请重试'}); return; }
        const fragment = '#/home?wx_code=' + encodeURIComponent(result.code) + '&return_route=' + encodeURIComponent(this.returnRoute) + (this.inviteCode ? '&inviteCode=' + encodeURIComponent(this.inviteCode) : '');
        this.setData({src: H5_URL + fragment, loading: false});
      },
      fail: () => this.setData({loading: false, error: '微信登录未完成，请重试'}),
      complete: () => { this.loggingIn = false; }
    });
  },
  handleError() { this.setData({src: '', loading: false, error: '活动网页暂时无法打开，请稍后重试'}); },
  // Shares never carry another person's one-time invitation or login credential.
  onShareAppMessage() { return {title: '山野有约 · Bubble', path: PAGE_PATH}; },
  onShareTimeline() { return {title: '山野有约 · Bubble', query: ''}; }
});
