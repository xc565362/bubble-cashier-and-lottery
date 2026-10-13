import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import zxing from '@zxing/library';
import {drawBarcode} from '../public/qr.mjs';

const library={};
vm.runInNewContext(fs.readFileSync(new URL('../public/vendor/jsbarcode.js',import.meta.url),'utf8'),library);
const {MultiFormatReader,RGBLuminanceSource,HybridBinarizer,BinaryBitmap,DecodeHintType,BarcodeFormat}=zxing;
const codes=[
  '0123456789ABCDEF','0123456789abcdef',
  'LJC1_0123456789ABCDEF0123456789ABCDEF',
  'ljc1_0123456789abcdef0123456789abcdef',
  'LjC1_0123456789aBcDeF0123456789AbCdEf'
];

function encodedBits(code){
  const result={};library.JsBarcode(result,code,{format:'CODE128B',displayValue:false});
  return result.encodings.map(value=>value.data).join('');
}

function pixelCanvas(cssWidth){
  let width=0,height=0,pixels=new Uint8ClampedArray();
  const rects=[];
  const canvas={parentElement:{clientWidth:cssWidth+12},style:{},rects,
    getContext(type){assert.equal(type,'2d');return context;},
    get width(){return width;},set width(value){width=value;pixels=new Uint8ClampedArray(width*height);rects.length=0;},
    get height(){return height;},set height(value){height=value;pixels=new Uint8ClampedArray(width*height);rects.length=0;},
    pixels(){return pixels;}
  };
  const context={fillStyle:'#000',fillRect(x,y,w,h){
    assert.ok([x,y,w,h].every(Number.isSafeInteger),'all drawn edges must be device-pixel aligned');
    assert.ok(x>=0&&y>=0&&x+w<=width&&y+h<=height,'drawing fits the canvas');
    const black=this.fillStyle==='#000';
    if(black)rects.push([x,y,w,h]);
    for(let row=y;row<y+h;row++)pixels.fill(black?0:255,row*width+x,row*width+x+w);
  }};
  return canvas;
}

function withDevice(ratio,callback){
  const original=globalThis.window;
  globalThis.window={devicePixelRatio:ratio,JsBarcode:library.JsBarcode};
  try{return callback();}finally{
    if(original===undefined)delete globalThis.window;else globalThis.window=original;
  }
}

test('CODE128 pixels decode exact 16/37 character tokens at CSS widths 240–400 and DPR 1/2/3',()=>{
  let decodedCount=0,rejectedCount=0;
  for(const code of codes)for(const cssWidth of [240,280,320,360,400])for(const ratio of [1,2,3]){
    const canvas=pixelCanvas(cssWidth),bits=encodedBits(code);
    const available=Math.floor(cssWidth*ratio),module=Math.floor(available/(bits.length+20));
    if(module<1){
      withDevice(ratio,()=>assert.throws(()=>drawBarcode(canvas,code),/横屏.*二维码/));
      assert.equal(canvas.width,0);assert.equal(canvas.height,0);assert.equal(canvas.rects.length,0);
      rejectedCount++;continue;
    }
    withDevice(ratio,()=>drawBarcode(canvas,code));
    assert.equal(canvas.width,available);
    assert.equal(Number.parseFloat(canvas.style.width)*ratio,canvas.width);
    assert.equal(Number.parseFloat(canvas.style.height)*ratio,canvas.height);
    assert.ok(canvas.rects.length>0);
    assert.ok(canvas.rects.every(([, ,width])=>width===module&&width>=1));
    const left=canvas.rects[0][0],last=canvas.rects.at(-1),right=canvas.width-last[0]-last[2];
    assert.ok(left>=10*module,'left quiet zone is at least 10 modules');
    assert.ok(right>=10*module,'right quiet zone is at least 10 modules');
    const bitmap=new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(canvas.pixels(),canvas.width,canvas.height)));
    const decoded=new MultiFormatReader().decode(bitmap,new Map([[DecodeHintType.POSSIBLE_FORMATS,[BarcodeFormat.CODE_128]]])).getText();
    assert.equal(decoded,code);
    decodedCount++;
  }
  assert.equal(decodedCount,60);assert.equal(rejectedCount,15);
});

test('DPR 1 long-code boundary fails before drawing and succeeds at one pixel per module',()=>{
  const code=codes[2],minimum=encodedBits(code).length+20;
  const insufficient=pixelCanvas(minimum-1),exact=pixelCanvas(minimum);
  withDevice(1,()=>{
    assert.throws(()=>drawBarcode(insufficient,code),/横屏.*二维码/);
    drawBarcode(exact,code);
  });
  assert.equal(insufficient.width,0);assert.equal(insufficient.rects.length,0);
  assert.equal(exact.rects[0][0],10);assert.ok(exact.rects.every(([, ,width])=>width===1));
  const bitmap=new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(exact.pixels(),exact.width,exact.height)));
  assert.equal(new MultiFormatReader().decode(bitmap,new Map([[DecodeHintType.POSSIBLE_FORMATS,[BarcodeFormat.CODE_128]]])).getText(),code);
});

test('failed narrow or invalid-code redraw clears the previously scannable token',()=>{
  const canvas=pixelCanvas(320);
  withDevice(2,()=>drawBarcode(canvas,codes[2]));assert.ok(canvas.rects.length>0);
  withDevice(1,()=>assert.throws(()=>drawBarcode(canvas,codes[2]),/横屏.*二维码/));
  assert.equal(canvas.width,0);assert.equal(canvas.height,0);assert.equal(canvas.rects.length,0);
  withDevice(2,()=>drawBarcode(canvas,codes[0]));assert.ok(canvas.rects.length>0);
  withDevice(2,()=>assert.throws(()=>drawBarcode(canvas,'invalid-token'),/领取码暂无法显示/));
  assert.equal(canvas.width,0);assert.equal(canvas.height,0);assert.equal(canvas.rects.length,0);
});
