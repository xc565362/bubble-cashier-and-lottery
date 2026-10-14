const qrcode=require('../../lib/qrcode');
Component({
  properties:{code:{type:String,observer(){if(this._ready)this.paint();}}},
  data:{error:''},
  lifetimes:{ready(){this._ready=true;this.paint();},detached(){this._ready=false;}},
  methods:{
    onCanvasError(){if(this._ready)this.setData({error:'二维码暂无法显示'});},
    paint(){
    this.createSelectorQuery().select('#qr').fields({node:true,size:true}).exec(result=>{
      if(!this._ready)return;
      if(!result[0]||!result[0].node){this.onCanvasError();return;}
      try{
        const {node:canvas,width,height}=result[0];
        const ratio=wx.getWindowInfo?wx.getWindowInfo().pixelRatio:wx.getSystemInfoSync().pixelRatio;
        const pixels=Math.floor(Math.min(width,height)*ratio);
        if(!Number.isFinite(pixels)||pixels<1)throw new Error('Invalid canvas size');
        canvas.width=canvas.height=pixels;
        const ctx=canvas.getContext('2d');
        ctx.fillStyle='#fff';ctx.fillRect(0,0,pixels,pixels);
        this.setData({error:''});
        const code=this.data.code;
        if(!code)return;
        if(!/^(?:LJC1_[0-9A-F]{32}|[0-9A-F]{16})$/i.test(code))throw new Error('Invalid award code');
        const qr=qrcode(0,'M');
        // The cashier receives the original token, without a URL or legacy prefix.
        qr.addData(code);qr.make();
        const count=qr.getModuleCount(),cell=Math.floor(pixels/(count+8));
        if(cell<1)throw new Error('Canvas too small');
        const offset=Math.floor((pixels-count*cell)/2);
        ctx.fillStyle='#000';
        for(let y=0;y<count;y++)for(let x=0;x<count;x++)if(qr.isDark(y,x))ctx.fillRect(offset+x*cell,offset+y*cell,cell,cell);
      }catch(error){this.onCanvasError();}
    });
  }}
});
