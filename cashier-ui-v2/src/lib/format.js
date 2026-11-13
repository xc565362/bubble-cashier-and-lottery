export function money(value) {
  return Number(value || 0).toLocaleString('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    maximumFractionDigits: 2,
  });
}

export function clampNumber(value, min = 0, max = Number.POSITIVE_INFINITY) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

export function todayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function normalizeProductType(value, price = 0) {
  const text = String(value ?? '').trim().toLowerCase();
  if (['优惠券', '抵扣券', 'coupon'].includes(text)) return 'coupon';
  if (!text) return Number(price || 0) === 0 ? 'gift' : 'sale';
  if (['赠品', '赠送', '是', 'yes', 'true', '1', 'gift', 'free'].includes(text)) return 'gift';
  return 'sale';
}

export function productTypeLabel(type) {
  return type === 'coupon' ? '优惠券' : type === 'gift' ? '赠品' : '售卖品';
}

export function normalizePromoRules(items) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    id: item.id || crypto.randomUUID(),
    enabled: Boolean(item.enabled),
    mode: item.mode === 'choice' ? 'choice' : 'all',
    mainProductIds: Array.isArray(item.mainProductIds) && item.mainProductIds.length
      ? item.mainProductIds.map((productId) => String(productId || '')).filter(Boolean)
      : [String(item.mainProductId || '')].filter(Boolean),
    stackable: item.stackable ?? item.canStack ?? true,
    gifts: Array.isArray(item.gifts) && item.gifts.length
      ? item.gifts.map((gift) => ({
          productId: String(gift.productId || ''),
          qty: Math.max(1, Number(gift.qty || 1)),
        }))
      : [{
          productId: String(item.giftProductId || ''),
          qty: Math.max(1, Number(item.giftQty || 1)),
        }],
    startAt: String(item.startAt || ''),
    endAt: String(item.endAt || ''),
  }));
}

export function isPromoRuleActive(rule, now = new Date()) {
  if (!rule?.enabled) return false;
  const time = now.getTime();
  const start = rule.startAt ? new Date(rule.startAt).getTime() : null;
  const end = rule.endAt ? new Date(rule.endAt).getTime() : null;
  if (Number.isFinite(start) && start > time) return false;
  if (Number.isFinite(end) && end < time) return false;
  return true;
}

export function escapeCsv(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => String(value).trim())) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some((value) => String(value).trim())) rows.push(row);
  return rows;
}

export async function readCsvFile(file) {
  const buffer = await file.arrayBuffer();
  const utf8Text = new TextDecoder('utf-8').decode(buffer);
  if (!utf8Text.includes('\uFFFD')) return utf8Text;

  try {
    return new TextDecoder('gb18030').decode(buffer);
  } catch {
    return new TextDecoder('gbk').decode(buffer);
  }
}

export function imageFileToDataUrl(file, maxSize = 640, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('图片格式不支持'));
      image.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      image.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
}

export const headerAliases = {
  name: ['产品名称', '商品名称', '名称', '品名', '商品名', 'name'],
  barcode: ['条码', '条形码', '商品条码', 'barcode', 'bar code'],
  sku: ['货品编码', '商品编码', '编码', 'sku', 'spu', '货号'],
  originalPrice: ['原价', '吊牌价', '市场价', 'originalprice', 'original price'],
  price: ['售价', '销售价', '零售价', '价格', 'price'],
  stock: ['库存数量', '库存', '数量', 'stock', 'qty', 'quantity'],
  group: ['商品分组', '产品分组', '分组', '分类', '类别', '类目', 'group', 'category'],
  imageUrl: ['商品图片', '产品图片', '图片', '图片链接', '图片地址', 'image', 'imageurl', 'image url'],
  productType: ['商品类型', '产品类型', '类型', '售卖类型', '是否赠品', '是否售卖品', 'producttype', 'product type', 'type'],
  couponAmount: ['优惠券金额', '抵扣金额', '优惠券面额', '券面额', 'couponamount', 'coupon amount'],
  giftEligible: ['可参与买赠', '参与买赠', '可赠送', 'gifteligible', 'gift eligible'],
};

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[：:]/g, '');
}

export function rowsToProducts(rows, giftEligibility) {
  if (!rows.length) return [];
  const headers = rows[0].map(normalizeHeader);
  const indexes = {};

  Object.entries(headerAliases).forEach(([field, aliases]) => {
    const normalizedAliases = aliases.map(normalizeHeader);
    indexes[field] = headers.findIndex((header) => normalizedAliases.includes(header));
  });

  if (indexes.name < 0 || indexes.barcode < 0 || (indexes.price < 0 && indexes.couponAmount < 0)) {
    throw new Error('导入文件至少需要包含：产品名称、条码、售价（优惠券可用抵扣金额）');
  }

  return rows.slice(1).reduce((list, row) => {
    const importedPrice = Number(row[indexes.price] || 0);
    const productType = indexes.productType >= 0
      ? normalizeProductType(row[indexes.productType], importedPrice)
      : normalizeProductType('', importedPrice);
    const product = {
      id: crypto.randomUUID(),
      name: String(row[indexes.name] || '').trim(),
      barcode: String(row[indexes.barcode] ?? '').trim(),
      sku: indexes.sku >= 0 ? String(row[indexes.sku] || '').trim() : '',
      group: indexes.group >= 0 ? String(row[indexes.group] || '').trim() || '未分组' : '未分组',
      imageUrl: indexes.imageUrl >= 0 ? String(row[indexes.imageUrl] || '').trim() : '',
      productType,
      ...(indexes.giftEligible >= 0 ? { giftEligible: productType === 'gift' || (productType === 'sale' && giftEligibility(row[indexes.giftEligible])) } : {}),
      originalPrice: indexes.originalPrice >= 0 ? Number(row[indexes.originalPrice] || 0) : 0,
      price: productType !== 'sale' ? 0 : importedPrice,
      couponAmount: productType === 'coupon' && indexes.couponAmount >= 0 ? Number(row[indexes.couponAmount] || 0) : 0,
      stock: productType === 'coupon' ? 0 : indexes.stock >= 0 ? Number(row[indexes.stock] || 0) : 0,
    };

    if (productType === 'coupon' && (!Number.isFinite(product.couponAmount) || product.couponAmount <= 0)) throw new Error(`${product.name || '优惠券'} 请填写大于 0 的抵扣金额`);
    if (product.name && product.barcode && (product.productType !== 'sale' || product.price > 0)) {
      if (!Number.isFinite(product.price) || !Number.isSafeInteger(product.stock) || product.stock < 0) throw new Error(`${product.name} 的价格或库存无效`);
      list.push(product);
    }

    return list;
  }, []);
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function downloadJson(value, name) {
  downloadBlob(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }), name);
}

export function downloadCsv(rows, name) {
  const lines = rows.map((row) => row.map(escapeCsv).join(',')).join('\n');
  downloadBlob(new Blob([`﻿${lines}`], { type: 'text/csv;charset=utf-8' }), name);
}
