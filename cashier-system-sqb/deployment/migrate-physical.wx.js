/* 在活动管理员微信登录的开发者工具控制台粘贴本函数；随后传入原始 entries 文档 ID。
 * 此文件只定义函数，不自动执行迁移。不要放入小程序前端发布包。
 * 后端会重新读取每条原记录并校验身份、活动、旧码与状态。
 */
async function migrateBubblePhysical(entryIds) {
  if(!Array.isArray(entryIds)||entryIds.some(id=>typeof id!=='string'||!id||id.length>120))throw Error('需要原始中奖记录 ID 数组');
  const ids=[...new Set(entryIds)],results=[];
  // Acknowledge each record before advancing; avoid a long batch in short-lived cloud calls.
  for(let offset=0;offset<ids.length;offset+=1){
    const r=await wx.cloud.callFunction({name:'lottery',config:{env:'bubble-lottery-500-d8cd9c6a45992'},data:{action:'migratePhysical',payload:{entryIds:ids.slice(offset,offset+1)}}});
    if(!r.result?.ok)throw Error(r.result?.message||'迁移调用未完成，请核对本次批次');
    const batch=r.result.data.entries;results.push(...batch);
    if(batch.some(e=>!['pending','redeemed','expired','not_physical'].includes(e.status)))throw Error('存在未完成记录，请核对并重试同一批次：'+JSON.stringify(batch));
  }
  return results;
}
