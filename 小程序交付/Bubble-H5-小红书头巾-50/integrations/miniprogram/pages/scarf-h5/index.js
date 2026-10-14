// New native host page. Register this path in the maintained Mini Program.
// These CloudBase URLs are for developer verification until business-domain
// approval and the Mini Program release are complete. Never read a URL from options.
const H5_URL = 'https://bubble-lottery-500-d8cd9c6a45992-1491551026.tcloudbaseapp.com/scarf/';
const PAGE_PATH = '/pages/scarf-h5/index';
const CLOUD_ENV = 'bubble-lottery-500-d8cd9c6a45992';
const GATEWAY = 'bubble-scarf-gateway';
const LOGIN_MODE = 'cloud-ticket'; // Explicitly match the gateway environment.
const ROUTES = ['/home', '/result', '/rules', '/staff'];
Page({
  data: {src: '', loading: true, error: ''},
  onLoad(options = {}) {
    this.destroyed = false;
    this.returnRoute = ROUTES.indexOf(options.return_route) >= 0 ? options.return_route : '/home';
    let scene = ''; try { scene = decodeURIComponent(options.scene || ''); } catch {}
    const candidate = /^s_[A-F0-9]{16}$/.test(scene) ? scene.slice(2) : options.inviteCode;
    this.inviteCode = true && typeof candidate === 'string' && /^[A-F0-9]{16}$/.test(candidate) ? candidate : '';
    this.openActivity();
  },
  onUnload() { clearTimeout(this.loginTimer); this.destroyed = true; this.loginAttempt = (this.loginAttempt || 0) + 1; },
  openActivity() {
    if (this.loggingIn || this.destroyed) return;
    if (!/^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::443)?\/(?:[A-Za-z0-9_-]+\/)*$/.test(H5_URL) || H5_URL.includes('example.com')) { this.setData({loading: false, error: '活动网页地址尚未配置'}); return; }
    this.loggingIn = true; const attempt = this.loginAttempt = (this.loginAttempt || 0) + 1;
    const current = () => !this.destroyed && this.loginAttempt === attempt;
    const fail = () => { if (current()) this.setData({src: '', loading: false, error: '微信登录未完成，请重试'}); };
    const complete = () => { if (current()) { clearTimeout(this.loginTimer); this.loggingIn = false; } };
    const open = (field, value) => {
      if (!current()) return;
      const valid = field === 'wx_ticket' ? /^HT1\.[A-Za-z0-9_-]{43}$/.test(value || '') : /^[A-Za-z0-9_-]{8,256}$/.test(value || '');
      if (!valid) return fail();
      // Credentials stay in the fragment and the H5 removes them immediately.
      const fragment = '#/home?' + field + '=' + encodeURIComponent(value) + '&return_route=' + encodeURIComponent(this.returnRoute) + (this.inviteCode ? '&inviteCode=' + encodeURIComponent(this.inviteCode) : '');
      this.setData({src: H5_URL + fragment, loading: false});
    };
    this.setData({src: '', loading: true, error: ''});
    this.loginTimer = setTimeout(() => { if (current()) { fail(); complete(); this.loginAttempt++; } }, 18000);
    if (LOGIN_MODE === 'cloud-ticket') {
      if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') { fail(); complete(); return; }
      wx.cloud.callFunction({name: GATEWAY, config: {env: CLOUD_ENV}, data: {action: 'issueH5SessionTicket'},
        success: response => { const result = response && response.result; result && result.ok === true ? open('wx_ticket', result.data && result.data.ticket) : fail(); }, fail, complete});
    } else if (LOGIN_MODE === 'code2session') {
      wx.login({timeout: 10000, success: result => open('wx_code', result.code), fail, complete});
    } else { fail(); complete(); }
  },
  handleError() { this.setData({src: '', loading: false, error: '活动网页暂时无法打开，请稍后重试'}); },
  // Never share another person's credential or participation invitation.
  onShareAppMessage() { return {title: '山野有约 · Bubble', path: PAGE_PATH}; },
  onShareTimeline() { return {title: '山野有约 · Bubble', query: ''}; }
});