const settings = require('../settings');
const { createDemo } = require('../lib/demo');
let demo;
async function call(action, payload = {}) {
  const startupError = getApp().globalData.startupError;
  if (startupError) throw new Error(startupError);
  if (settings.mode === 'demo') {
    if (!demo) demo = createDemo(() => wx.getStorageSync('bubble-demo-v1') || {}, value => wx.setStorageSync('bubble-demo-v1', value));
    return demo(action, payload);
  }
  let response;
  try { response = await wx.cloud.callFunction({name:'lottery',data:{action,payload}}); }
  catch (error) { throw new Error('网络连接失败，请重试；已中奖结果会为你保留'); }
  const result = response.result;
  if (!result || !result.ok) throw new Error(result && result.message || '活动服务暂不可用，请稍后重试');
  return result.data;
}
function resetDemo() {
  if (settings.mode !== 'demo') return;
  wx.removeStorageSync('bubble-demo-v1'); demo = null;
}
function report(error) { wx.showModal({title:'温馨提示',content:error.message || '请求失败，请重试',showCancel:false}); }
module.exports = {call, resetDemo, report, isDemo:settings.mode==='demo'};
