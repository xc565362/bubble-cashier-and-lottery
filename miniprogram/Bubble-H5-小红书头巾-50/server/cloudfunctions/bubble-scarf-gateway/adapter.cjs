'use strict';
const crypto = require('node:crypto');
const {createService, createCloudStore} = require('./service.cjs');
const ENTRY_PAGE = 'pages/scarf-h5/index';
const codeError = () => Object.assign(new Error('参与小程序码暂时无法生成，请确认入口页已发布并重试；客户抽奖资格尚未消耗'), {code: 'CODE_NOT_READY', status: 503, gatewayFault: true});
function createScarfAdapter({cloud, adminOpenIds, service, now = Date.now,center}) {
  const call = service || createService({store: createCloudStore(cloud.database()), adminOpenIds, now,center});
  return async (action, payload, openId) => {
    const result = await call(action, payload, openId);
    if (action !== 'grant') return result;
    // Authorization and one-time invitation creation happen in service before any provider call.
    try {
      const image = await cloud.openapi.wxacode.getUnlimited({page: ENTRY_PAGE, scene: 's_' + result.inviteCode, checkPath: true, envVersion: 'release', width: 430, autoColor: false, lineColor: {r: 30, g: 60, b: 50}, isHyaline: false});
      if (!image || (image.errCode !== undefined && image.errCode !== 0) || !Buffer.isBuffer(image.buffer) || image.buffer.length < 8 || image.buffer.length > 2 * 1024 * 1024) throw codeError();
      const bytes = image.buffer;
      const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpg = bytes[0] === 255 && bytes[1] === 216;
      if (!png && !jpg) throw codeError();
      const uploaded = await cloud.uploadFile({cloudPath: 'scarf-invites/' + crypto.randomBytes(20).toString('hex') + (png ? '.png' : '.jpg'), fileContent: bytes});
      if (!uploaded?.fileID) throw codeError();
      const temporary = await cloud.getTempFileURL({fileList: [{fileID: uploaded.fileID, maxAge: Math.max(1, Math.ceil((result.expiresAt - now()) / 1000))}]});
      const file = temporary?.fileList?.[0];
      if (!file || file.status !== 0 || file.fileID !== uploaded.fileID || typeof file.tempFileURL !== 'string') throw codeError();
      const url = new URL(file.tempFileURL);
      if (url.protocol !== 'https:' || url.username || url.password || now() >= result.expiresAt) throw codeError();
      return {...result, inviteQrUrl: url.href};
    } catch { throw codeError(); }
  };
}
module.exports = {ENTRY_PAGE, createScarfAdapter};
