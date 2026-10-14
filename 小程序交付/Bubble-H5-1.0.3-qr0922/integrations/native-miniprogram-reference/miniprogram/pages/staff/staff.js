const api=require('../../utils/api');const view=require('../../utils/view');
Page({
  data:{loading:true,error:'',allowed:false,code:'',entry:null,busy:false,isDemo:api.isDemo,openId:''},
  onLoad(){this.authorize();},
  async authorize(){this.setData({loading:true,error:''});try{const identity=await api.call('identity');this.setData({allowed:identity.isAdmin,openId:identity.openId});}catch(error){this.setData({error:error.message});}finally{this.setData({loading:false});}},
  input(event){this.setData({code:event.detail.value,entry:null});},
  copyIdentity(){wx.setClipboardData({data:this.data.openId});},
  async activityCode(){
    if(this.data.isDemo)return api.report(new Error('正式活动码需要在现有 Bubble 小程序中发布抽奖页面后生成。当前演示不生成可扫码参与的活动码。'));
    if(this.data.busy)return;
    this.setData({busy:true});
    try{const code=await api.call('activityCode');const file=await wx.cloud.downloadFile({fileID:code.fileID});await wx.previewImage({urls:[file.tempFilePath],current:file.tempFilePath});}
    catch(error){api.report(error);}finally{this.setData({busy:false});}
  },
  async scan(){if(this.data.busy)return;try{const result=await wx.scanCode({onlyFromCamera:true,scanType:['barCode','qrCode']});this.setData({code:result.result,entry:null});await this.lookup();}catch(error){if(!String(error.errMsg||'').includes('cancel'))api.report(new Error('扫码失败，请重试或手动输入核销码'));}},
  async lookup(){if(this.data.busy)return;this.setData({busy:true,entry:null});try{const result=await api.call('lookup',{code:this.data.code});this.setData({entry:view.entry(result)});}catch(error){api.report(error);}finally{this.setData({busy:false});}},
  async redeem(){
    if(this.data.busy||!this.data.entry||this.data.entry.checkoutCoupon||this.data.entry.status!=='pending')return;
    const entry=this.data.entry;
    this.setData({busy:true});
    try{
      const confirmed=await wx.showModal({title:'确认核销并发放',content:`奖品：${entry.prize.name}\n核销码：${entry.formattedCode}\n核销后无法再次领取，请确认奖品已准备妥当。`,confirmText:'确认核销',confirmColor:'#c93613'});
      if(!confirmed.confirm)return;
      const result=await api.call('redeem',{code:entry.code});
      this.setData({entry:view.entry(result)});
      wx.showModal({title:result.alreadyRedeemed?'请勿重复发放':'核销成功',content:result.alreadyRedeemed?'此奖品已完成核销，请核对记录。':`请发放：${result.prize.name}`,showCancel:false});
    }catch(error){api.report(error);}finally{this.setData({busy:false});}
  }
});
