const crypto=require('node:crypto');
const {fault}=require('./domain');
function createActivityCode({cloud,store,campaign,adminIds}){
  return async function generate(openId){
    if(!openId||!adminIds.includes(openId))throw fault('FORBIDDEN','仅授权工作人员可获取正式活动码');
    const page=campaign.entryPage,scene=campaign.entryScene;
    if(typeof page!=='string'||!/^[a-zA-Z0-9_/-]+$/.test(page)||page.startsWith('/')||typeof scene!=='string'||!/^[a-zA-Z0-9_-]{1,32}$/.test(scene))throw fault('INVALID_CONFIG','请配置有效的抽奖页面路径和固定场景标识');
    const key='entry-'+crypto.createHash('sha256').update(page+':'+scene+':release').digest('hex').slice(0,24);
    const cached=await store.transaction(tx=>tx.get('codes',key));
    if(cached&&cached.fileID)return cached;
    let image;
    try{image=await cloud.openapi.wxacode.getUnlimited({page,scene,checkPath:true,envVersion:'release',width:1280,autoColor:false,lineColor:{r:24,g:20,b:29},isHyaline:false});}
    catch(error){
      // Only the numeric provider code is safe to expose to the authorized operator.
      const providerCode=String(error&&(error.errCode??error.code)||'');
      const diagnostic=/^-?\d{1,8}$/.test(providerCode)?`（微信错误码 ${providerCode}）`:'';
      throw fault('CODE_NOT_READY','活动码尚不可生成，请确认抽奖页面已发布且已开启小程序码云调用权限'+diagnostic);
    }
    if(!image||!Buffer.isBuffer(image.buffer)||image.buffer.length<8)throw fault('CODE_NOT_READY','微信尚未返回有效活动码，请先完成页面发布与云调用配置');
    const bytes=image.buffer;
    const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpg=bytes[0]===255&&bytes[1]===216;
    if(!png&&!jpg)throw fault('CODE_NOT_READY','活动码图像格式异常，请重试');
    const uploaded=await cloud.uploadFile({cloudPath:`activity-codes/bubble-${key}.${png?'png':'jpg'}`,fileContent:bytes});
    if(!uploaded.fileID)throw fault('CODE_NOT_READY','活动码保存失败，请稍后重试');
    const result={fileID:uploaded.fileID,page,scene,envVersion:'release',createdAt:Date.now()};
    await store.transaction(tx=>tx.set('codes',key,result));
    return result;
  };
}
module.exports={createActivityCode};
