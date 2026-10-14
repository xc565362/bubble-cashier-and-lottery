import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { shouldReserveAward } from './couponBarcode.js';
import { basketLineKey, isExternalPhysical, isExternalAward } from './orderLogic.js';
import { addLineToCart, canBePromoGift, giftEligibility, promoGiftLine } from './cartLogic.js';
import { createRoot } from 'react-dom/client';
import {
  Barcode,
  Camera,
  Check,
  Download,
  Dices,
  FileSpreadsheet,
  Gift,
  History,
  ImagePlus,
  Minus,
  Pause,
  Play,
  Pencil,
  PackagePlus,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  ShoppingCart,
  Tags,
  Ticket,
  Trash2,
  Upload,
  WalletCards,
  X,
} from 'lucide-react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import readXlsxFile from 'read-excel-file/browser';
import './styles.css';
import { completeOrder, reviseOrder, reconcileStock, priceOrder, isCompleted, isCoupon, orderSerial, orderExportRows, suspendBasket, retrieveBasket } from './orderLogic.js';
import { CouponManager } from './CouponManager.jsx';
import { LotteryWorkspace } from './ScarfManager.jsx';
import { sqbCall, SqbSettings, SqbPaymentModal, notifyConfirmedPayment, enablePaymentNotifications } from './sqb.jsx';
import { AfterSalesModal } from './AfterSalesModal.jsx';
import { applyAdjustment, validateAdjustmentStock, remainingLines, financialEvents, financialExportRows, orderNet, orderDisplayStatus, channelName, transactionTime, tenderTotals } from './afterSales.js';
import { createLedgerSearchIndex, queryLedger, LEDGER_SEARCH_FIELDS, LEDGER_SEARCH_GROUPS } from './ledgerSearch.js';
import { completeBrowserPayment, paymentReviewMessage, retainPaymentReview, shouldOpenPayment } from './paymentReview.js';
import { OnlineGate, OnlineAccountPage } from './OnlineGate.jsx';
import { onlineRequest } from './onlineApi.js';

const PRODUCT_KEY = 'stall_cashier_products_v2';
const LEGACY_PRODUCT_KEY = 'stall_cashier_products_v1';
const ORDER_KEY = 'stall_cashier_orders_v1';
const PAYMENT_QR_KEY = 'stall_cashier_payment_qr_v1';
const PROMO_RULE_KEY = 'stall_cashier_promo_rules_v1';
const LEDGER_KEY = 'stall_cashier_ledger_v2';

const starterProducts = [
  {
    id: crypto.randomUUID(),
    barcode: '6901028075763',
    sku: 'DRINK-001',
    group: '饮料',
    productType: 'sale',
    name: '示例饮料',
    originalPrice: 6,
    price: 5,
    stock: 20,
  },
  {
    id: crypto.randomUUID(),
    barcode: '6921168509256',
    sku: 'TISSUE-001',
    group: '日用品',
    productType: 'sale',
    name: '示例纸巾',
    originalPrice: 4,
    price: 3,
    stock: 30,
  },
  {
    id: crypto.randomUUID(),
    barcode: '6970123456789',
    sku: 'HANDMADE-001',
    group: '手作',
    productType: 'sale',
    name: '手作小物',
    originalPrice: 25,
    price: 18,
    stock: 12,
  },
];

const headerAliases = {
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

function normalizeProductType(value, price = 0) {
  const text = String(value ?? '').trim().toLowerCase();
  if (['优惠券', '抵扣券', 'coupon'].includes(text)) return 'coupon';
  if (!text) return Number(price || 0) === 0 ? 'gift' : 'sale';
  if (['赠品', '赠送', '是', 'yes', 'true', '1', 'gift', 'free'].includes(text)) return 'gift';
  return 'sale';
}

function productTypeLabel(type) {
  return type === 'coupon' ? '优惠券' : type === 'gift' ? '赠品' : '售卖品';
}

function normalizePromoRules(items) {
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

function isPromoRuleActive(rule, now = new Date()) {
  if (!rule?.enabled) return false;
  const time = now.getTime();
  const start = rule.startAt ? new Date(rule.startAt).getTime() : null;
  const end = rule.endAt ? new Date(rule.endAt).getTime() : null;
  if (Number.isFinite(start) && start > time) return false;
  if (Number.isFinite(end) && end < time) return false;
  return true;
}

function readStore(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function readInitialProducts() {
  const current = readStore(PRODUCT_KEY, null);
  if (current) return normalizeProducts(current);
  const legacy = readStore(LEGACY_PRODUCT_KEY, null);
  if (legacy) return normalizeProducts(legacy);
  return starterProducts;
}

function normalizeProducts(items) {
  return items.map((item) => {
    const productType = normalizeProductType(item.productType ?? item.type ?? item.isGift, item.price);
    return {
      id: item.id || crypto.randomUUID(),
      barcode: String(item.barcode ?? '').trim(),
      sku: String(item.sku || '').trim(),
      group: String(item.group || item.category || '未分组').trim() || '未分组',
      imageUrl: String(item.imageUrl || item.image || '').trim(),
      productType,
      giftEligible: productType === 'gift' || (productType === 'sale' && giftEligibility(item.giftEligible)),
      name: String(item.name || '').trim(),
      originalPrice: Number(item.originalPrice || item.price || 0),
      price: productType !== 'sale' ? 0 : Number(item.price || 0),
      couponAmount: productType === 'coupon' ? Number(item.couponAmount || 0) : 0,
      stock: Number(item.stock || 0),
    };
  });
}

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[：:]/g, '');
}

function money(value) {
  return Number(value || 0).toLocaleString('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    maximumFractionDigits: 2,
  });
}

