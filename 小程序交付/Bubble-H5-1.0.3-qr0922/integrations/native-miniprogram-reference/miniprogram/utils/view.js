function date(value) {
  if (!value) return '以活动现场公示为准';
  const d = new Date(value);
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function entry(value) {
  if(!value)return value;
  const statusLabel=value.status==='pending'?(value.checkoutCoupon?'可使用 · 购物抵扣':'待核销 · 现场领取'):
    value.status==='using'?'使用中 · 收银结算中':value.status==='issuing'?'奖品已确认 · 正在发券':value.status==='unavailable'?'券状态待同步':value.status==='not_started'?'尚未到使用时间':value.status==='redeemed'?'已核销':value.status==='voided'?'已作废':'已过期';
  return {...value,statusLabel,formattedCode:value.checkoutCoupon?value.code:(String(value.code||'').match(/.{1,4}/g)||[]).join(' '),createdLabel:date(value.createdAt),redeemedLabel:date(value.redeemedAt),expiresLabel:date(value.expiresAt),minimumLabel:value.minimumGoodsAmountCents>0?'商品优惠后满 '+(value.minimumGoodsAmountCents/100).toFixed(2)+' 元可用':'无最低消费门槛'};
}
function campaign(value) {return {...value, venue:String(value.venue || '').replace(/bubble/gi,'Bubble'), cashTerms:String(value.cashTerms || '').replace(/bubble/gi,'Bubble'), startLabel:date(value.startsAt), endLabel:date(value.endsAt), redeemLabel:date(value.redeemEndsAt)};}
module.exports={date,entry,campaign};
