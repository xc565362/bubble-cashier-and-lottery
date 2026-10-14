const config=require('../../lib/config');
const api=require('../../utils/api');
Page({
  data:{loading:true,error:'',grid:[],entry:null,campaign:config.campaign,inventory:null,activeId:'',drawing:false,result:null,showResult:false,isDemo:api.isDemo,drawError:''},
  onShow(){this._visible=true;this.load();},
  onHide(){this._visible=false;},
  onUnload(){this._visible=false;},
  async load(){
    this.setData({loading:true,error:''});
    try{const state=await api.call('state');this.setData({entry:state.entry,campaign:state.campaign,inventory:state.inventory,drawError:state.drawError||'',grid:config.gridOrder.map(id=>id==='draw'?{id:'draw'}:state.prizes.find(p=>p.id===id))});}
    catch(error){this.setData({error:error.message});}
    finally{this.setData({loading:false});}
  },
  async draw(){
    if(this.data.drawing||this.data.loading||this.data.error)return;
    if(this.data.entry)return this.openPrize();
    if(this.data.drawError)return api.report(new Error(this.data.drawError));
    this.setData({drawing:true});
    try{
      const result=await api.call('draw');
      const destination=config.ringOrder.indexOf(result.prize.id),steps=24+destination+1;
      for(let i=0;i<steps&&this._visible;i++){
        this.setData({activeId:config.ringOrder[i%8]});
        await new Promise(resolve=>setTimeout(resolve,i>steps-7?100+(i-(steps-7))*25:48));
      }
      this.setData({entry:result,result,showResult:this._visible});
      try { const fresh=await api.call('state');this.setData({inventory:fresh.inventory,drawError:fresh.drawError||''}); } catch (_) { this.setData({inventory:null}); }
    }catch(error){api.report(error);}
    finally{this.setData({drawing:false,activeId:''});}
  },
  openPrize(){if(!this.data.drawing)wx.redirectTo({url:'/pages/prize/prize'});},
  openRules(){if(!this.data.drawing)wx.redirectTo({url:'/pages/rules/rules'});},
  closeResult(){this.setData({showResult:false});},
  async resetDemo(){const result=await wx.showModal({title:'重置演示',content:'清除本机演示奖品记录，重新体验抽奖。'});if(result.confirm){api.resetDemo();this.load();}},
  noop(){}
});
