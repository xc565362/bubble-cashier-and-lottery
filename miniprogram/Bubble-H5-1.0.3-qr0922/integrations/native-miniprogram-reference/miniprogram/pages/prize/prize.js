const api=require('../../utils/api');
const view=require('../../utils/view');
Page({
  data:{loading:true,error:'',entry:null,campaign:{},isDemo:api.isDemo,codeMode:'qr'},
  onShow(){this._visible=true;this.setData({codeMode:'qr'});return this.load();},
  onHide(){this._visible=false;this.stopRefresh();},
  onUnload(){this._visible=false;this.stopRefresh();},
  stopRefresh(){if(this._refreshTimer)clearTimeout(this._refreshTimer);this._refreshTimer=null;},
  scheduleRefresh(){this.stopRefresh();if(this._visible&&this.data.entry&&['pending','using','issuing','unavailable','not_started'].includes(this.data.entry.status))this._refreshTimer=setTimeout(()=>this.load(true),3000);},
  async onPullDownRefresh(){await this.load();wx.stopPullDownRefresh();},
  async load(silent=false){
    if(this._loading)return;
    this._loading=true;
    if(silent!==true)this.setData({loading:true,error:''});
    try{
      const state=await api.call('state');
      if(this._visible)this.setData({entry:view.entry(state.entry),campaign:view.campaign(state.campaign),error:''});
    }catch(error){if(this._visible){if(this.data.entry&&this.data.entry.status!=='redeemed')this.setData({entry:view.entry({...this.data.entry,status:'unavailable',code:''})});else if(silent!==true)this.setData({error:error.message});}}
    finally{this._loading=false;if(this._visible){this.setData({loading:false});this.scheduleRefresh();}}
  },
  changeCodeMode(event){
    const mode=event.currentTarget.dataset.mode;
    if(this.data.entry&&this.data.entry.status==='pending'&&['qr','barcode'].includes(mode))this.setData({codeMode:mode});
  },
  goHome(){wx.redirectTo({url:'/pages/home/home'});},
  copy(){if(this.data.entry&&this.data.entry.status==='pending')wx.setClipboardData({data:this.data.entry.code});}
});
