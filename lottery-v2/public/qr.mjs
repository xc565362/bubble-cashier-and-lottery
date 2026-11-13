import {CODE_PATTERN} from './core.mjs';
export function qrLayout(code, pixels, factory) {
  if (!CODE_PATTERN.test(code || '') || !Number.isSafeInteger(pixels) || pixels<40) throw new Error('领取码暂无法显示，请刷新状态');
  const qr = factory(0,'M');
  qr.addData(code); qr.make();
  const count=qr.getModuleCount(),cell=Math.floor(pixels/(count+8));
  if (cell<1) throw new Error('显示空间不足，请放大页面');
  const offset=Math.floor((pixels-count*cell)/2),rects=[];
  for(let y=0;y<count;y++)for(let x=0;x<count;x++)if(qr.isDark(y,x))rects.push([offset+x*cell,offset+y*cell,cell,cell]);
  return {pixels,count,cell,offset,rects};
}
export function drawQr(canvas, code, factory = window.qrcode) {
  const css=Math.max(180,Math.min(240,Math.floor(canvas.parentElement.clientWidth-16)));
  const pixels=Math.floor(css*(window.devicePixelRatio||1));
  canvas.width=canvas.height=pixels; canvas.style.width=canvas.style.height=`${css}px`;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,pixels,pixels);
  const layout=qrLayout(code,pixels,factory);ctx.fillStyle='#000';
  for(const rect of layout.rects)ctx.fillRect(...rect);
}
export function drawBarcode(canvas, code) {
  // Clear an earlier token before validating or measuring, so a failed update cannot
  // leave a stale, scannable barcode behind.
  canvas.width=canvas.height=0;canvas.style.width=canvas.style.height='0px';
  if(!CODE_PATTERN.test(code||''))throw new Error('领取码暂无法显示');
  const css=Math.floor(canvas.parentElement.clientWidth-12),reportedRatio=Number(window.devicePixelRatio);
  const ratio=Number.isFinite(reportedRatio)&&reportedRatio>0?reportedRatio:1;
  const pixels=Math.floor(css*ratio);
  // Use the original library with the literal token; do not uppercase or prefix it.
  const encoded={};window.JsBarcode(encoded,code,{format:'CODE128B',displayValue:false});
  const bits=encoded.encodings.map(item=>item.data).join(''),cell=Math.floor(pixels/(bits.length+20));
  if(!Number.isSafeInteger(pixels)||pixels<1||cell<1)throw new Error('条形码显示空间不足，请横屏查看或使用二维码');
  canvas.width=pixels;canvas.height=Math.floor(112*ratio);
  // CSS dimensions correspond to actual device pixels, without forced oversampling
  // that a DPR 1 browser would shrink into subpixel modules.
  canvas.style.width=`${canvas.width/ratio}px`;canvas.style.height=`${canvas.height/ratio}px`;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#000';
  const offset=Math.floor((canvas.width-bits.length*cell)/2),margin=Math.floor(12*ratio);
  for(let i=0;i<bits.length;i++)if(bits[i]==='1')ctx.fillRect(offset+i*cell,margin,cell,canvas.height-2*margin);
}
