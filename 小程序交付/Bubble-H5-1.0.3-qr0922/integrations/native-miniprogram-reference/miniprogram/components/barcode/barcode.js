const barcode = require('../../lib/barcode');
Component({
  properties:{code:{type:String,observer(){if(this._ready)this.paint();}}},
  data:{error:''},
  lifetimes:{ready(){this._ready=true;this.paint();},detached(){this._ready=false;}},
  methods:{paint(){
    this.createSelectorQuery().select('#barcode').fields({node:true,size:true}).exec(result=>{
      if(!this._ready || !result[0] || !result[0].node)return;
      const {node:canvas,width,height}=result[0];
      const ratio=wx.getWindowInfo?wx.getWindowInfo().pixelRatio:wx.getSystemInfoSync().pixelRatio;
      canvas.width=Math.floor(width*ratio);canvas.height=Math.floor(height*ratio);
      const ctx=canvas.getContext('2d');
      ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
      this.setData({error:''});
      if(!this.data.code)return;
      try{
        const drawing=barcode.layout(this.data.code,canvas.width,canvas.height);
        ctx.fillStyle='#000';
        drawing.bars.forEach(bar=>ctx.fillRect(bar.x,bar.y,bar.width,bar.height));
      }catch(error){this.setData({error:'条形码暂无法显示，请使用下方文字核销码'});}
    });
  }}
});
