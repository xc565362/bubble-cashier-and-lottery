module.exports = {
  "campaign": {
    "id": "bubble-race-2026-500",
    "title": "此刻在地",
    "subtitle": "赛场同行",
    "entryPage": "pages/home/home",
    "entryScene": "bubble_lottery",
    "tagline": "每一份坚持，都值得一份好礼。",
    "venue": "贡嘎百公里越野赛现场 · bubble线下展位",
    "enabled": true,
    "inventory": {
      "version": 1,
      "total": 500,
      "quantities": {
        "cash50": 5,
        "cash30": 15,
        "cash10": 205,
        "cash5": 100,
        "cap": 10,
        "bucket": 15,
        "waist": 50,
        "tote": 100
      }
    },
    "startsAt": 1789574400000,
    "endsAt": 1790503200000,
    "redeemEndsAt": 1790524800000,
    "redemptionEndsAt": 1790503200000,
    "cashFulfilment": "checkout_coupon",
    "cashTerms": "立减金为 bubble 店铺购物抵扣券。先计算商品优惠，再抵扣券；每单限一张（含收银本地券）。抵扣不超过商品应收，不找零、不留余额。付款成功或确认零元结算后核销一次；取消未付款交易后可重新使用，支付结果待确认时保持占用。退款不自动退券，退款金额以原单分摊实付为限。适用门店和商品范围须在正式开放前公示。"
  },
  "prizes": [
    {
      "id": "cash50",
      "name": "50元立减金",
      "shortName": "50元立减金",
      "kind": "cash",
      "amount": 50,
      "probability": 1,
      "label": "惊喜大奖",
      "icon": "ticket"
    },
    {
      "id": "cash30",
      "name": "30元立减金",
      "shortName": "30元立减金",
      "kind": "cash",
      "amount": 30,
      "probability": 3,
      "label": "心动好礼",
      "icon": "ticket"
    },
    {
      "id": "cash10",
      "name": "10元立减金",
      "shortName": "10元立减金",
      "kind": "cash",
      "amount": 10,
      "probability": 41,
      "label": "赛场助力",
      "icon": "ticket"
    },
    {
      "id": "cash5",
      "name": "5元立减金",
      "shortName": "5元立减金",
      "kind": "cash",
      "amount": 5,
      "probability": 20,
      "label": "轻松加码",
      "icon": "ticket"
    },
    {
      "id": "cap",
      "name": "棒球帽",
      "shortName": "棒球帽",
      "kind": "physical",
      "probability": 2,
      "label": "出发装备",
      "icon": "cap"
    },
    {
      "id": "bucket",
      "name": "渔夫帽",
      "shortName": "渔夫帽",
      "kind": "physical",
      "probability": 3,
      "label": "户外搭档",
      "icon": "bucket"
    },
    {
      "id": "waist",
      "name": "腰包",
      "shortName": "腰包",
      "kind": "physical",
      "probability": 10,
      "label": "轻装随行",
      "icon": "waist"
    },
    {
      "id": "tote",
      "name": "超大号购物袋",
      "shortName": "超大号购物袋",
      "kind": "physical",
      "probability": 20,
      "label": "装下热爱",
      "icon": "tote"
    }
  ],
  "gridOrder": [
    "cash50",
    "cash30",
    "cap",
    "cash5",
    "draw",
    "bucket",
    "cash10",
    "tote",
    "waist"
  ],
  "ringOrder": [
    "cash50",
    "cash30",
    "cap",
    "bucket",
    "waist",
    "tote",
    "cash10",
    "cash5"
  ]
};