function clampNumber(value, min = 0, max = Number.POSITIVE_INFINITY) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function todayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function escapeCsv(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function parseCsv(text) {
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

async function readCsvFile(file) {
  const buffer = await file.arrayBuffer();
  const utf8Text = new TextDecoder('utf-8').decode(buffer);
  if (!utf8Text.includes('\uFFFD')) return utf8Text;

  try {
    return new TextDecoder('gb18030').decode(buffer);
  } catch {
    return new TextDecoder('gbk').decode(buffer);
  }
}

function imageFileToDataUrl(file, maxSize = 640, quality = 0.82) {
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

function rowsToProducts(rows) {
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

function mergeProducts(current, incoming) {
  const next = [...current];
  incoming.forEach((product) => {
    const index = next.findIndex((item) => {
      if (product.barcode && item.barcode === product.barcode) return true;
      return !product.barcode && product.sku && item.sku === product.sku;
    });

    if (index >= 0) {
      next[index] = { ...next[index], ...product, id: next[index].id,
        giftEligible: product.productType === 'gift' || (product.productType === 'sale' &&
          (product.giftEligible === undefined ? canBePromoGift(next[index]) : product.giftEligible)) };
    } else {
      next.unshift(product);
    }
  });
  return next;
}

function App({ online = null }) {
  useEffect(() => {
    if (!online && 'serviceWorker' in navigator && /^https?:$/.test(window.location.protocol)) navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, []);
  const [ledger, setLedger] = useState(() => online ? online.initial.ledger : readStore(LEDGER_KEY, null) || {
    products: readInitialProducts(), orders: readStore(ORDER_KEY, []), heldCarts: [],
  });
  const ledgerRef = useRef(ledger);
  const cloudRevision = useRef(online?.initial.revision);
  const [lease, setLease] = useState(online?.initial.lease || null);
  const leaseRef = useRef(lease);
  const [cloudBusy, setCloudBusy] = useState(false), [cloudError, setCloudError] = useState('');
  const [cloudSyncRequired, setCloudSyncRequired] = useState(false);
  const cloudWorking = useRef(false), cloudRequest = useRef(null);
  const { products, orders, heldCarts = [] } = ledger;
  function saveLedger(next, silent = false) {
    if (online) { if (!silent) flash('在线账务必须由云端核对保存，请刷新后重试'); return false; }
    try {
      // Inventory, orders and held baskets are committed in one storage write.
      localStorage.setItem(LEDGER_KEY, JSON.stringify(next));
      ledgerRef.current = next;
      setLedger(next);
      return true;
    } catch {
      if (!silent) flash('保存失败：本机存储空间不足，请先释放空间。本地账务未保存');
      return false;
    }
  }
  function setProducts(update) {
    const current = ledgerRef.current;
    if (current.pendingPayment?.review) { flash('当前收款数据待核对，暂不能修改商品或库存'); return false; }
    return saveLedger({ ...current, products: typeof update === 'function' ? update(current.products) : update });
  }
  const [paymentQr, setPaymentQr] = useState(() => ledger.paymentQr ?? (online ? '' : localStorage.getItem(PAYMENT_QR_KEY)) ?? '');
  const [promoRules, setPromoRules] = useState(() => normalizePromoRules(ledger.promoRules ?? (online ? [] : readStore(PROMO_RULE_KEY, []))));
  const [cart, setCart] = useState([]);
  const [giftChoiceQueue, setGiftChoiceQueue] = useState([]);
  const [giftChoicePanelOpen, setGiftChoicePanelOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('cashier');
  const bottomNavRef = useRef(null);
  useLayoutEffect(() => {
    const navigation = bottomNavRef.current;
    const root = document.documentElement;
    // Reserve the measured height, including wrapped text and the device safe area.
    const updateHeight = () => root.style.setProperty('--bottom-nav-height', `${navigation.getBoundingClientRect().height}px`);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(navigation);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--bottom-nav-height');
    };
  }, []);
  const [activeGroup, setActiveGroup] = useState('全部');
  const [selectedOrderDate, setSelectedOrderDate] = useState(() => todayKey());
  const [ledgerSearch, setLedgerSearch] = useState({ field: '', keyword: '' });
  const [query, setQuery] = useState('');
  const [barcodeInput, setBarcodeInput] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [editingProduct, setEditingProduct] = useState(null);
  const [paymentOrder, setPaymentOrder] = useState(null);
  const paymentOrderRef = useRef(null); paymentOrderRef.current = paymentOrder;
  const [editingOrder, setEditingOrder] = useState(null);
  const [heldPanelOpen, setHeldPanelOpen] = useState(false);
  const [sqbSettingsOpen, setSqbSettingsOpen] = useState(false);
  const [sqbOrder, setSqbOrder] = useState(() => (!online || online.initial.lease?.mine) && shouldOpenPayment(ledger.pendingPayment) ? ledger.pendingPayment.draft : null);
  const sqbOrderRef = useRef(null); sqbOrderRef.current = sqbOrder;
  const [afterSalesOrder, setAfterSalesOrder] = useState(() => (!online || online.initial.lease?.mine) && ledger.pendingAdjustment ? { order: ledger.orders.find((item) => item.id === ledger.pendingAdjustment.parentId), type: ledger.pendingAdjustment.request.type } : null);
  const [recoveryMessage, setRecoveryMessage] = useState('');
  const [lastResult, setLastResult] = useState('');
  const [backupBusy, setBackupBusy] = useState(false);
  const backupWorking = useRef(false);
  const [restoreReady, setRestoreReady] = useState(!ledger.pendingRestore);
  const [startupReady, setStartupReady] = useState(Boolean(online));
  const pendingPayment = ledger.pendingPayment;
  const pendingAdjustment = ledger.pendingAdjustment;
  const [couponBusy, setCouponBusy] = useState(false);
  const [couponRecovery, setCouponRecovery] = useState(false);
  const couponWorking = useRef(false);
  const onlineLocked = Boolean(online && (!lease?.mine || cloudBusy || cloudSyncRequired || ledger.pendingZero || ledger.pendingCouponReservation || lease.recoveryRequired));
  const financiallyLocked = Boolean(onlineLocked || pendingPayment || pendingAdjustment || !restoreReady || !startupReady || backupBusy || couponBusy || couponRecovery);
  const reviewingPayment = Boolean(pendingPayment?.review && pendingPayment.record?.state === 'paid' && !sqbOrder
    && !pendingAdjustment && restoreReady && startupReady && !backupBusy && !couponBusy && !couponRecovery);
  const recovering = useRef(false);

  function acceptCloud(snapshot) {
    if (!snapshot?.ledger || !Number.isSafeInteger(snapshot.revision)) throw new Error('云端账本格式异常，请重试连接');
    cloudRevision.current = snapshot.revision;
    ledgerRef.current = snapshot.ledger; setLedger(snapshot.ledger);
    leaseRef.current = snapshot.lease; setLease(snapshot.lease);
    setPaymentQr(snapshot.ledger.paymentQr || ''); setPromoRules(normalizePromoRules(snapshot.ledger.promoRules || []));
    setRestoreReady(!snapshot.ledger.pendingRestore); setStartupReady(true);
    setCloudSyncRequired(false);
    if (!snapshot.lease?.mine) { setSqbOrder(null); setAfterSalesOrder(null); setEditingProduct(null); setEditingOrder(null); }
    return snapshot;
  }
  async function cloudCommand(type, payload = {}) {
    if (cloudWorking.current) throw new Error('云端操作正在保存，请稍候');
    if (!leaseRef.current?.mine) throw new Error('请先取得收银权限，再修改云端账务');
    cloudWorking.current = true; setCloudBusy(true); setCloudError('');
    const input = { type, payload, expectedRevision: cloudRevision.current };
    const fingerprint = JSON.stringify(input);
    if (cloudRequest.current?.fingerprint !== fingerprint) cloudRequest.current = { fingerprint, requestId: crypto.randomUUID() };
    try { return acceptCloud(await onlineRequest('command', { method: 'POST', body: { ...input, requestId: cloudRequest.current.requestId } })); }
    catch (issue) { setCloudError(issue.status === 409 ? `${issue.message}。请刷新云端数据后核对，未保存内容仍保留。` : issue.message); throw issue; }
    finally { cloudWorking.current = false; setCloudBusy(false); }
  }
  async function saveCloud(type, payload) {
    try { return await cloudCommand(type, payload); } catch (issue) { flash(issue.message); return null; }
  }
  async function refreshCloud() {
    if (cloudWorking.current || couponWorking.current) return;
    if ((editingProduct || editingOrder) && !window.confirm('刷新会关闭尚未保存的商品或订单编辑，重新读取云端资料。确认刷新吗？')) return;
    cloudWorking.current = true; setCloudBusy(true); setCloudError('');
    try { acceptCloud(await onlineRequest('ledger')); setEditingProduct(null); setEditingOrder(null); }
    catch (issue) { setCloudError(issue.message); }
    finally { cloudWorking.current = false; setCloudBusy(false); }
  }
  async function changeLease(action, takeover = false) {
    if (cloudWorking.current || couponWorking.current) return;
    if (takeover && !window.confirm('确认接管当前收银台？原终端将不能继续入账。取得权限后，请先核对云端未完成交易，勿重复收退款。')) return;
    cloudWorking.current = true; setCloudBusy(true); setCloudError('');
    try { acceptCloud(await onlineRequest(`lease/${action}`, { method: 'POST', body: action === 'acquire' ? { takeover } : {} })); setEditingProduct(null); setEditingOrder(null); }
    catch (issue) { setCloudError(issue.message); }
    finally { cloudWorking.current = false; setCloudBusy(false); }
    if (leaseRef.current?.mine) await recoverTransactions();
  }

  async function recoverTransactions() {
    if (recovering.current || backupWorking.current || couponWorking.current) return;
    if (online) {
      if (!leaseRef.current?.mine || cloudWorking.current) return;
      recovering.current = true;
      try {
        const previous = ledgerRef.current;
        const snapshot = await cloudCommand('recovery');
        const current = snapshot.ledger;
        const recoveringIds = [previous.pendingPayment?.draft.id, previous.pendingZero?.draft.id, paymentOrderRef.current?.id, sqbOrderRef.current?.id].filter(Boolean);
        if (current.orders.some(order => recoveringIds.includes(order.id))) {
          clearCart(); setPaymentOrder(null); setSqbOrder(null); setLastResult('云端订单已恢复，库存已核对；请勿重复收款');
        }
        if (shouldOpenPayment(current.pendingPayment)) setSqbOrder(current.pendingPayment.draft);
        else if (previous.pendingPayment && !current.pendingPayment) setSqbOrder(null);
        if (current.pendingAdjustment) setAfterSalesOrder({ order: current.orders.find(item => item.id === current.pendingAdjustment.parentId), type: current.pendingAdjustment.request.type });
        else if (previous.pendingAdjustment && !current.pendingAdjustment) setAfterSalesOrder(null);
        setRecoveryMessage(snapshot.recoveryRequired ? '云端仍有待处理交易，请核对后继续收银' : '');
      } catch (issue) { setRecoveryMessage(issue.message); }
      finally { recovering.current = false; }
      return;
    }
    recovering.current = true;
    try {
      const stage = await sqbCall('restore-status');
      if (backupWorking.current) return;
      if (ledgerRef.current.pendingRestore) {
        const token = ledgerRef.current.pendingRestore;
        if (stage && stage.token !== token) throw new Error('经营数据与支付恢复任务不一致，请保留备份并联系维护人员');
        await sqbCall('commit-restore', { token });
        if (!saveLedger({ ...ledgerRef.current, pendingRestore: null })) throw new Error('恢复账务已合并，请重试完成本地保存');
      } else if (stage) await sqbCall('abort-restore', { token: stage.token });
      setRestoreReady(true);
      const records = await sqbCall('pending');
      setStartupReady(true);
      for (const record of records) {
        if (record.parentId) {
          const original = ledgerRef.current.orders.find((order) => order.id === record.parentId);
          if (!original) throw new Error('发现退换货记录但缺少原订单，请恢复对应完整备份后继续对账');
          if (['paid', 'refunded', 'completed'].includes(record.state)) {
            try { await applyAfterSalesRecord(record); continue; }
            catch (issue) { setRecoveryMessage(issue.message); }
          }
          if (!ledgerRef.current.pendingAdjustment) {
            const request = { id: record.id, type: record.plan.type, returns: record.plan.returns, newItems: record.plan.newLines, reason: record.plan.reason };
            if (!saveLedger({ ...ledgerRef.current, pendingAdjustment: { id: record.id, parentId: record.parentId, request, record } })) return;
          }
          setAfterSalesOrder({ order: original, type: record.plan.type });
          return;
        }
        if (ledgerRef.current.orders.some((order) => order.payment?.orderSn === record.orderSn && order.id === record.id)) {
          await notifyConfirmedPayment(record.id);
          await sqbCall('acknowledge', { id: record.id });
          continue;
        }
        if (!ledgerRef.current.pendingPayment && !saveLedger({ ...ledgerRef.current, pendingPayment: { draft: record.draft, started: true, record } })) return;
        if (shouldOpenPayment(ledgerRef.current.pendingPayment)) setSqbOrder(ledgerRef.current.pendingPayment.draft);
        break;
      }
      const couponRows = await sqbCall('coupon-sync');
      const zeroRows = couponRows.filter(row => row.zeroDraft);
      setCouponRecovery(zeroRows.length > 0);
      for (const row of zeroRows) {
        const existing = ledgerRef.current.orders.find(order => order.id === row.zeroDraft.id);
        if (!existing) {
          const result = await sqbCall('coupon-zero', { draft: row.zeroDraft });
          if (!saveLedger(completeOrder(ledgerRef.current, {...result.draft,physicalFulfilled:result.draft.items.some(isExternalPhysical)}, result.coupon.redeemedAt))) throw new Error('零元结算已核销，请重试保存订单');
        }
        clearCart();
        setPaymentOrder(null);
        await sqbCall('coupon-zero-ack', { id: row.zeroDraft.id });
      }
      setCouponRecovery(false);
      for (const order of ledgerRef.current.orders.filter(o => o.items.some(isExternalPhysical) && !o.physicalFulfilled)) await syncPhysicalOrder(order.id);
      setRecoveryMessage(couponRows.some(row => row.error) ? '存在待同步的中奖券，可在券管理中核对' : '');
    } catch (issue) { setRecoveryMessage(issue.message.includes('不支持的支付操作')
      ? '网页后台仍是旧版。请先关闭旧版网页启动窗口，再双击新版 start-web.cmd，然后刷新本页；只刷新浏览器不会更新后台。' : issue.message); }
    finally { recovering.current = false; }
  }
  useEffect(() => {
    recoverTransactions();
    const timer = setInterval(recoverTransactions, 30000);
    const visible = () => { if (document.visibilityState === 'visible') recoverTransactions(); };
    window.addEventListener('online', recoverTransactions);
    document.addEventListener('visibilitychange', visible);
    return () => { clearInterval(timer); window.removeEventListener('online', recoverTransactions); document.removeEventListener('visibilitychange', visible); };
  }, []);

  useEffect(() => {
    if (!online) return;
    const timer = setInterval(async () => {
      if (!leaseRef.current?.mine || cloudWorking.current) return;
      try { const snapshot = await onlineRequest('lease/acquire', { method: 'POST', body: { takeover: false } }); leaseRef.current = snapshot.lease; setLease(snapshot.lease); }
      catch (issue) { leaseRef.current = { ...leaseRef.current, mine: false }; setLease(leaseRef.current); setCloudError(`收银权限未能续期：${issue.message}。请重新取得权限并核对未完成交易。`); setSqbOrder(null); setAfterSalesOrder(null); setEditingProduct(null); setEditingOrder(null); }
    }, 20000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (online) return;
    if (ledgerRef.current.paymentQr !== paymentQr || JSON.stringify(ledgerRef.current.promoRules) !== JSON.stringify(promoRules)) {
      saveLedger({ ...ledgerRef.current, paymentQr, promoRules });
    }
  }, [paymentQr, promoRules]);

  useEffect(() => {
    setCart((current) => current.map((item) => ({ ...item, stock: products.find((product) => product.id === item.id)?.stock || 0 })));
  }, [products]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(''), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const filteredProducts = useMemo(() => {
    const term = query.trim().toLowerCase();
    return products.filter((item) => {
      const groupMatched = activeGroup === '全部' || item.group === activeGroup;
      const termMatched =
        !term ||
        [item.name, item.barcode, item.sku, item.group].some((value) =>
          String(value).toLowerCase().includes(term),
        );
      return groupMatched && termMatched;
    });
  }, [activeGroup, products, query]);

  const groups = useMemo(() => {
    const names = products.map((item) => item.group || '未分组');
    return ['全部', ...Array.from(new Set(names))];
  }, [products]);

  useEffect(() => {
    if (!groups.includes(activeGroup)) setActiveGroup('全部');
  }, [activeGroup, groups]);

  const events = useMemo(() => orders.flatMap(financialEvents), [orders]);
  const onDate = (event, date) => todayKey(new Date(event.at)) === date;
  const todayEvents = events.filter((event) => onDate(event, todayKey()));
  const ledgerIndex = useMemo(() => createLedgerSearchIndex(orders), [orders]);
  const ledgerResult = useMemo(() => queryLedger(ledgerIndex, { date: selectedOrderDate, ...ledgerSearch }),
    [ledgerIndex, selectedOrderDate, ledgerSearch]);
  const pricedCart = cart.length ? priceOrder(cart) : { items: [], subtotal: 0, discount: 0, total: 0, couponDiscount: 0 };
  const { subtotal: cartSubtotal, discount: cartDiscount, total: cartTotal } = pricedCart;
  const todayTotal = todayEvents.reduce((sum, event) => sum + Math.round(event.amount * 100), 0) / 100;
  const todayCount = todayEvents.filter((event) => event.type === '收款').length;
  const saleProducts = useMemo(() => products.filter((item) => item.productType === 'sale'), [products]);
  const giftProducts = useMemo(() => products.filter(canBePromoGift), [products]);

  function flash(message) {
    setToast(message);
  }

  function addToCart(product, qty = 1) {
    if (!product || couponWorking.current || financiallyLocked) return;
    const currentProduct = products.find((item) => item.id === product.id) || product;
    const mainResult = addLineToCart(cart, currentProduct, qty, { source: currentProduct.productType });
    if (!mainResult.added) {
      if (mainResult.reason === 'coupon-limit') { flash('每笔订单最多使用一张优惠券，请先移除原券'); return; }
      if (mainResult.reason === 'coupon-invalid') { flash('请先设置有效的优惠券抵扣金额'); return; }
      if (mainResult.reason === 'limit') {
        flash(`${currentProduct.name} 已达到库存上限`);
        return;
      }
      flash(`${currentProduct.name} 库存不足，不能销售`);
      return;
    }

    let nextCart = mainResult.next;
    const giftMessages = [];
    const activeRules = promoRules.filter(
      (rule) => currentProduct.productType === 'sale' && rule.mainProductIds.includes(currentProduct.id) && isPromoRuleActive(rule),
    );

    activeRules.forEach((rule) => {
      const alreadyApplied = nextCart.some((item) => item.promoRuleId === rule.id)
        || giftChoiceQueue.some((choice) => choice.ruleId === rule.id);
      if (!rule.stackable && alreadyApplied) return;

      const multiplier = rule.stackable ? mainResult.addedQty : 1;
      const validGifts = rule.gifts
        .map((gift) => ({
          ...gift,
          qty: gift.qty * multiplier,
          product: products.find((item) => item.id === gift.productId && canBePromoGift(item)),
        }))
        .filter((gift) => gift.product);

      if (!validGifts.length) {
        giftMessages.push('赠品规则已失效');
        return;
      }

      if (rule.mode === 'choice') {
        giftMessages.push('请选择赠品');
        setGiftChoiceQueue((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            ruleId: rule.id,
            mainProductId: currentProduct.id,
            mainProductName: currentProduct.name,
            stackable: rule.stackable,
            gifts: validGifts.map(({ product: giftProduct, qty: giftQty }) => ({
              productId: giftProduct.id,
              name: giftProduct.name,
              qty: giftQty,
            })),
          },
        ]);
        setGiftChoicePanelOpen(true);
        return;
      }

      validGifts.forEach(({ product: giftProduct, qty: giftQty }) => {
        const giftResult = addLineToCart(nextCart, promoGiftLine(giftProduct, rule.id), giftQty, {
          source: 'promo',
          promoRuleId: rule.id,
        });
        nextCart = giftResult.next;
        if (giftResult.added) {
          giftMessages.push(`赠品 ${giftProduct.name} 已加入 ${giftResult.addedQty} 件${giftResult.addedQty < giftQty ? '，剩余赠送数量库存不足' : ''}`);
        } else {
          giftMessages.push(`赠品 ${giftProduct.name} 库存不足`);
        }
      });
    });

    setCart(nextCart);
    flash([`${currentProduct.name} 已加入购物车`, ...giftMessages].join('，'));
  }

  function choosePromoGift(choice, giftProductId) {
    const gift = choice?.gifts.find((item) => item.productId === giftProductId);
    const giftProduct = products.find((item) => item.id === giftProductId && canBePromoGift(item));
    if (!choice || !gift || !giftProduct) {
      flash('赠品已失效');
      return;
    }

    const result = addLineToCart(cart, promoGiftLine(giftProduct, choice.ruleId), gift.qty, {
      source: 'promo',
      promoRuleId: choice.ruleId,
    });
    if (!result.added || result.addedQty !== gift.qty) {
      flash(`${giftProduct.name} 库存不足`);
      return;
    }

    setCart(result.next);
    const remainingChoices = giftChoiceQueue.filter((item) => item.id !== choice.id);
    setGiftChoiceQueue(remainingChoices);
    setGiftChoicePanelOpen(remainingChoices.length > 0);
    flash(`已选择赠品 ${giftProduct.name}`);
  }

  function openGiftChoice(choiceId) {
    setGiftChoiceQueue((current) => {
      const choice = current.find((item) => item.id === choiceId);
      if (!choice) return current;
      return [choice, ...current.filter((item) => item.id !== choiceId)];
    });
    setGiftChoicePanelOpen(true);
  }

  async function scanBarcode(code) {
    const normalized = String(code ?? '').trim();
    if (!normalized) return;
    if (couponWorking.current || financiallyLocked) return;
    const physicalCode = /^[0-9A-Fa-f]{16}$/.test(normalized);
    if (shouldReserveAward(normalized,products)) {
      if (cart.some(item => isCoupon(item) || isExternalAward(item))) { flash('每单仅能使用一份抽奖奖品或优惠券，请先移除已有奖品'); return; }
      if (!physicalCode && (!cart.some(item => !isCoupon(item)) || priceOrder(cart).total <= 0)) { flash('请先加入需要付款的商品，再扫描中奖券'); return; }
      couponWorking.current = true; setCouponBusy(true);
      if (online) setCloudSyncRequired(true);
      try {
        const inventory = physicalCode ? ledgerRef.current.products.map(({ id, name, sku, barcode, productType, price, originalPrice, stock, group }) => ({ id, name, sku, barcode, productType, price, originalPrice, stock, group })) : undefined;
        const line = await sqbCall('coupon-reserve', { code: physicalCode ? normalized.toUpperCase() : normalized, checkoutId: crypto.randomUUID(), eligibleCents: cart.length ? Math.round(priceOrder(cart).total * 100) : 0, requestId: crypto.randomUUID(), products: inventory });
        try { reconcileStock(ledgerRef.current.products, [], [...cart,line]); }
        catch(error) { await sqbCall('coupon-release',{id:line.externalCoupon.reservationId}); throw error; }
        setCart(current => [...current, line]); setBarcodeInput('');
        flash(isExternalPhysical(line) ? `${line.name} · 抽奖赠品已加入，免费 1 件` : `中奖券已加入，最多抵扣 ${line.couponAmount.toFixed(2)} 元`);
      } catch (error) { flash(error.message); }
      finally {
        if (online) {
          try { acceptCloud(await onlineRequest('ledger')); }
          catch (issue) { setCloudError(`领奖券状态需要核对：${issue.message}。请刷新云端数据后再继续，勿重复扫码。`); }
        }
        couponWorking.current = false; setCouponBusy(false);
      }
      return;
    }
    const matches = products.filter((item) => item.barcode === normalized);
    if (matches.length > 1) { flash('条码重复，请先在商品管理中修正'); return; }
    const product = matches[0];
    if (product) {
      addToCart(product);
      setBarcodeInput('');
      return;
    }
    setEditingProduct({
      id: crypto.randomUUID(),
      barcode: normalized,
      sku: '',
      group: '未分组',
      imageUrl: '',
      productType: 'sale',
      name: '',
      originalPrice: '',
      price: '',
      stock: 0,
    });
    flash('未找到商品，请先补全商品信息');
  }

  useEffect(() => {
    if (activeTab !== 'cashier' || scannerOpen || editingProduct || paymentOrder || sqbOrder || sqbSettingsOpen || heldPanelOpen || giftChoicePanelOpen || pendingPayment || afterSalesOrder || financiallyLocked) return;
    let buffer = '';
    let last = 0;
    const listener = (event) => {
      if (event.target.closest?.('input, textarea, select, [contenteditable="true"]') || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
      const now = performance.now();
      if (now - last > 120) buffer = '';
      if (['Enter', 'Tab'].includes(event.key) && buffer) { event.preventDefault(); scanBarcode(buffer); buffer = ''; }
      else if (event.key.length === 1) { buffer = (buffer + event.key).slice(-4096); last = now; }
    };
    document.addEventListener('keydown', listener, true);
    return () => document.removeEventListener('keydown', listener, true);
  }, [activeTab, scannerOpen, editingProduct, paymentOrder, sqbOrder, sqbSettingsOpen, heldPanelOpen, giftChoicePanelOpen, pendingPayment, afterSalesOrder, financiallyLocked, cart, products, promoRules, giftChoiceQueue]);

  async function changeQty(productId, delta) {
    const existing = cart.find((item) => basketLineKey(item) === productId);
    if (existing && isExternalPhysical(existing) && delta > 0) return;
    if (couponWorking.current) return;
    if (existing?.externalCoupon && delta < 0) {
      couponWorking.current = true; setCouponBusy(true);
      try { await sqbCall('coupon-release', { id: existing.externalCoupon.reservationId }); }
      catch (error) { flash(error.message); return; }
      finally { couponWorking.current = false; setCouponBusy(false); }
    }
    if (existing && existing.qty + delta <= 0) {
      setGiftChoiceQueue((current) => current.filter((choice) => choice.mainProductId !== productId));
    }
    setCart((current) =>
      current
        .map((item) => {
          if (basketLineKey(item) !== productId) return item;
          if (isExternalPhysical(item)) return {...item,qty:delta < 0 ? 0 : 1};
          if (isCoupon(item)) return { ...item, qty: delta < 0 ? 0 : 1 };
          const stock = Number(ledgerRef.current.products.find(product => product.id === item.id)?.stock || 0);
          const usedByOtherLines = current.filter(line => line.id === item.id && basketLineKey(line) !== productId).reduce((sum, line) => sum + line.qty, 0);
          const qty = clampNumber(item.qty + delta, 0, Math.max(0, stock - usedByOtherLines));
          const maxDiscount = item.price * qty;
          return { ...item, qty, discount: clampNumber(item.discount, 0, maxDiscount) };
        })
        .filter((item) => item.qty > 0),
    );
  }

  function changeDiscount(productId, value) {
    setCart((current) =>
      current.map((item) => {
        if (basketLineKey(item) !== productId || isCoupon(item) || item.productType === 'gift') return item;
        return { ...item, discount: clampNumber(value, 0, item.price * item.qty) };
      }),
    );
  }

  function createOrder(method) {
    if (!cart.length) {
      flash('购物车还是空的');
      return null;
    }

    if (giftChoiceQueue.length) {
      flash('还有赠品未选择，请先选择赠品');
      return null;
    }

    let priced;
    try {
      priced = priceOrder(cart, method === '0元出库');
      const coupon = cart.find(item => item.externalCoupon);
      if (coupon) {
        if (method !== '收钱吧') throw new Error('中奖券请使用收钱吧结算；全额抵扣会自动进入零元结算');
        if (!isExternalPhysical(coupon) && (Math.round((priced.total + priced.couponDiscount) * 100) < coupon.minimumCents || priced.couponDiscount <= 0)) throw new Error('当前商品金额未达到中奖券门槛，请调整商品或移除券');
      }
      reconcileStock(ledgerRef.current.products, [], priced.items);
    } catch (error) {
      flash(error.message);
      return null;
    }

    const order = {
      id: crypto.randomUUID(),
      orderNo: `POS${Date.now()}${crypto.randomUUID().slice(0, 4)}`,
      createdAt: new Date().toISOString(),
      day: todayKey(),
      method,
      status: '待收款',
      ...priced,
    };
    return order;
  }

  function checkout(method) {
    if (ledgerRef.current.pendingAdjustment || ledgerRef.current.pendingRestore || backupBusy) { flash('请先完成退换货或备份恢复'); return; }
    if (ledgerRef.current.pendingPayment) {
      setSqbOrder(ledgerRef.current.pendingPayment.draft);
      flash('请先核实正在进行的收钱吧支付');
      return;
    }
    const order = createOrder(method);
    if (!order) return;

    if (method !== '0元出库' && order.total === 0) {
      setPaymentOrder({ ...order, method: '零元结算' });
      return;
    }

    if (method === '收钱吧') {
      enablePaymentNotifications().catch(() => {});
      setSqbOrder(order);
      return;
    }

    if (method === '0元出库') setCart(order.items);
    setPaymentOrder(order);
  }

  function clearCart() {
    setCart([]);
    setGiftChoiceQueue([]);
    setGiftChoicePanelOpen(false);
  }

  async function markPaid() {
    if (financiallyLocked) { flash('请先核对待处理收款'); return; }
    if (!paymentOrder || couponWorking.current) return;
    const external = paymentOrder.items.some(item => item.externalCoupon);
    if (online) {
      const result = await saveCloud(external ? 'zero-complete' : 'manual-complete', { draft: paymentOrder });
      if (result) { setPaymentOrder(null); clearCart(); flash(external ? '云端已核销并保存订单，可发放奖品' : '云端订单已保存，库存已更新'); }
      return;
    }
    if (external) { couponWorking.current = true; setCouponBusy(true); setCouponRecovery(true); }
    try {
      const result = external ? await sqbCall('coupon-zero', { draft: paymentOrder }) : null;
      if (!saveLedger(completeOrder(ledgerRef.current, {...(result?.draft || paymentOrder),physicalFulfilled:!!result && paymentOrder.items.some(isExternalPhysical)}, result?.coupon.redeemedAt))) return;
      setPaymentOrder(null);
      clearCart();
      if (external) { await sqbCall('coupon-zero-ack', { id: paymentOrder.id }); setCouponRecovery(false); }
      flash(paymentOrder.items.some(isExternalPhysical) ? '实物奖品已核销，订单及库存已保存，可发放' : '订单已完成，库存已扣减');
    } catch (error) { flash(error.message); if (external) { setRecoveryMessage(error.message); setPaymentOrder(null); } }
    finally { couponWorking.current = false; setCouponBusy(false); if (external) recoverTransactions(); }
  }

  async function beforeSqbStart() {
    try {
      if (online) return Boolean(await saveCloud('payment-prepare', { draft: sqbOrder }));
      if (ledgerRef.current.pendingPayment || ledgerRef.current.pendingAdjustment) throw new Error('请先核对待处理收退款');
      reconcileStock(ledgerRef.current.products, [], sqbOrder.items);
      return saveLedger({ ...ledgerRef.current, pendingPayment: { draft: sqbOrder, started: true } });
    } catch (error) { flash(error.message); return false; }
  }

  async function syncPhysicalOrder(orderId) {
    if (online) { const result = await saveCloud('physical-sync', { orderId }); return Boolean(result?.ledger.orders.find(order => order.id === orderId)?.physicalFulfilled); }
    try { const status = await sqbCall('coupon-fulfilment',{orderId});
      if (!status.redeemed) return false;
      return saveLedger({...ledgerRef.current,orders:ledgerRef.current.orders.map(o => o.id === orderId ? {...o,physicalFulfilled:true} : o)},true);
    } catch { return false; }
  }

  async function applySqbRecord(record) {
    if (record.state !== 'paid') return;
    if (online) {
      const snapshot = await cloudCommand('payment-sync', { id: record.id });
      clearCart(); setSqbOrder(null); flash('云端已确认收款，订单和库存已保存');
      setLastResult(`收款成功 ${(record.amount / 100).toFixed(2)} 元 · 云端订单已保存`);
      await notifyConfirmedPayment(record.id);
      if (snapshot.ledger.orders.find(order => order.id === record.id)?.items.some(isExternalPhysical)) {
        const ready = await syncPhysicalOrder(record.id);
        setLastResult(ready ? '收款及奖品核销已完成，可发放实物奖品' : '收款已成功 · 实物奖品领取确认待同步，请暂缓发放');
      }
      return;
    }
    try {
      const next = completeBrowserPayment(ledgerRef.current, record);
      if (!saveLedger(next, true)) throw new Error('收款已成功但订单保存失败，请勿重复收款，请重试保存');
      clearCart();
      setSqbOrder(null);
      flash(`收款成功，收款 ${(record.amount / 100).toFixed(2)} 元`);
      setLastResult(`收款成功 ${(record.amount / 100).toFixed(2)} 元 · ${(record.tenders || []).map(channelName).join(' / ')} · ${new Date(transactionTime(record.tenders, record.updatedAt)).toLocaleString('zh-CN')}`);
      await notifyConfirmedPayment(record.id);
      await sqbCall('acknowledge', { id: record.id });
      if (record.draft.items.some(isExternalPhysical)) { const ready = await syncPhysicalOrder(record.id); setLastResult(ready ? '收款及奖品核销已完成，可发放实物奖品' : '收款已成功 · 实物奖品领取确认待同步，请暂缓发放'); }
    } catch (error) {
      if (ledgerRef.current.pendingPayment?.draft.id === record.id) {
        try {
          saveLedger(retainPaymentReview(ledgerRef.current, record, error.message,
            ledgerRef.current.pendingPayment.review?.dismissed), true);
        } catch { /* Keep the original pending task if retaining the result fails. */ }
      }
      throw error;
    }
  }

  async function closeSqb(record) {
    if (online) {
      if (record?.state === 'paid') {
        if (!ledgerRef.current.orders.some(order => order.id === record.id)) await cloudCommand('payment-review', { id: record.id, dismissed: true });
        setSqbOrder(null); return;
      }
      if (ledgerRef.current.pendingPayment && !['failed', 'not-started'].includes(record?.state)) return;
      if (ledgerRef.current.pendingPayment) {
        const draft = ledgerRef.current.pendingPayment.draft;
        await cloudCommand('payment-clear', { id: draft.id });
        setCart(draft.items.filter(item => !item.externalCoupon));
      }
      setSqbOrder(null); return;
    }
    if (record?.state === 'paid') {
      const current = ledgerRef.current;
      if (!current.pendingPayment && current.orders.some(order => order.id === record.id && order.payment?.orderSn === record.orderSn)) {
        setSqbOrder(null); return;
      }
      const next = retainPaymentReview(current, record, current.pendingPayment?.review?.message || paymentReviewMessage(current, record), true);
      if (!saveLedger(next, true)) throw new Error('无法保留待核对状态，请先释放本机存储空间；原收款记录未清除');
      setSqbOrder(null);
      return;
    }
    if (ledgerRef.current.pendingPayment && !['failed', 'not-started'].includes(record?.state)) return;
    if (record?.state === 'failed') await sqbCall('acknowledge', { id: record.id });
    if (ledgerRef.current.pendingPayment) {
      const items = ledgerRef.current.pendingPayment.draft.items;
      if (!saveLedger({ ...ledgerRef.current, pendingPayment: null })) return;
      setCart(items.filter(item => !item.externalCoupon));
    }
    setSqbOrder(null);
  }

  function cancelPayment() {
    if (couponWorking.current) return;
    if (paymentOrder?.items.some(item => item.externalCoupon)) { setPaymentOrder(null); flash('已返回购物车，移除中奖券可释放占用'); return; }
    setPaymentOrder(null);
    clearCart();
    flash('本次订单已取消，未记账、未扣库存');
  }

  function makeZeroOrder() {
    if (couponWorking.current || paymentOrder?.items.some(item => item.externalCoupon)) { flash('中奖券已参与抵扣，不能再改为0元出库'); return; }
    if (!paymentOrder) return;
    const priced = priceOrder(paymentOrder.items, true);
    setPaymentOrder({ ...paymentOrder, ...priced, method: '0元出库' });
    setCart(priced.items);
  }

  async function holdCart() {
    if (online && giftChoiceQueue.length) { flash('请先完成赠品选择，再挂单'); return false; }
    if (cart.some(item => item.externalCoupon)) { flash('请先移除中奖券再挂单，取单后可重新扫码'); return false; }
    if (!cart.length) { flash('购物车还是空的'); return false; }
    const held = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), items: cart, giftChoiceQueue };
    const current = ledgerRef.current;
    if (online ? !await saveCloud('hold', { basket: held }) : !saveLedger(suspendBasket(current, held))) return false;
    clearCart();
    flash('已挂起，可继续为下一位顾客收银');
    return true;
  }

  async function resumeCart(id) {
    if (cart.some(item => item.externalCoupon)) { flash('请先移除当前中奖券，再取单'); return; }
    const current = ledgerRef.current;
    if (!current.heldCarts.some((entry) => entry.id === id)) return;
    const currentBasket = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), items: cart, giftChoiceQueue };
    let held;
    if (online) { const result = await saveCloud('retrieve', { id, currentBasket }); if (!result) return; held = result.extra.basket; }
    else { const result = retrieveBasket(current, id, currentBasket); if (!saveLedger(result.ledger)) return; held = result.basket; }
    setCart(held.items);
    setGiftChoiceQueue(held.giftChoiceQueue || []);
    setGiftChoicePanelOpen(Boolean(held.giftChoiceQueue?.length));
    setHeldPanelOpen(false);
    flash(cart.length ? '已取单，原购物车已自动挂起' : '已取单');
  }

  async function deleteHeldCart(id) {
    if (!window.confirm('确定删除这笔挂单吗？')) return;
    const current = ledgerRef.current;
    if (online) await saveCloud('held-delete', { id });
    else saveLedger({ ...current, heldCarts: current.heldCarts.filter((entry) => entry.id !== id) });
  }

  async function cancelOrder(id) {
    if (financiallyLocked) { flash('请先核对待处理收退款，暂不能取消其他订单'); return; }
    const existing = ledgerRef.current.orders.find((order) => order.id === id);
    if (existing?.payment?.provider === 'sqb') { openAfterSales(existing, 'return'); return; }
    if (!window.confirm('确定取消订单？商品将退回库存，该订单金额将从营收中扣除。实际退款请另行完成。')) return;
    if (online) { if (await saveCloud('order-revise', { id, items: [], cancel: true })) flash('云端订单已取消，库存和营收已回退'); return; }
    try {
      if (saveLedger(reviseOrder(ledgerRef.current, id, [], true))) flash('订单已取消，库存和营收已回退');
    } catch (error) { flash(error.message); }
  }

  function openAfterSales(order, type) {
    try {
      if (ledgerRef.current.pendingPayment || ledgerRef.current.pendingAdjustment) throw new Error('请先处理当前收退款');
      if (order.revisions?.length) throw new Error('这笔旧订单曾在外部修改，请先人工核对，不能直接自动退款');
      if (!remainingLines(order).length) throw new Error('该订单商品已全部退回');
      setToast('');
      setAfterSalesOrder({ order, type });
    } catch (issue) { flash(issue.message); }
  }

  async function beforeAfterSalesStart(pending) {
    try {
      if (online) return Boolean(await saveCloud('adjustment-prepare', { parentId: pending.parentId, request: pending.request, preview: pending.preview }));
      if (ledgerRef.current.pendingPayment || ledgerRef.current.pendingAdjustment) throw new Error('请先处理当前收退款');
      validateAdjustmentStock(ledgerRef.current.products, pending.preview.plan);
      return saveLedger({ ...ledgerRef.current, pendingAdjustment: pending });
    } catch (issue) { flash(issue.message); return false; }
  }

  async function applyAfterSalesRecord(record) {
    if (!['paid', 'refunded', 'completed'].includes(record.state)) return;
    if (online) { await cloudCommand('adjustment-sync', { id: record.id }); setAfterSalesOrder(null); setLastResult('退换货已核对，云端订单与库存已同步'); if (record.kind === 'exchange-charge') await notifyConfirmedPayment(record.id); return; }
    const next = applyAdjustment(ledgerRef.current, record);
    if (!saveLedger(next, true)) throw new Error('账务保存失败，请勿重复收退款');
    setAfterSalesOrder(null);
    setToast('');
    setLastResult(`${record.plan.deltaCents < 0 ? '原路退款成功' : record.plan.deltaCents > 0 ? '换货补款成功' : '退换货已完成'} ${money(Math.abs(record.plan.deltaCents) / 100)} · 库存已同步`);
    if (record.kind === 'exchange-charge') await notifyConfirmedPayment(record.id);
    await sqbCall('acknowledge', { id: record.id });
  }

  async function closeAfterSales(record) {
    if (['paid', 'refunded', 'completed'].includes(record?.state)) { await applyAfterSalesRecord(record); return; }
    if (ledgerRef.current.pendingAdjustment && !['failed', 'not-started'].includes(record?.state)) return;
    if (online) { if (ledgerRef.current.pendingAdjustment) await cloudCommand('adjustment-clear', { id: ledgerRef.current.pendingAdjustment.id }); setAfterSalesOrder(null); return; }
    if (record?.state === 'failed') await sqbCall('acknowledge', { id: record.id });
    if (ledgerRef.current.pendingAdjustment && !saveLedger({ ...ledgerRef.current, pendingAdjustment: null })) return;
    setAfterSalesOrder(null);
  }

  async function saveOrderEdit(id, items) {
    if (financiallyLocked) { flash('请先核对待处理收退款，暂不能修改其他订单'); return; }
    if (online) { if (await saveCloud('order-revise', { id, items, cancel: false })) { setEditingOrder(null); flash('云端换货已保存，库存和流水已更新'); } return; }
    try {
      const next = reviseOrder(ledgerRef.current, id, items);
      if (!saveLedger(next)) return;
      setEditingOrder(null);
      flash('换货已保存，库存和流水已更新');
    } catch (error) { flash(error.message); }
  }

  async function confirmLegacyOrder(id) {
    if (financiallyLocked) { flash('请先核对待处理收退款'); return; }
    if (!window.confirm('确认这笔旧版待收款订单已经收到款项？')) return;
    if (online) { await saveCloud('legacy-confirm', { id }); return; }
    const current = ledgerRef.current;
    if (!current.orders.some((order) => order.id === id && order.status === '待收款')) return;
    saveLedger({ ...current, orders: current.orders.map((order) => order.id === id ? { ...order, status: '已收款', paidAt: new Date().toISOString() } : order) });
  }

  async function saveProduct(product) {
    const payload = {
      ...product,
      name: product.name.trim(),
      barcode: product.barcode.trim(),
      sku: String(product.sku || '').trim(),
      group: String(product.group || '').trim() || '未分组',
      imageUrl: String(product.imageUrl || '').trim(),
      productType: normalizeProductType(product.productType, product.price),
      giftEligible: canBePromoGift(product),
      originalPrice: Number(product.originalPrice || 0),
      price: normalizeProductType(product.productType, product.price) !== 'sale' ? 0 : Number(product.price || 0),
      couponAmount: isCoupon(product) ? Math.round(Number(product.couponAmount || 0) * 100) / 100 : 0,
      stock: isCoupon(product) ? 0 : Number(product.stock || 0),
    };

    if (!payload.name || !payload.barcode || (payload.productType === 'sale' && payload.price <= 0)) {
      flash('请填写商品名、条码和售卖品售价');
      return;
    }
    if (isCoupon(payload) && (!Number.isFinite(payload.couponAmount) || payload.couponAmount <= 0)) { flash('优惠券抵扣金额必须大于 0'); return; }
    const duplicate = products.find((item) => item.id !== payload.id && item.barcode === payload.barcode);
    if (duplicate) { flash(isCoupon(duplicate) ? `该条码已被优惠券「${duplicate.name}」使用` : `该条码已被「${duplicate.name}」使用，请编辑原商品；需要售卖兼赠送时，设置售价并勾选“可参与买赠”`); return; }
    if (!Number.isSafeInteger(payload.stock) || payload.stock < 0 || !Number.isFinite(payload.price) || !Number.isFinite(payload.originalPrice) || payload.originalPrice < 0) {
      flash('库存须为非负整数，价格须为有效的非负金额');
      return;
    }

    const saved = online ? await saveCloud('product-save', { product: payload }) : setProducts((current) => {
      const exists = current.some((item) => item.id === payload.id);
      if (exists) return current.map((item) => (item.id === payload.id ? payload : item));
      return [payload, ...current];
    });
    if (!saved) return;
    setEditingProduct(null);
    flash('商品已保存');
  }

  async function removeProduct(id) {
    if (cart.some(item => item.id === id && isExternalAward(item))) { flash('请先移除购物车中的抽奖奖品，再删除对应商品'); return; }
    if (online) { if (await saveCloud('product-delete', { id })) { setCart(current => current.filter(item => item.id !== id)); setGiftChoiceQueue(current => current.filter(choice => choice.mainProductId !== id && !choice.gifts.some(gift => gift.productId === id))); } return; }
    if (!setProducts((current) => current.filter((item) => item.id !== id))) return;
    setCart((current) => current.filter((item) => item.id !== id));
    setPromoRules((current) =>
      current.filter((rule) => !rule.mainProductIds.includes(id) && !rule.gifts.some((gift) => gift.productId === id)),
    );
    setGiftChoiceQueue((current) =>
      current.filter((choice) => choice.mainProductId !== id && !choice.gifts.some((gift) => gift.productId === id)),
    );
  }

  async function savePromoRule(rule) {
    const payload = normalizePromoRules([rule])[0];
    const mainProducts = payload.mainProductIds.filter((productId) => productId);
    const gifts = payload.gifts.filter((gift) => gift.productId);

    if (!mainProducts.length) {
      flash('请至少选择 1 个主品');
      return false;
    }
    if (mainProducts.some((productId) => !products.some((item) => item.id === productId && item.productType === 'sale'))) {
      flash('主品只能选择售卖品');
      return false;
    }
    if (!gifts.length) {
      flash('请至少选择 1 个赠品');
      return false;
    }
    if (gifts.some((gift) => !products.some((item) => item.id === gift.productId && canBePromoGift(item)))) {
      flash('请选择赠品或已启用“可参与买赠”的售卖品');
      return false;
    }
    if (payload.startAt && payload.endAt && new Date(payload.startAt) > new Date(payload.endAt)) {
      flash('结束时间不能早于开始时间');
      return false;
    }

    if (online) {
      const current = ledgerRef.current.promoRules || [], exists = current.some(item => item.id === payload.id);
      if (!await saveCloud('settings-save', { promoRules: exists ? current.map(item => item.id === payload.id ? payload : item) : [payload, ...current] })) return false;
      flash('加赠规则已保存到云端'); return true;
    }
    setPromoRules((current) => {
      const exists = current.some((item) => item.id === payload.id);
      if (exists) return current.map((item) => (item.id === payload.id ? payload : item));
      return [payload, ...current];
    });
    flash('加赠规则已保存');
    return true;
  }

  async function togglePromoRule(ruleId) {
    if (online) { await saveCloud('settings-save', { promoRules: (ledgerRef.current.promoRules || []).map(rule => rule.id === ruleId ? { ...rule, enabled: !rule.enabled } : rule) }); return; }
    setPromoRules((current) => current.map((rule) => (rule.id === ruleId ? { ...rule, enabled: !rule.enabled } : rule)));
  }

  async function removePromoRule(ruleId) {
    if (online) { if (await saveCloud('settings-save', { promoRules: (ledgerRef.current.promoRules || []).filter(rule => rule.id !== ruleId) })) flash('加赠规则已删除'); return; }
    setPromoRules((current) => current.filter((rule) => rule.id !== ruleId));
    flash('加赠规则已删除');
  }

  async function importProducts(file) {
    if (!file) return;
    try {
      const lowerName = file.name.toLowerCase();
      const rows = lowerName.endsWith('.csv')
        ? parseCsv(await readCsvFile(file))
        : await readXlsxFile(file);
      const incoming = rowsToProducts(rows);
      if (!incoming.length) {
        flash('没有读到可导入的商品');
        return;
      }

      if (online ? !await saveCloud('products-import', { products: incoming }) : !setProducts((current) => mergeProducts(current, incoming))) return;
      flash(`已导入 ${incoming.length} 个商品`);
    } catch (error) {
      flash(error.message || '导入失败，请检查表头');
    }
  }

  function exportTemplate() {
    const lines = [
      ['产品名称', '条码', '货品编码', '商品分组', '商品类型', '商品图片', '原价', '售价', '库存数量', '抵扣金额', '可参与买赠'].map(escapeCsv).join(','),
      ['示例饮料', 'ABC-001', 'DRINK-001', '饮料', '售卖品', '', '6', '5', '20', '', '否'].map(escapeCsv).join(','),
      ['示例赠品', '6970000000001', 'GIFT-001', '赠品', '赠品', '', '0', '0', '30', '', '是'].map(escapeCsv).join(','),
      ['可售可赠示例', 'SALE-GIFT-001', 'SALE-GIFT-001', '配件', '售卖品', '', '30', '20', '10', '', '是'].map(escapeCsv).join(','),
      ['满单抵扣5元券', '6900000000002', 'COUPON-005', '优惠券', '优惠券', '', '0', '0', '0', '5', '否'].map(escapeCsv).join(','),
    ].join('\n');

    const blob = new Blob([`\ufeff${lines}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = '商品导入模板.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  function exportOrders(dateOnly = false) {
    const lines = (dateOnly === true ? ledgerResult.rows : financialExportRows(orders))
      .map((row) => row.map(escapeCsv).join(',')).join('\n');

    const blob = new Blob([`\ufeff${lines}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `摆摊流水_${dateOnly === true ? selectedOrderDate || '全部日期' : '全部'}${dateOnly === true && ledgerSearch.keyword ? '_查询结果' : ''}_商品明细.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function exportBackup() {
    if (financiallyLocked) { flash('请先处理收退款或恢复任务'); return; }
    backupWorking.current = true; setBackupBusy(true);
    try {
    const business = {
      type: 'stall-cashier-backup',
      version: 3,
      exportedAt: new Date().toISOString(),
      products,
      orders,
      paymentQr,
      promoRules,
      heldCarts,
    };
    const backup = online ? await onlineRequest('export') : await sqbCall('export-backup', { business });

    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `收银系统备份_${todayKey()}_${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    flash('完整经营备份已导出；迁移收款还需单独导出加密配置');
    } catch (issue) { flash(issue.message); }
    finally { backupWorking.current = false; setBackupBusy(false); }
  }

  async function restoreBackup(file) {
    if (online) { flash('在线迁移请到「账号与资料」导入原备份；已有云端数据不能直接覆盖'); setActiveTab('account'); return; }
    if (!file) return;
    if (financiallyLocked) { flash('请先处理收退款或恢复任务'); return; }
    backupWorking.current = true; setBackupBusy(true);
    let stage;
    let committed = false;
    try {
      const backup = JSON.parse(await file.text());

      const ok = window.confirm('恢复备份会覆盖当前商品、订单流水、挂单、收款码、商品图片和加赠规则，确定继续吗？');
      if (!ok) return;

      stage = await sqbCall('prepare-restore', { bundle: backup });
      const business = stage.business;
      const next = { products: normalizeProducts(business.products), orders: business.orders, heldCarts: business.heldCarts,
        paymentQr: String(business.paymentQr || ''), promoRules: normalizePromoRules(business.promoRules), pendingRestore: stage.token };
      if (!saveLedger(next)) throw new Error('本地保存失败，本次恢复未完成');
      committed = true; setRestoreReady(false);
      setPaymentQr(next.paymentQr);
      setPromoRules(next.promoRules);
      await sqbCall('commit-restore', { token: stage.token });
      if (!saveLedger({ ...ledgerRef.current, pendingRestore: null })) throw new Error('恢复账务已合并，请重试本地保存');
      setRestoreReady(true);
      setCart([]);
      setGiftChoiceQueue([]);
      setGiftChoicePanelOpen(false);
      setPaymentOrder(null);
      setEditingOrder(null);
      setHeldPanelOpen(false);
      flash('备份已恢复');
    } catch (issue) {
      if (stage && !committed) await sqbCall('abort-restore', { token: stage.token }).catch(() => {});
      if (committed) setRecoveryMessage(issue.message);
      flash(`备份恢复未完成：${issue.message}`);
    } finally { backupWorking.current = false; setBackupBusy(false); }
  }

  function uploadPaymentQr(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      if (online) { if (await saveCloud('settings-save', { paymentQr: String(reader.result || '') })) flash('收款码已保存到云端'); return; }
      setPaymentQr(String(reader.result || ''));
      flash('收款码已保存');
    };
    reader.readAsDataURL(file);
  }

  return (
    <main className="shell">
      {online && <section className="onlineBar" aria-label="云端账号与收银权限"><div><strong>云端收银 · {online.session.user.displayName || online.session.user.username}</strong><small>{lease?.mine ? '本终端持有收银权限' : lease?.held ? `收银台由 ${lease.displayName || '其他终端'} 使用` : '取得收银权限后可操作商品、库存与订单'} · 数据版本 {cloudRevision.current}</small></div>
        <div className="onlineActions"><button className="utilityButton" disabled={cloudBusy || couponBusy} onClick={refreshCloud}>刷新云端数据</button>
          {lease?.mine ? <button className="utilityButton" disabled={cloudBusy || !!pendingPayment || !!pendingAdjustment || !!ledger.pendingZero || !!cart.length} onClick={() => changeLease('release')}>释放收银台</button> : <button className="utilityButton" disabled={cloudBusy || lease?.held} onClick={() => changeLease('acquire')}>取得收银权限</button>}
          {!lease?.mine && (lease?.held || lease?.recoveryRequired) && online.session.user.role === 'admin' && <button className="utilityButton" disabled={cloudBusy} onClick={() => changeLease('acquire', true)}>接管并恢复</button>}
          <button className="utilityButton" disabled={cloudBusy} onClick={() => setActiveTab('account')}>账号与资料</button><button className="utilityButton" disabled={cloudBusy} onClick={online.logout}>退出</button>
        </div></section>}
      {online && (cloudError || online.notice) && <p className="onlineNotice dangerText" role="alert">{cloudError || online.notice}</p>}
      {online && !lease?.mine && <p className="onlineNotice">当前可以查看共享数据和管理活动。收银、商品与库存修改需要先取得收银权限；未完成交易保留在云端。</p>}
      {online && ['products', 'promos'].includes(activeTab) && online.session.user.role !== 'admin' && <p className="onlineNotice">商品、库存和赠品规则由管理员维护。收银员可以在「收银」中使用已保存的商品。</p>}
      <div inert={!online && financiallyLocked && !reviewingPayment ? '' : undefined}>
      <header className="topbar">
        <div>
          <p className="kicker">{online ? '云端共享账本' : '离线摆摊收银'}</p>
          <h1>摆摊收银台</h1>
        </div>
        <button className="iconButton" aria-label="导出流水" title="导出全部流水（不受查询条件影响）" onClick={exportOrders}>
          <Download size={22} />
        </button>
      </header>

      <section className="summary">
        <div>
          <span>今日净收入</span>
          <strong>{money(todayTotal)}</strong>
        </div>
        <div>
          <span>订单</span>
          <strong>{todayCount}</strong>
        </div>
        <div>
          <span>购物车</span>
          <strong>{cart.length}</strong>
        </div>
      </section>
      {lastResult && <div className="resultBanner" role="status"><span>{lastResult}</span><button className="iconButton" aria-label="关闭交易结果" onClick={() => setLastResult('')}><X size={18} /></button></div>}
      {pendingPayment?.review && (!online || lease?.mine) && <div className="recoveryBanner paymentReviewBanner" role="alert">
        <div><strong>收款待核对 · {pendingPayment.draft.orderNo} · {money(pendingPayment.record.amount / 100)}</strong>
          <span>{pendingPayment.review.message}</span><small>{online ? '云端暂停收银及账务修改，待核对记录仍保留。' : '本浏览器暂停收银及账务修改，待核对记录仍保留。'}</small></div>
        <button className="utilityButton" onClick={() => setSqbOrder(ledgerRef.current.pendingPayment.draft)}><History size={18} /> 查看待核对收款</button>
      </div>}
      {recoveryMessage && <div className="recoveryBanner" role="alert"><span>待核实：{recoveryMessage}</span><button className="utilityButton" onClick={recoverTransactions}><RefreshCw size={16} /> 重试对账</button></div>}

      {activeTab === 'cashier' && (
        <div inert={reviewingPayment || online && financiallyLocked ? '' : undefined}>
        <CashierView
          products={filteredProducts}
          groups={groups}
          activeGroup={activeGroup}
          setActiveGroup={setActiveGroup}
          cart={pricedCart.items}
          query={query}
          setQuery={setQuery}
          barcodeInput={barcodeInput}
          setBarcodeInput={setBarcodeInput}
          scanBarcode={scanBarcode}
          addToCart={addToCart}
          changeQty={changeQty}
          changeDiscount={changeDiscount}
          giftChoiceQueue={giftChoiceQueue}
          onOpenGiftChoice={openGiftChoice}
          checkout={checkout}
          onHold={holdCart}
          onShowHeld={() => setHeldPanelOpen(true)}
          heldCount={heldCarts.length}
          cartTotal={cartTotal}
          cartSubtotal={cartSubtotal}
          cartDiscount={cartDiscount}
          openScanner={() => setScannerOpen(true)}
        />
        </div>
      )}

      {activeTab === 'products' && (
        <div inert={reviewingPayment || online && (financiallyLocked || online.session.user.role !== 'admin') ? '' : undefined}>
        <ProductsView
          online={Boolean(online)}
          products={filteredProducts}
          groups={groups}
          activeGroup={activeGroup}
          setActiveGroup={setActiveGroup}
          query={query}
          setQuery={setQuery}
          paymentQr={paymentQr}
          onNew={() =>
            setEditingProduct({
              id: crypto.randomUUID(),
              barcode: '',
              sku: '',
              group: '未分组',
              imageUrl: '',
              productType: 'sale',
              name: '',
              originalPrice: '',
              price: '',
              stock: 0,
            })
          }
          onEdit={setEditingProduct}
          onRemove={removeProduct}
          onImport={importProducts}
          onTemplate={exportTemplate}
          onPaymentQr={uploadPaymentQr}
          onBackup={exportBackup}
          onRestore={restoreBackup}
          onSqbSettings={() => setSqbSettingsOpen(true)}
        />
        </div>
      )}

      {activeTab === 'orders' && (
        <OrdersView
          readOnly={financiallyLocked}
          orders={ledgerResult.orders}
          selectedDate={selectedOrderDate}
          setSelectedDate={setSelectedOrderDate}
          search={ledgerSearch}
          setSearch={setLedgerSearch}
          selectedTotal={ledgerResult.net}
          selectedSubtotal={ledgerResult.received}
          selectedDiscount={ledgerResult.refunded}
          onEdit={(order) => order.payment?.provider === 'sqb' ? openAfterSales(order, 'exchange') : setEditingOrder(order)}
          onCancel={cancelOrder}
          onConfirmLegacy={confirmLegacyOrder}
          onExport={() => exportOrders(true)}
        />
      )}

      {activeTab === 'promos' && (
        <div inert={reviewingPayment || online && (financiallyLocked || online.session.user.role !== 'admin') ? '' : undefined}>
        <section className="workspace fullWorkspace">
          <div className="sectionHeader"><h2>赠品规则</h2></div>
          <PromoRulesPanel key={online ? `${Boolean(lease?.mine)}:${JSON.stringify(promoRules)}` : 'local'} rules={promoRules} saleProducts={saleProducts} giftProducts={giftProducts}
            onSave={savePromoRule} onToggle={togglePromoRule} onRemove={removePromoRule} />
        </section>
        </div>
      )}

      {activeTab === 'coupons' && <div inert={!online && reviewingPayment ? '' : undefined}><CouponManager products={products} canRecover={!online || !!lease?.mine} /></div>}
      {activeTab === 'lottery' && <div inert={!online && reviewingPayment ? '' : undefined}><LotteryWorkspace products={products} onCashier={() => setActiveTab('cashier')} /></div>}
      {online && activeTab === 'account' && <OnlineAccountPage user={online.session.user} onImport={bundle => cloudCommand('initial-import', { bundle })} />}

      <nav ref={bottomNavRef} className="bottomNav" aria-label="主导航">
        <button aria-current={activeTab === 'cashier' ? 'page' : undefined} className={activeTab === 'cashier' ? 'active' : ''} onClick={() => setActiveTab('cashier')}>
          <ShoppingCart size={20} /> 收银
        </button>
        <button aria-current={activeTab === 'products' ? 'page' : undefined} className={activeTab === 'products' ? 'active' : ''} onClick={() => setActiveTab('products')}>
          <PackagePlus size={20} /> 商品
        </button>
        <button aria-current={activeTab === 'orders' ? 'page' : undefined} className={activeTab === 'orders' ? 'active' : ''} onClick={() => setActiveTab('orders')}>
          <History size={20} /> 流水
        </button>
        <button aria-current={activeTab === 'promos' ? 'page' : undefined} className={activeTab === 'promos' ? 'active' : ''} onClick={() => setActiveTab('promos')}>
          <Gift size={20} /> 赠品
        </button>
        <button aria-current={activeTab === 'coupons' ? 'page' : undefined} className={activeTab === 'coupons' ? 'active' : ''} onClick={() => setActiveTab('coupons')}>
          <Ticket size={20} /> 券管理
        </button>
        <button aria-current={activeTab === 'lottery' ? 'page' : undefined} className={activeTab === 'lottery' ? 'active' : ''} onClick={() => setActiveTab('lottery')}>
          <Dices size={20} /> 抽奖
        </button>
      </nav>
      </div>
      {(couponBusy || couponRecovery) && <div className="modalBackdrop couponProgress"><div className="modal" role="dialog" aria-modal="true" aria-label="券状态处理"><h2>{couponBusy ? '正在处理优惠券' : '正在核对零元结算'}</h2><p role="status">{couponBusy ? '请稍候' : recoveryMessage || '请保持联网，勿重复结算'}</p>{!couponBusy && <button className="utilityButton" onClick={recoverTransactions}><RefreshCw size={18} /> 重试核对</button>}</div></div>}
      {(!online && (!restoreReady || !startupReady) || backupBusy) && <div className="modalBackdrop"><div className="modal" role="dialog" aria-modal="true" aria-label="备份恢复"><h2>{backupBusy ? '正在处理备份' : '正在核对账务'}</h2><p role="status">{recoveryMessage || (online ? '正在处理云端经营数据' : '正在核对本地经营数据和支付记录')}</p>{!backupBusy && <button className="utilityButton" onClick={recoverTransactions}><RefreshCw size={18} /> 重试对账</button>}</div></div>}

      {scannerOpen && <ScannerModal onClose={() => setScannerOpen(false)} onDetected={scanBarcode} />}
      {editingProduct && (
        <ProductModal product={editingProduct} onClose={() => setEditingProduct(null)} onSave={saveProduct} />
      )}
      {paymentOrder && (
        <PaymentModal
          order={paymentOrder}
          paymentQr={paymentQr}
          onClose={cancelPayment}
          onPaid={markPaid}
          onZero={makeZeroOrder}
          onHold={async () => { if (await holdCart()) setPaymentOrder(null); }}
        />
      )}
      {editingOrder && <OrderEditModal order={editingOrder} products={products} onClose={() => setEditingOrder(null)} onSave={saveOrderEdit} />}
      {afterSalesOrder?.order && <AfterSalesModal key={afterSalesOrder.order.id} order={afterSalesOrder.order} products={products}
        initialType={afterSalesOrder.type} pending={pendingAdjustment} onBeforeStart={beforeAfterSalesStart} onRecord={applyAfterSalesRecord}
        onClose={(record) => closeAfterSales(record).catch((issue) => flash(issue.message))} />}
      {sqbOrder && !sqbSettingsOpen && <SqbPaymentModal key={sqbOrder.id} order={sqbOrder} pending={pendingPayment}
        onBeforeStart={beforeSqbStart} onRecord={applySqbRecord} onClose={closeSqb}
        onSettings={() => setSqbSettingsOpen(true)} />}
      {sqbSettingsOpen && <SqbSettings onClose={() => setSqbSettingsOpen(false)} />}
      {heldPanelOpen && <HeldCartsModal heldCarts={heldCarts} onClose={() => setHeldPanelOpen(false)} onResume={resumeCart} onDelete={deleteHeldCart} />}
      {giftChoicePanelOpen && giftChoiceQueue[0] && (
        <GiftChoiceModal
          choice={giftChoiceQueue[0]}
          products={products}
          cart={cart}
          onChoose={choosePromoGift}
          onClose={() => setGiftChoicePanelOpen(false)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

function SearchBox({ query, setQuery }) {
  return (
    <label className="searchBox">
      <Search size={18} />
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索商品名、条码或编码" />
    </label>
  );
}

function GroupFilter({ groups, activeGroup, setActiveGroup }) {
  return (
    <div className="groupFilter" aria-label="商品分组筛选">
      {groups.map((group) => (
        <button
          key={group}
          className={activeGroup === group ? 'active' : ''}
          onClick={() => setActiveGroup(group)}
        >
          <Tags size={15} />
          {group}
        </button>
      ))}
    </div>
  );
}

function CashierView(props) {
  const {
    products,
    groups,
    activeGroup,
    setActiveGroup,
    cart,
    query,
    setQuery,
    barcodeInput,
    setBarcodeInput,
    scanBarcode,
    addToCart,
    changeQty,
    changeDiscount,
    giftChoiceQueue,
    onOpenGiftChoice,
    checkout,
    cartTotal,
    cartSubtotal,
    cartDiscount,
    openScanner,
    onHold,
    onShowHeld,
    heldCount,
  } = props;

  return (
    <section className="workspace">
      <div className="scanPanel">
        <button className="scanButton" onClick={openScanner}>
          <Camera size={24} />
          打开摄像头扫码
        </button>
        <form
          className="barcodeForm"
          onSubmit={(event) => {
            event.preventDefault();
            scanBarcode(barcodeInput);
          }}
        >
          <Barcode size={20} />
          <input
            value={barcodeInput}
            aria-label="商品或优惠券条码"
            autoComplete="off"
            placeholder="商品 / 优惠券条码"
            onChange={(event) => setBarcodeInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Tab' && barcodeInput.trim()) { event.preventDefault(); scanBarcode(barcodeInput); } }}
          />
          <button type="submit">确认</button>
        </form>
      </div>

      <SearchBox query={query} setQuery={setQuery} />
      <GroupFilter groups={groups} activeGroup={activeGroup} setActiveGroup={setActiveGroup} />

      <div className="productGrid">
        {products.map((product) => (
          <button
            className="productCard"
            key={product.id}
            onClick={() => addToCart(product)}
            disabled={!isCoupon(product) && Number(product.stock || 0) <= 0}
          >
            <ProductImage product={product} />
            <b className={`typeBadge ${isCoupon(product) ? 'coupon' : product.productType === 'gift' ? 'gift' : ''}`}>
              {productTypeLabel(product.productType)}{product.productType === 'sale' && canBePromoGift(product) ? ' · 可赠送' : ''}
            </b>
            <span>{product.name}</span>
            <strong>{isCoupon(product) ? `抵扣 ${money(product.couponAmount)}` : money(product.price)}</strong>
            <small>{product.barcode}</small>
            <small>{product.group || '未分组'} · {product.sku || '无编码'} · {isCoupon(product) ? '每单限一张' : `库存 ${product.stock}`}</small>
            {!isCoupon(product) && Number(product.stock || 0) <= 0 && <em>无库存</em>}
          </button>
        ))}
      </div>

      <aside className="cartPanel">
        <div className="panelTitle">
          <h2>购物车</h2>
          <span>{money(cartTotal)}</span>
        </div>
        <div className="cartActions">
          <button className="utilityButton" onClick={onHold} disabled={!cart.length}><Pause size={16} /> 挂起</button>
          <button className="utilityButton" onClick={onShowHeld}><Play size={16} /> 挂单 ({heldCount})</button>
        </div>
        {cart.length === 0 ? (
          <div className="empty">扫码或点商品开始收银</div>
        ) : (
          <div className="cartList">
            {cart.map((item) => isCoupon(item) ? (
              <div className="cartItem couponLine" key={basketLineKey(item)}>
                <div><strong><Ticket size={16} /> {item.name}</strong><span>券面额 {money(item.couponAmount)} · 每单一张</span>
                  <span>本单抵扣 {money(item.couponDeduction)}</span><b>-{money(item.couponDeduction)}</b></div>
                <button className="dangerIcon" aria-label={`移除优惠券${item.name}`} title="移除优惠券" onClick={() => changeQty(basketLineKey(item), -1)}><Trash2 size={18} /></button>
              </div>
            ) : (
              <div className="cartItem" key={basketLineKey(item)}>
                <div>
                  <strong>{item.name}</strong>
                  {item.source === 'promo' && <b className="cartTag">活动赠送 · 免费</b>}{isExternalPhysical(item) && <b className="cartTag">抽奖赠品 · 免费</b>}
                  <span>{money(item.price)} × {item.qty} · 库存 {item.stock}</span>
                  <span>原小计 {money(item.price * item.qty)}</span>
                  {giftChoiceQueue
                    .filter((choice) => item.productType === 'sale' && choice.mainProductId === item.id)
                    .map((choice) => (
                      <button className="chooseGiftButton" key={choice.id} onClick={() => onOpenGiftChoice(choice.id)}>
                        <Gift size={16} /> 选择赠品
                      </button>
                    ))}
                  <label className="discountInput">
                    优惠
                    <input
                      value={item.discount || ''}
                      disabled={item.productType === 'gift'}
                      inputMode="decimal"
                      placeholder="0"
                      onChange={(event) => changeDiscount(basketLineKey(item), event.target.value)}
                    />
                  </label>
                  <span>优惠后 {money(Math.max(0, item.price * item.qty - clampNumber(item.discount, 0, item.price * item.qty)))}</span>
                </div>
                <div className="qty">
                  <button aria-label="减少数量" onClick={() => changeQty(basketLineKey(item), -1)}>
                    <Minus size={16} />
                  </button>
                  <b>{item.qty}</b>
                  <button
                    aria-label="增加数量"
                    onClick={() => (item.productType === 'gift' ? changeQty(basketLineKey(item), 1) : addToCart(item))}
                    disabled={isExternalPhysical(item) || cart.filter(line => line.id === item.id).reduce((sum, line) => sum + line.qty, 0) >= Number(item.stock || 0)}
                  >
                    <Plus size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="cartTotals">
          <span>商品原金额 <b>{money(cartSubtotal)}</b></span>
          <span>优惠金额 <b>{money(cartDiscount)}</b></span>
          <strong>实收 {money(cartTotal)}</strong>
        </div>
        <div className="payBar">
          <button disabled={!cart.some((item) => !isCoupon(item))} onClick={() => checkout('0元出库')}>0元出库</button>
          <button disabled={!cart.some((item) => !isCoupon(item))} onClick={() => checkout('扫码收款')}>
            <WalletCards size={18} /> 生成收款码
          </button>
        </div>
        <button className="submitButton sqbCheckout" disabled={!cart.some((item) => !isCoupon(item))} onClick={() => checkout('收钱吧')}><Barcode size={18} /> {cart.length && cartTotal === 0 ? '零元结算' : '收钱吧收款'}</button>
      </aside>
    </section>
  );
}

function ProductsView({
  online = false,
  products,
  groups,
  activeGroup,
  setActiveGroup,
  query,
  setQuery,
  paymentQr,
  onNew,
  onEdit,
  onRemove,
  onImport,
  onTemplate,
  onPaymentQr,
  onBackup,
  onRestore,
  onSqbSettings,
}) {
  const importRef = useRef(null);
  const qrRef = useRef(null);
  const backupRef = useRef(null);

  return (
    <section className="workspace fullWorkspace">
      <div className="sectionHeader">
        <h2>商品管理</h2>
        <button className="primarySmall" onClick={onNew}>
          <Plus size={18} /> 新商品
        </button>
      </div>

      <div className="importPanel">
        <button className="utilityButton" onClick={onSqbSettings}><WalletCards size={18} /> 收钱吧设置</button>
        <button className="utilityButton" onClick={() => importRef.current?.click()}>
          <Upload size={18} /> 导入商品
        </button>
        <button className="utilityButton" onClick={onTemplate}>
          <FileSpreadsheet size={18} /> 下载模板
        </button>
        <button className="utilityButton" onClick={() => qrRef.current?.click()}>
          <ImagePlus size={18} /> {paymentQr ? '更换收款码' : '上传收款码'}
        </button>
        <button className="utilityButton" onClick={onBackup}>
          <Download size={18} /> 导出备份
        </button>
        <button className="utilityButton" onClick={() => online ? onRestore() : backupRef.current?.click()}>
          <Upload size={18} /> {online ? '资料迁移' : '恢复备份'}
        </button>
        <input
          ref={importRef}
          className="hiddenInput"
          type="file"
          accept=".csv,.xlsx,.xls"
          onChange={(event) => {
            onImport(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <input
          ref={qrRef}
          className="hiddenInput"
          type="file"
          accept="image/*"
          onChange={(event) => {
            onPaymentQr(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <input
          ref={backupRef}
          className="hiddenInput"
          type="file"
          accept=".json,application/json"
          onChange={(event) => {
            onRestore(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <p>商品类型：售卖品 / 赠品 / 优惠券。优惠券金额使用“抵扣金额”列，条码列使用文本格式。</p>
        <p>{online ? '资料统一保存在云端，换电脑后登录即可继续使用。原本机资料请通过“资料迁移”导入空的云端账本。' : '换电脑时请先“导出备份”，在新电脑打开系统后用“恢复备份”一次性导入商品、图片、订单流水、收款码和加赠规则。'}</p>
      </div>

      <SearchBox query={query} setQuery={setQuery} />
      <GroupFilter groups={groups} activeGroup={activeGroup} setActiveGroup={setActiveGroup} />
      <div className="inventoryList">
        {products.map((product) => (
          <article className="inventoryRow" key={product.id}>
            <ProductImage product={product} />
            <button onClick={() => onEdit(product)}>
              <strong>{product.name}</strong>
              <span>{productTypeLabel(product.productType)}{product.productType === 'sale' && canBePromoGift(product) ? ' · 可参与买赠' : ''} · {product.group || '未分组'} · {product.barcode} · {product.sku || '无编码'}</span>
            </button>
            <div>
              <b>{isCoupon(product) ? `抵扣 ${money(product.couponAmount)}` : money(product.price)}</b>
              <small>{isCoupon(product) ? '每单一张 · 不扣库存' : `原价 ${money(product.originalPrice)} · 库存 ${product.stock}`}</small>
            </div>
            <button className="dangerIcon" aria-label="删除商品" onClick={() => onRemove(product.id)}>
              <Trash2 size={18} />
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function PromoRulesPanel({ rules, saleProducts, giftProducts, onSave, onToggle, onRemove }) {
  function newDraft() {
    return {
      id: crypto.randomUUID(),
      enabled: true,
      mode: 'all',
      mainProductIds: saleProducts[0]?.id ? [saleProducts[0].id] : [],
      stackable: true,
      gifts: [{ productId: giftProducts[0]?.id || '', qty: 1 }],
      startAt: '',
      endAt: '',
    };
  }

  const [draft, setDraft] = useState(() => ({
    id: crypto.randomUUID(),
    enabled: true,
    mode: 'all',
    mainProductIds: [],
    stackable: true,
    gifts: [{ productId: '', qty: 1 }],
    startAt: '',
    endAt: '',
  }));

  useEffect(() => {
    setDraft((current) => ({
      ...current,
      mainProductIds: current.mainProductIds.length ? current.mainProductIds : (saleProducts[0]?.id ? [saleProducts[0].id] : []),
      gifts: current.gifts.map((gift) => ({
        ...gift,
        productId: gift.productId || giftProducts[0]?.id || '',
      })),
    }));
  }, [giftProducts, saleProducts]);

  function updateDraft(field, value) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function toggleMainProduct(productId) {
    setDraft((current) => {
      const selected = current.mainProductIds.includes(productId);
      return {
        ...current,
        mainProductIds: selected
          ? current.mainProductIds.filter((id) => id !== productId)
          : [...current.mainProductIds, productId],
      };
    });
  }

  function setAllMainProducts(selected) {
    setDraft((current) => ({
      ...current,
      mainProductIds: selected ? saleProducts.map((product) => product.id) : [],
    }));
  }

  function updateGift(index, field, value) {
    setDraft((current) => ({
      ...current,
      gifts: current.gifts.map((gift, giftIndex) => (giftIndex === index ? { ...gift, [field]: value } : gift)),
    }));
  }

  function addGiftRow() {
    setDraft((current) => ({
      ...current,
      gifts: [...current.gifts, { productId: giftProducts[0]?.id || '', qty: 1 }],
    }));
  }

  function removeGiftRow(index) {
    setDraft((current) => ({
      ...current,
      gifts: current.gifts.filter((_, giftIndex) => giftIndex !== index),
    }));
  }

  async function submitRule(event) {
    event.preventDefault();
    if (await onSave(draft)) setDraft(newDraft());
  }

  function editRule(rule) {
    setDraft({
      ...rule,
      mainProductIds: rule.mainProductIds.length ? rule.mainProductIds : [],
      gifts: rule.gifts.length ? rule.gifts : [{ productId: giftProducts[0]?.id || '', qty: 1 }],
    });
  }

  function productName(productId) {
    return saleProducts.find((product) => product.id === productId)?.name
      || giftProducts.find((product) => product.id === productId)?.name
      || '商品已删除';
  }

  function mainProductsLabel(rule) {
    if (rule.mainProductIds.length === saleProducts.length && saleProducts.length) return '全部售卖品';
    return rule.mainProductIds.map(productName).join(' / ') || '未选择主品';
  }

  function ruleStatus(rule) {
    if (!rule.enabled) return '已停用';
    return isPromoRuleActive(rule) ? '生效中' : '未到时间';
  }

  const canCreate = saleProducts.length > 0 && giftProducts.length > 0;
  const modeLabel = draft.mode === 'choice' ? '二选一/多选一' : '全部赠送';
  const selectedMainProducts = saleProducts.filter((product) => draft.mainProductIds.includes(product.id));

  return (
    <div className="promoPanel">
      <div className="panelTitle">
        <h3><Gift size={18} /> 加赠玩法</h3>
        <span>{rules.filter((rule) => rule.enabled).length} 个启用</span>
      </div>

      <form className="promoForm" onSubmit={submitRule}>
        <label>
          玩法
          <select value={draft.mode} onChange={(event) => updateDraft('mode', event.target.value)} disabled={!canCreate}>
            <option value="all">全部赠送</option>
            <option value="choice">二选一/多选一</option>
          </select>
        </label>
        <label>
          赠品是否叠加
          <select
            value={draft.stackable ? 'stackable' : 'once'}
            onChange={(event) => updateDraft('stackable', event.target.value === 'stackable')}
            disabled={!canCreate}
          >
            <option value="stackable">叠加赠送</option>
            <option value="once">不叠加</option>
          </select>
        </label>
        <div className="mainProductPicker">
          <div>
            <span>主品 <b>已选 {selectedMainProducts.length}/{saleProducts.length}</b></span>
            <div className="pickerActions">
              <button type="button" className="toggleButton" onClick={() => setAllMainProducts(true)} disabled={!canCreate}>
                全选
              </button>
              <button type="button" className="toggleButton" onClick={() => setAllMainProducts(false)} disabled={!canCreate}>
                清空
              </button>
            </div>
          </div>
          <div className={selectedMainProducts.length ? 'selectedMainSummary active' : 'selectedMainSummary'}>
            {selectedMainProducts.length
              ? selectedMainProducts.map((product) => <span key={product.id}>{product.name}</span>)
              : '还没有选择主品'}
          </div>
          <div className="checkGrid">
            {saleProducts.map((product) => (
              <label
                className={draft.mainProductIds.includes(product.id) ? 'checkTile selected' : 'checkTile'}
                key={product.id}
              >
                <input
                  type="checkbox"
                  checked={draft.mainProductIds.includes(product.id)}
                  onChange={() => toggleMainProduct(product.id)}
                  disabled={!canCreate}
                />
                <span>{product.name}</span>
                {draft.mainProductIds.includes(product.id) && <Check size={17} />}
              </label>
            ))}
          </div>
        </div>
        <div className="giftRows">
          <span>{modeLabel}赠品</span>
          {draft.gifts.map((gift, index) => (
            <div className="giftRow" key={`${draft.id}-${index}`}>
              <select
                value={gift.productId}
                aria-label={`赠品${index + 1}`}
                onChange={(event) => updateGift(index, 'productId', event.target.value)}
                disabled={!canCreate}
              >
                {giftProducts.map((product) => (
                  <option value={product.id} key={product.id}>{product.name}{product.productType === 'sale' ? '（可售可赠）' : ''}</option>
                ))}
              </select>
              <input
                value={gift.qty}
                type="number"
                min="1"
                inputMode="numeric"
                aria-label={`赠品${index + 1}数量`}
                onChange={(event) => updateGift(index, 'qty', event.target.value)}
                disabled={!canCreate}
              />
              <button
                className="dangerIcon"
                type="button"
                aria-label={`删除赠品${index + 1}`}
                onClick={() => removeGiftRow(index)}
                disabled={draft.gifts.length <= 1}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          <button className="utilityButton" type="button" onClick={addGiftRow} disabled={!canCreate}>
            <Plus size={18} /> 增加赠品
          </button>
        </div>
        <label>
          开始时间
          <input
            value={draft.startAt}
            type="datetime-local"
            onChange={(event) => updateDraft('startAt', event.target.value)}
            disabled={!canCreate}
          />
        </label>
        <label>
          结束时间
          <input
            value={draft.endAt}
            type="datetime-local"
            onChange={(event) => updateDraft('endAt', event.target.value)}
            disabled={!canCreate}
          />
        </label>
        <button className="primarySmall" type="submit" disabled={!canCreate}>
          <Plus size={18} /> 保存规则
        </button>
      </form>

      {!canCreate && (
        <p className="mutedNote">暂无可配置组合：需要售卖品，以及赠品或已启用买赠的售卖品。</p>
      )}

      <div className="promoList">
        {rules.length === 0 ? (
          <div className="empty">还没有加赠规则</div>
        ) : (
          rules.map((rule) => (
            <article className="promoRow" key={rule.id}>
              <div>
                <strong>
                  {mainProductsLabel(rule)}
                  {rule.mode === 'choice' ? ' 可选 ' : ' 送 '}
                  {rule.gifts.map((gift) => `${productName(gift.productId)} × ${gift.qty}`).join(' / ')}
                </strong>
                <span>
                  {rule.mode === 'choice' ? '二选一/多选一' : '全部赠送'} · {ruleStatus(rule)}
                  {rule.stackable ? ' · 叠加赠送' : ' · 不叠加'}
                  {rule.startAt ? ` · ${new Date(rule.startAt).toLocaleString('zh-CN')}` : ' · 不限开始'}
                  {rule.endAt ? ` 至 ${new Date(rule.endAt).toLocaleString('zh-CN')}` : ' 至 不限结束'}
                </span>
              </div>
              <div className="promoActions">
                <button className="toggleButton" onClick={() => editRule(rule)}>
                  编辑
                </button>
                <button className={rule.enabled ? 'toggleButton active' : 'toggleButton'} onClick={() => onToggle(rule.id)}>
                  {rule.enabled ? '启用' : '停用'}
                </button>
                <button className="dangerIcon" aria-label="删除加赠规则" onClick={() => onRemove(rule.id)}>
                  <Trash2 size={18} />
                </button>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}

function GiftChoiceModal({ choice, products, cart, onChoose, onClose }) {
  return (
    <div className="modalBackdrop">
      <div className="modal giftChoiceModal">
        <div className="modalHead">
          <h2>选择赠品</h2>
          <button className="iconButton" onClick={onClose} aria-label="稍后选择">
            <X size={20} />
          </button>
        </div>
        <p className="mutedNote">{choice.mainProductName} 已加入购物车，请选择本次要赠送的商品。</p>
        <div className="giftChoiceList">
          {choice.gifts.map((gift) => {
            const product = products.find((item) => item.id === gift.productId && canBePromoGift(item));
            const stock = Math.max(0, Number(product?.stock || 0) - cart.filter(item => item.id === gift.productId).reduce((sum, item) => sum + Number(item.qty), 0));
            return (
              <button
                className="giftChoiceCard"
                key={`${choice.id}-${gift.productId}`}
                onClick={() => onChoose(choice, gift.productId)}
                disabled={stock < gift.qty}
              >
                <ProductImage product={product || { name: gift.name }} />
                <span>{gift.name}</span>
                <strong>赠送 × {gift.qty}</strong>
                <small>可用库存 {stock}</small>
                {stock < gift.qty && <em>库存不足</em>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ProductImage({ product }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [product.imageUrl]);

  if (product.imageUrl && !failed) {
    return (
      <img
        className="productImage"
        src={product.imageUrl}
        alt={product.name || '商品图片'}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div className="productImage placeholder" aria-hidden="true">
      <PackagePlus size={22} />
    </div>
  );
}

function OrdersView({
  readOnly = false,
  orders,
  selectedDate,
  setSelectedDate,
  search,
  setSearch,
  selectedTotal,
  selectedSubtotal,
  selectedDiscount,
  onEdit,
  onCancel,
  onConfirmLegacy,
  onExport,
}) {
  const [field, setField] = useState(search.field);
  const [keyword, setKeyword] = useState(search.keyword);
  const activeField = LEDGER_SEARCH_FIELDS.find(item => item.id === search.field);
  const draftField = LEDGER_SEARCH_FIELDS.find(item => item.id === field);
  const hasSearch = !!search.keyword;
  const dirty = field !== search.field || keyword.trim() !== search.keyword;
  const scopeLabel = selectedDate || '全部日期';
  function resetSearch() {
    setField(''); setKeyword(''); setSearch({ field: '', keyword: '' });
  }
  return (
    <section className="workspace fullWorkspace">
      <div className="sectionHeader">
        <h2>收款流水</h2>
        <span>{hasSearch ? '匹配 ' : ''}{orders.length} 笔</span>
      </div>
      <div className="datePanel">
        <label>
          查看日期
          <input
            type="date"
            value={selectedDate}
            onChange={(event) => setSelectedDate(event.target.value)}
          />
        </label>
        <button className="utilityButton" onClick={() => setSelectedDate(todayKey())}>回到今天</button>
        <button className="utilityButton" aria-pressed={!selectedDate} onClick={() => setSelectedDate('')}>全部日期</button>
      </div>
      <form className="ledgerSearch" aria-label="流水查询" onSubmit={(event) => {
        event.preventDefault();
        if (field && keyword.trim()) setSearch({ field, keyword: keyword.trim() });
      }}>
        <label>查询字段
          <select aria-label="查询字段" value={field} onChange={event => { setField(event.target.value); setKeyword(''); }}>
            <option value="">请选择查询字段</option>
            {LEDGER_SEARCH_GROUPS.map(group => <optgroup key={group} label={group}>
              {LEDGER_SEARCH_FIELDS.filter(item => item.group === group).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </optgroup>)}
          </select>
        </label>
        <label>查询内容
          <input type="search" value={keyword} disabled={!field} maxLength={200}
            inputMode={draftField?.kind === 'money' ? 'decimal' : draftField?.kind === 'number' ? 'numeric' : 'text'}
            placeholder={!field ? '先选择字段' : draftField?.kind === 'money' ? '金额（元）' : draftField?.kind === 'number' ? '数量' : '输入查询内容'}
            onChange={event => setKeyword(event.target.value)} />
        </label>
        <div className="ledgerSearchActions">
          <button type="submit" className="primarySmall" disabled={!field || !keyword.trim()}><Search size={18} /> 查询</button>
          <button type="button" className="utilityButton" onClick={resetSearch} disabled={!field && !keyword && !hasSearch}><RefreshCw size={18} /> 重置</button>
        </div>
      </form>
      <div className="ledgerResultBar">
        <div role="status" aria-live="polite">
          <span>{scopeLabel}{hasSearch ? ` · ${activeField?.label}：${search.keyword}` : ' · 全部流水'}</span>
          {dirty && <small>查询条件已修改，尚未应用</small>}
        </div>
        <button className="utilityButton" onClick={onExport} disabled={!orders.length || dirty}><Download size={18} /> {hasSearch ? '导出匹配订单明细' : selectedDate ? '导出当天明细' : '导出全部明细'}</button>
      </div>
      <div className="orderSummary">
        <div>
          <span>{hasSearch ? '匹配订单净收入' : selectedDate ? '当天净收入' : '全部净收入'}</span>
          <strong>{money(selectedTotal)}</strong>
        </div>
        <div>
          <span>{hasSearch ? '匹配订单收款' : selectedDate ? '当天收款' : '全部收款'}</span>
          <strong>{money(selectedSubtotal)}</strong>
        </div>
        <div>
          <span>{hasSearch ? '匹配订单退款' : selectedDate ? '当天退款' : '全部退款'}</span>
          <strong>{money(selectedDiscount)}</strong>
        </div>
      </div>
      {orders.length === 0 ? (
        <div className="empty">{hasSearch ? '没有符合查询条件的流水' : selectedDate ? '这个日期还没有收款记录' : '暂无收款记录'}</div>
      ) : (
        <div className="orderList">
          {orders.map((order) => (
            <article className="orderRow" key={order.id}>
              <div>
                <strong>订单净额 {money(orderNet(order))}</strong>
                <span>{new Date(transactionTime(order.payment?.tenders, order.paidAt || order.createdAt)).toLocaleString('zh-CN')} · {order.method}</span>
                <small>原金额 {money(order.subtotal ?? order.total)} · 优惠 {money(order.discount || 0)}</small>
                <small className="receiptSerial">流水号 {orderSerial(order) || '待补齐收钱吧流水号'} · {orderDisplayStatus(order)}</small>
                {order.payment?.orderSn && <small>本地订单 {order.orderNo} · 收钱吧轻POS订单号 {order.payment.orderSn}</small>}
                {order.payment?.mode === 'test' && <small className="dangerText">测试商户交易</small>}
                {order.payment?.tenders?.map((tender) => <small key={tender.tenderSn}>{channelName(tender)} · 原支付 {(tender.amount / 100).toFixed(2)} 元{tender.internalTransactionSn ? ` · 流水号 ${tender.internalTransactionSn}` : ''}</small>)}
                {order.payment?.provider === 'sqb' && <small>渠道顾客实付 {tenderTotals(order.payment.tenders, 'paidAmount') == null ? '未返回' : money(tenderTotals(order.payment.tenders, 'paidAmount'))} · 渠道商户实收 {tenderTotals(order.payment.tenders, 'collectedAmount') == null ? '未返回' : money(tenderTotals(order.payment.tenders, 'collectedAmount'))}</small>}
                {order.items.some(isExternalPhysical) && <small>{order.physicalFulfilled ? '实物奖品已核销' : '实物奖品领取确认待同步'}</small>}<small>原商品：{order.items.map((item) => `${item.name} × ${item.qty}`).join('，')}</small>
                {!!order.afterSales?.length && <small>当前商品：{remainingLines(order).map((item) => `${item.name} × ${item.qty}`).join('，') || '已全部退回'}</small>}
                {!!order.afterSales?.length && <details className="afterSalesHistory"><summary>退换货记录 ({order.afterSales.length})</summary>
                  {order.afterSales.map((entry) => <div key={entry.id}><b>{entry.plan.deltaCents < 0 ? '已退款' : entry.plan.deltaCents > 0 ? '已补款' : '零差价调整'} {money(Math.abs(entry.plan.deltaCents) / 100)}</b>
                    <small>{new Date(transactionTime(entry.tenders, entry.completedAt)).toLocaleString('zh-CN')} · {entry.orderSn || entry.id}</small>
                    <small>退回：{entry.plan.returns.map((item) => `${item.name} × ${item.qty}（入库 ${item.restockQty}）`).join('，')}</small>
                    {!!entry.plan.newLines.length && <small>换出：{entry.plan.newLines.map((item) => `${item.name} × ${item.qty}`).join('，')}</small>}
                    {!!entry.tenders?.length && <small>流水号 {entry.tenders.map((item) => item.internalTransactionSn || item.tenderSn).join(' / ')}</small>}
                    {entry.plan.reason && <small>原因：{entry.plan.reason}</small>}
                  </div>)}
                </details>}
                {order.updatedAt && <small>更新于 {new Date(order.updatedAt).toLocaleString('zh-CN')} · {(order.revisions?.length || 0) + (order.afterSales?.length || 0)} 次变更</small>}
              </div>
              {order.status !== '已取消' && <div className="orderActions">
                {order.status === '待收款'
                  ? <button className="utilityButton" disabled={readOnly} onClick={() => onConfirmLegacy(order.id)}><Check size={16} /> 确认收款</button>
                  : <button className="utilityButton" disabled={readOnly} onClick={() => onEdit(order)}><Pencil size={16} /> 编辑 / 换货</button>}
                <button className="linkButton dangerText" disabled={readOnly} onClick={() => onCancel(order.id)}>{order.payment?.provider === 'sqb' ? '退货 / 取消并退款' : '取消订单'}</button>
              </div>}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function HeldCartsModal({ heldCarts, onClose, onResume, onDelete }) {
  return <div className="modalBackdrop"><div className="modal heldModal" role="dialog" aria-modal="true" aria-label="挂单">
    <div className="modalHead"><h2>挂单 ({heldCarts.length})</h2><button className="iconButton" aria-label="关闭挂单" onClick={onClose}><X size={20} /></button></div>
    <div className="modalScroll">
      {!heldCarts.length && <div className="empty">暂无挂单</div>}
      {heldCarts.map((held) => <article className="orderRow" key={held.id}>
        <div><strong>{money(priceOrder(held.items).total)}</strong><span>{new Date(held.createdAt).toLocaleString('zh-CN')}</span>
          <small>{held.items.map((item) => `${item.name} × ${item.qty}`).join('，')}</small>
          {!!held.giftChoiceQueue?.length && <small>待选赠品 {held.giftChoiceQueue.length} 组</small>}
        </div>
        <div className="orderActions"><button className="utilityButton" onClick={() => onResume(held.id)}><Play size={16} /> 取单</button>
          <button className="dangerIcon" aria-label="删除挂单" onClick={() => onDelete(held.id)}><Trash2 size={16} /></button></div>
      </article>)}
    </div>
  </div></div>;
}

function OrderEditModal({ order, products, onClose, onSave }) {
  const [items, setItems] = useState(() => order.items.map((item) => ({ ...item, editKey: crypto.randomUUID() })));
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState('');
  const [settled, setSettled] = useState(false);
  const zero = order.method === '0元出库';
  const available = products.filter((product) => (!isCoupon(product) || !items.some(isCoupon)) && [product.name, product.barcode, product.sku].some((value) => String(value || '').toLowerCase().includes(search.toLowerCase())));
  let priced;
  let error = '';
  try { priced = priceOrder(items, zero); } catch (issue) { error = issue.message; }
  const difference = priced ? Math.round((priced.total - order.total) * 100) / 100 : 0;
  function update(index, field, value) {
    setItems((current) => current.map((item, position) => position === index ? { ...item, [field]: value } : item));
    setSettled(false);
  }
  function addProduct() {
    const product = products.find((item) => item.id === selected);
    if (!product || (isCoupon(product) && items.some(isCoupon))) return;
    setItems((current) => [...current, { ...product, qty: 1, price: zero ? 0 : product.price, discount: 0, editKey: crypto.randomUUID() }]);
    setSettled(false);
  }
  return <div className="modalBackdrop"><form className="modal orderEditModal" role="dialog" aria-modal="true" aria-label="编辑换货" onSubmit={(event) => {
    event.preventDefault();
    if (error || (difference !== 0 && !settled)) return;
    onSave(order.id, items.map(({ editKey, ...item }) => item));
  }}>
    <div className="modalHead"><div><h2>编辑 / 换货</h2><small>{orderSerial(order) || '待补齐收钱吧流水号'}</small></div><button type="button" className="iconButton" aria-label="关闭换货" onClick={onClose}><X size={20} /></button></div>
    <div className="modalScroll editItems">
      {order.payment?.provider === 'sqb' && <p className="sqbStatus">原收钱吧交易金额保留。换货差额请另行完成补款或退款。</p>}
      {items.map((item, index) => {
        const stock = Number(products.find((product) => product.id === item.id)?.stock || 0)
          + order.items.filter((original) => original.id === item.id).reduce((sum, original) => sum + original.qty, 0);
        return <article className="editOrderItem" key={item.editKey}>
          <div className="sectionHeader"><div><strong>{item.name}</strong><small>{item.barcode} · {isCoupon(item) ? `优惠券面额 ${money(item.couponAmount)}` : `可用库存 ${stock}`}</small></div>
            <button type="button" className="dangerIcon" aria-label={`移除${item.name}`} onClick={() => { setItems((current) => current.filter((_, position) => position !== index)); setSettled(false); }}><Trash2 size={18} /></button></div>
          {isCoupon(item) ? <p className="couponAmount">抵扣 -{money(priced?.items[index]?.couponDeduction)}</p> : <div className="editLineFields">
            <label>数量<input type="number" min="1" step="1" required value={item.qty} onChange={(event) => update(index, 'qty', event.target.value)} /></label>
            <label>单价<input type="number" min="0" step="0.01" required disabled={zero || item.productType === 'gift'} value={zero ? 0 : item.price} onChange={(event) => update(index, 'price', event.target.value)} /></label>
            <label>优惠金额<input type="number" min="0" step="0.01" disabled={zero || item.productType === 'gift'} value={item.discount || 0} onChange={(event) => update(index, 'discount', event.target.value)} /></label>
          </div>}
        </article>;
      })}
      <div className="exchangePicker">
        <label>查找换入商品<input value={search} onChange={(event) => { setSearch(event.target.value); setSelected(''); }} placeholder="商品名、条码或编码" /></label>
        <label>换入商品<select value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">选择商品</option>{available.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.barcode} · {money(product.price)}</option>)}</select></label>
        <button type="button" className="utilityButton" disabled={!selected} onClick={addProduct}><Plus size={18} /> 加入订单</button>
      </div>
    </div>
    <div className="modalFooter">
      <div className="cartTotals"><span>原订单金额 <b>{money(order.total)}</b></span><strong>换货后金额 {money(priced?.total)}</strong>
        <span>{difference >= 0 ? '需补款' : '需退款'} <b>{money(Math.abs(difference))}</b></span></div>
      {difference !== 0 && <label className="settlementCheck"><input type="checkbox" checked={settled} onChange={(event) => setSettled(event.target.checked)} />已完成{difference > 0 ? '补款' : '退款'} {money(Math.abs(difference))}</label>}
      {error && <p className="dangerText" role="alert">{error}</p>}
      <button className="submitButton" type="submit" disabled={!!error || (difference !== 0 && !settled)}>保存换货</button>
    </div>
  </form></div>;
}

function ProductModal({ product, onClose, onSave }) {
  const [draft, setDraft] = useState(product);
  const imageInputRef = useRef(null);

  function update(field, value) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function uploadProductImage(file) {
    if (!file) return;
    try {
      const dataUrl = await imageFileToDataUrl(file);
      update('imageUrl', dataUrl);
    } catch {
      update('imageUrl', '');
    }
  }

  function updateProductType(value) {
    setDraft((current) => ({
      ...current,
      productType: value,
      giftEligible: value === 'gift' || (value === 'sale' && canBePromoGift(current)),
      price: value !== 'sale' ? 0 : current.price,
      couponAmount: value === 'coupon' ? current.couponAmount || '' : 0,
      stock: value === 'coupon' ? 0 : current.stock,
    }));
  }

  return (
    <div className="modalBackdrop">
      <form
        className="modal productModal"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(draft);
        }}
      >
        <div className="modalHead">
          <h2>{product.name ? '编辑商品' : '新增商品'}</h2>
          <button type="button" className="iconButton" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="productFormBody modalScroll">
        <label>
          产品名称
          <input value={draft.name} onChange={(event) => update('name', event.target.value)} placeholder="例如 柠檬茶" />
        </label>
        <label>
          条码
          <input
            value={draft.barcode}
            autoComplete="off"
            onChange={(event) => update('barcode', event.target.value)}
            placeholder="数字、字母或符号条码"
          />
        </label>
        <label>
          货品编码
          <input value={draft.sku || ''} onChange={(event) => update('sku', event.target.value)} placeholder="例如 DRINK-001" />
        </label>
        <label>
          商品分组
          <input
            value={draft.group || ''}
            onChange={(event) => update('group', event.target.value)}
            placeholder="例如 饮料、饰品、特价区"
          />
        </label>
        <label>
          商品类型
          <select value={draft.productType || 'sale'} onChange={(event) => updateProductType(event.target.value)}>
            <option value="sale">售卖品</option>
            <option value="gift">赠品</option>
            <option value="coupon">优惠券</option>
          </select>
        </label>
        {(draft.productType || 'sale') === 'sale' && <label className="giftEligibility">
          <input type="checkbox" aria-label="可参与买赠" checked={giftEligibility(draft.giftEligible)} onChange={(event) => update('giftEligible', event.target.checked)} />
          <span>可参与买赠</span>
          <b>{giftEligibility(draft.giftEligible) ? '已启用' : '未启用'}</b>
        </label>}
        {isCoupon(draft) && <label>抵扣金额<input type="number" min="0.01" step="0.01" required value={draft.couponAmount || ''} onChange={(event) => update('couponAmount', event.target.value)} placeholder="0.00" /></label>}
        <div className="imageEditor">
          <ProductImage product={draft} />
          <div>
            <button type="button" className="utilityButton" onClick={() => imageInputRef.current?.click()}>
              <ImagePlus size={18} /> 上传商品图片
            </button>
            <button type="button" className="linkButton" onClick={() => update('imageUrl', '')}>清除图片</button>
          </div>
          <input
            ref={imageInputRef}
            className="hiddenInput"
            type="file"
            accept="image/*"
            onChange={(event) => {
              uploadProductImage(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </div>
        <label>
          图片链接
          <input
            value={draft.imageUrl || ''}
            onChange={(event) => update('imageUrl', event.target.value)}
            placeholder="可填图片网址，或直接上传图片"
          />
        </label>
        <div className="fieldGrid">
          <label>
            原价
            <input
              value={draft.originalPrice}
              inputMode="decimal"
              onChange={(event) => update('originalPrice', event.target.value)}
              placeholder="0.00"
            />
          </label>
          <label>
            售价
            <input
              value={draft.price}
              inputMode="decimal"
              disabled={(draft.productType || 'sale') !== 'sale'}
              onChange={(event) => update('price', event.target.value)}
              placeholder="0.00"
            />
          </label>
        </div>
        <label>
          库存数量
          <input
            value={draft.stock}
            disabled={isCoupon(draft)}
            inputMode="numeric"
            onChange={(event) => update('stock', event.target.value)}
            placeholder="0"
          />
        </label>
        </div>
        <div className="modalFooter"><button className="submitButton" type="submit">保存商品</button></div>
      </form>
    </div>
  );
}

function PaymentModal({ order, paymentQr, onClose, onPaid, onZero, onHold }) {
  return (
    <div className="modalBackdrop">
      <div className="paymentModal">
        <div className="modalHead">
          <h2>{order.method === '0元出库' ? '0元出库' : order.total === 0 ? '零元结算' : '订单收款'}</h2>
          <button type="button" className="iconButton" aria-label="取消本次订单" title="取消本次订单" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="payAmount">
          <span>应收金额</span>
          <strong>{money(order.total)}</strong>
          <span>原金额 {money(order.subtotal ?? order.total)} · 优惠 {money(order.discount || 0)}</span>
          <small>{order.orderNo}</small>
        </div>
        {order.method === '0元出库' ? <p className="zeroNotice">本单全部商品按 0 元出库</p> : order.total === 0 ? <p className="zeroNotice">本单无需收款</p> : paymentQr ? (
          <img className="paymentQr" src={paymentQr} alt="收款码" />
        ) : (
          <div className="qrPlaceholder">
            <QrCode size={72} />
            <p>请先在商品管理中上传你的微信或支付宝收款码</p>
          </div>
        )}
        <div className="paymentItems">
          {order.items.map((item) => (
            <span key={`${order.id}-${basketLineKey(item)}`}>
              {item.name} × {item.qty}{isExternalPhysical(item) ? ' · 抽奖赠品 · 免费' : ''}
              {' · '}{isCoupon(item) ? `抵扣 -${money(item.couponDeduction)}` : money(item.price)}
              {item.discount > 0 ? ` · 优惠 ${money(item.discount)}` : ''}
            </span>
          ))}
        </div>
        <div className="modalFooter">
          <div className="cartActions">
            <button className="utilityButton" onClick={onHold}><Pause size={16} /> 挂起</button>
            {order.method !== '0元出库' && <button className="utilityButton" onClick={onZero}>0元出库</button>}
          </div>
          <button className="submitButton" onClick={onPaid}>{order.method === '0元出库' ? '确认0元出库' : order.total === 0 ? '确认零元结算' : '确认收款'}</button>
        </div>
      </div>
    </div>
  );
}

function ScannerModal({ onClose, onDetected }) {
  const videoRef = useRef(null);
  const controlsRef = useRef(null);
  const [status, setStatus] = useState('正在打开摄像头');
  const [manualCode, setManualCode] = useState('');

  useEffect(() => {
    let cancelled = false;
    const reader = new BrowserMultiFormatReader();

    async function start() {
      try {
        controlsRef.current = await reader.decodeFromVideoDevice(
          undefined,
          videoRef.current,
          (result, error, controls) => {
            controlsRef.current = controls;
            if (cancelled || !result) return;
            const code = result.getText();
            controls.stop();
            onDetected(code);
            onClose();
          },
        );
        if (!cancelled) setStatus('把条形码放进取景框');
      } catch {
        if (!cancelled) setStatus('摄像头不可用，请使用手动输入');
      }
    }

    start();
    return () => {
      cancelled = true;
      controlsRef.current?.stop();
    };
  }, [onClose, onDetected]);

  return (
    <div className="modalBackdrop">
      <div className="scanner">
        <div className="modalHead">
          <h2>扫码</h2>
          <button type="button" className="iconButton" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="videoFrame">
          <video ref={videoRef} muted playsInline />
          <div className="scanLine" />
        </div>
        <p>{status}</p>
        <form
          className="barcodeForm"
          onSubmit={(event) => {
            event.preventDefault();
            onDetected(manualCode);
            onClose();
          }}
        >
          <input
            value={manualCode}
            autoComplete="off"
            placeholder="摄像头失败时输入条码"
            onChange={(event) => setManualCode(event.target.value)}
          />
          <button type="submit">使用</button>
        </form>
      </div>
    </div>
  );
}

function CashierSession({ online = null }) {
  const [active, setActive] = useState(Boolean(online) || !navigator.locks);
  useEffect(() => {
    if (online || !navigator.locks) return;
    let release;
    let disposed = false;
    const controller = new AbortController();
    navigator.locks.request('stall-cashier-writer', { signal: controller.signal }, async () => {
      if (disposed) return;
      setActive(true);
      await new Promise((resolve) => { release = resolve; });
    }).catch(() => {});
    return () => { disposed = true; controller.abort(); release?.(); };
  }, []);
  return active ? <App online={online} /> : <main className="sessionWait"><h1>收银台已在其他窗口打开</h1><p>关闭同一收银台的其他窗口后，本页会自动继续。</p></main>;
}

createRoot(document.getElementById('root')).render(<OnlineGate>{online => <CashierSession key={online?.session.user.id || 'local'} online={online} />}</OnlineGate>);
