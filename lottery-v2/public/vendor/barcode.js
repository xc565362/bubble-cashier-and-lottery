(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./jsbarcode'));
  else root.LotteryBarcode = factory(root.JsBarcode);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (JsBarcode) {
  function layout(code, width, height) {
    if (typeof code !== 'string' || !/^(?:[0-9A-F]{16}|LJC1_[0-9A-F]{32})$/i.test(code)) throw new Error('请输入完整的奖品核销码或购物券码');
    if (!Number.isFinite(width) || !Number.isFinite(height) || height < 24) throw new Error('条形码尺寸无效');
    const data = {};
    JsBarcode(data, code.toUpperCase(), {format:'CODE128B', displayValue:false});
    const bits = data.encodings.map(item => item.data).join('');
    const moduleWidth = Math.floor(width / (bits.length + 20));
    if (moduleWidth < 1) throw new Error('条形码宽度不足，请使用下方文字核销码');
    const pixels = Math.floor(width), top = 8, bottom = Math.floor(height) - 8;
    const offset = Math.floor((pixels - bits.length * moduleWidth) / 2);
    const bars = [];
    for (let i = 0; i < bits.length;) {
      if (bits[i] !== '1') { i++; continue; }
      const start = i;
      while (bits[i] === '1') i++;
      bars.push({x:offset + start * moduleWidth, y:top, width:(i-start) * moduleWidth, height:bottom-top});
    }
    return {width:pixels, height:Math.floor(height), moduleWidth, bars};
  }
  function svg(code, width = 300, height = 90) {
    const drawing = layout(code, width, height);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${drawing.width} ${drawing.height}" role="img" aria-label="奖品核销条形码" shape-rendering="crispEdges">` +
      `<rect width="${drawing.width}" height="${drawing.height}" fill="#fff"/>` + drawing.bars.map(bar =>
        `<rect x="${bar.x}" y="${bar.y}" width="${bar.width}" height="${bar.height}" fill="#000"/>`).join('') + '</svg>';
  }
  return {layout, svg};
});
