import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from './lib/motion.js';
import readXlsxFile from 'read-excel-file/browser';
import { Gift, History, PackagePlus, RefreshCw, Settings2, ShoppingCart, Sparkles, Ticket, Wrench } from 'lucide-react';

import { detectOnlineSession, onlineRequest, setOnlineSession } from './api/online.js';
import { sqbCall, notifyConfirmedPayment, enablePaymentNotifications } from './api/sqb.js';

import { shouldReserveAward } from './logic/couponBarcode.js';
import { basketLineKey, isExternalPhysical, isCoupon, isExternalAward, priceOrder, reconcileStock, orderSerial } from './logic/orderLogic.js';
import { addLineToCart, canBePromoGift, promoGiftLine } from './logic/cartLogic.js';
import { financialEvents, financialExportRows, channelName, transactionTime, remainingLines, applyAdjustment, validateAdjustmentStock } from './logic/afterSales.js';
import { createLedgerSearchIndex, queryLedger } from './logic/ledgerSearch.js';
import { completeBrowserPayment, paymentReviewMessage, retainPaymentReview, shouldOpenPayment } from './logic/paymentReview.js';
import { withPipeRetry } from './logic/pipe.js';

import { Aurora, Modal, Toast } from './components/ui.jsx';
import { Navbar } from './components/Navbar.jsx';
import { LoginScreen } from './screens/Login.jsx';
import { PosScreen } from './screens/Pos.jsx';
import { ProductsScreen } from './screens/Products.jsx';
import { OrdersScreen } from './screens/Orders.jsx';
import { CouponsScreen } from './screens/Coupons.jsx';
import { GiftsScreen } from './screens/Gifts.jsx';
import { EventsScreen } from './screens/Events.jsx';
import { MaintenanceScreen } from './screens/Maintenance.jsx';
import { SettingsScreen } from './screens/Settings.jsx';
import { SqbPaymentModal } from './modals/SqbPaymentModal.jsx';
import { PaymentModal } from './modals/PaymentModal.jsx';
import { AfterSalesModal } from './modals/AfterSalesModal.jsx';
import { HeldCartsModal } from './modals/HeldCartsModal.jsx';
import { GiftChoiceModal } from './modals/GiftChoiceModal.jsx';
import { ScannerModal } from './modals/ScannerModal.jsx';
import { ProductModal } from './modals/ProductModal.jsx';
import { OrderEditModal } from './modals/OrderEditModal.jsx';
import {
  money, clampNumber, todayKey, normalizeProductType, normalizePromoRules, isPromoRuleActive,
  parseCsv, readCsvFile, rowsToProducts, downloadCsv,
} from './lib/format.js';
import { startUsbScanner } from './lib/scanner.js';

const NAV_ITEMS = [
  ['cashier', ShoppingCart, '收银'],
  ['products', PackagePlus, '商品'],
  ['orders', History, '流水'],
  ['coupons', Ticket, '券管理'],
  ['gifts', Gift, '赠品'],
  ['events', Sparkles, '活动'],
  ['maintenance', Wrench, '维护'],
  ['settings', Settings2, '设置'],
];

const SECTION_BY_TAB = {
  cashier: 'pos',
  products: 'products',
  orders: 'orders',
  coupons: 'coupons',
  gifts: 'gifts',
  events: 'events',
  maintenance: 'maintenance',
  settings: 'settings',
};

function grantedTabs(user) {
  if (user?.role === 'admin') return NAV_ITEMS;
  const grants = new Set(Array.isArray(user?.grants) ? user.grants : []);
  return NAV_ITEMS.filter(([key]) => grants.has(SECTION_BY_TAB[key]));
}

export default function App() {
  const [mode, setMode] = useState('loading');
  const [session, setSession] = useState(null);
  const [initial, setInitial] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const working = useRef(false);

  async function accept(value) {
    setOnlineSession(value);
    const snapshot = await onlineRequest('ledger');
    setInitial(snapshot);
    setSession(value);
    setMode('online');
  }

  async function check() {
    setMode('loading'); setError('');
    try {
      const value = await detectOnlineSession();
      if (!value?.online) throw new Error('云端收银服务不可用，请确认本机服务已启动');
      if (value.user) await accept(value);
      else setMode('login');
    } catch (issue) { setError(issue.message); setMode('error'); }
  }

  useEffect(() => {
    check();
    const expired = () => {
      setOnlineSession(null); setSession(null); setInitial(null);
      setMode('login'); setError('登录已失效，请重新登录。未完成交易保存在云端。');
    };
    window.addEventListener('online-session-expired', expired);
    return () => window.removeEventListener('online-session-expired', expired);
  }, []);

  async function login({ username, password }) {
    if (working.current) return;
    working.current = true; setBusy(true); setError('');
    try {
      const value = await onlineRequest('login', { method: 'POST', body: { username, password }, allowUnauthorized: true });
      await accept(value);
    } catch (issue) { setError(issue.message); }
    finally { working.current = false; setBusy(false); }
  }

  async function logout() {
    try {
      await onlineRequest('logout', { method: 'POST', body: {} });
      setOnlineSession(null); setSession(null); setInitial(null); setMode('login'); setError('');
    } catch (issue) { setError(issue.message); setMode('error'); }
  }

  if (mode !== 'online' || !session?.user || !initial) {
    return <LoginScreen busy={busy} error={error} onSubmit={login} onRetry={check} mode={mode === 'error' ? 'error' : mode === 'loading' ? 'loading' : 'login'} />;
  }
  return <Shell key={session.user.id} session={session} initial={initial} logout={logout} />;
}

function Shell({ session, initial, logout }) {
  const [ledger, setLedger] = useState(initial.ledger);
  const ledgerRef = useRef(ledger);
  const cloudRevision = useRef(initial.revision);
  const [lease, setLease] = useState(initial.lease || null);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudError, setCloudError] = useState('');
  const [cloudSyncRequired, setCloudSyncRequired] = useState(false);
  const cloudWorking = useRef(false);
  const cloudRequest = useRef(null);
  const { products, orders, heldCarts = [] } = ledger;
  const paymentQr = ledger.paymentQr || '';
  const promoRules = useMemo(() => normalizePromoRules(ledger.promoRules || []), [ledger.promoRules]);

  const [cart, setCart] = useState([]);
  const [giftChoiceQueue, setGiftChoiceQueue] = useState([]);
  const [giftChoicePanelOpen, setGiftChoicePanelOpen] = useState(false);
  const visibleTabs = useMemo(() => grantedTabs(session.user), [session.user]);
  const [activeTab, setActiveTab] = useState(() => visibleTabs[0]?.[0] || 'settings');
  const [activeGroup, setActiveGroup] = useState('全部');
  const [selectedOrderDate, setSelectedOrderDate] = useState(() => todayKey());
  const [ledgerSearch, setLedgerSearch] = useState({ field: '', keyword: '' });
  const [query, setQuery] = useState('');
  const [barcodeInput, setBarcodeInput] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [editingProduct, setEditingProduct] = useState(null);
  const [paymentOrder, setPaymentOrder] = useState(null);
  const paymentOrderRef = useRef(null);
  paymentOrderRef.current = paymentOrder;
  const [editingOrder, setEditingOrder] = useState(null);
  const [heldPanelOpen, setHeldPanelOpen] = useState(false);
  const [sqbOrder, setSqbOrder] = useState(() => (shouldOpenPayment(initial.ledger.pendingPayment) ? initial.ledger.pendingPayment.draft : null));
  const sqbOrderRef = useRef(null);
  sqbOrderRef.current = sqbOrder;
  const [sqbScanCode, setSqbScanCode] = useState(null);
  const [afterSalesOrder, setAfterSalesOrder] = useState(() => (
    initial.ledger.pendingAdjustment
      ? { order: initial.ledger.orders.find((item) => item.id === initial.ledger.pendingAdjustment.parentId), type: initial.ledger.pendingAdjustment.request.type }
      : null
  ));
  const [recoveryMessage, setRecoveryMessage] = useState('');
  const [lastResult, setLastResult] = useState('');
  const [couponBusy, setCouponBusy] = useState(false);
  const [cartClearing, setCartClearing] = useState(false);
  const [couponRecovery, setCouponRecovery] = useState(false);
  const couponWorking = useRef(false);
  const recovering = useRef(false);

  const pendingPayment = ledger.pendingPayment;
  const pendingAdjustment = ledger.pendingAdjustment;
  const [pipeBusy, setPipeBusy] = useState('');
  const onlineLocked = Boolean(cloudBusy || cloudSyncRequired || ledger.pendingZero || ledger.pendingCouponReservation || lease?.recoveryRequired);
  const financiallyLocked = Boolean(onlineLocked || pendingPayment || pendingAdjustment || couponBusy || couponRecovery);
  const reviewingPayment = Boolean(pendingPayment?.review && pendingPayment.record?.state === 'paid' && !sqbOrder && !pendingAdjustment && !couponBusy && !couponRecovery);

  function flash(message) { setToast(message); }

  function acceptCloud(snapshot) {
    if (!snapshot?.ledger || !Number.isSafeInteger(snapshot.revision)) throw new Error('云端账本格式异常，请重试连接');
    cloudRevision.current = snapshot.revision;
    // Command responses carry only the newest 30 orders (ordersComplete:false)
    // to keep checkout fast; merge them into the local history by id instead
    // of replacing it, so 流水 stays complete. Full refreshes replace wholesale.
    let ledger = snapshot.ledger;
    if (snapshot.ordersComplete === false) {
      const byId = new Map((ledgerRef.current?.orders || []).map((order) => [order.id, order]));
      for (const order of ledger.orders) byId.set(order.id, order);
      ledger = { ...ledger, orders: [...byId.values()] };
    }
    ledgerRef.current = ledger; setLedger(ledger);
    setLease(snapshot.lease);
    setCloudSyncRequired(false);
    return snapshot;
  }

  async function cloudCommand(type, payload = {}, { silent = false } = {}) {
    if (cloudWorking.current) throw new Error('云端操作正在保存，请稍候');
    cloudWorking.current = true; setCloudBusy(true); if (!silent) setCloudError('');
    const input = { type, payload, expectedRevision: cloudRevision.current };
    const fingerprint = JSON.stringify(input);
    if (cloudRequest.current?.fingerprint !== fingerprint) cloudRequest.current = { fingerprint, requestId: crypto.randomUUID() };
    try { return acceptCloud(await onlineRequest('command', { method: 'POST', body: { ...input, requestId: cloudRequest.current.requestId } })); }
    catch (issue) {
      if (!silent && issue.code !== 'PIPE_BUSY') setCloudError(issue.status === 409 ? `${issue.message}。请刷新云端数据后核对，未保存内容仍保留。` : issue.message);
      throw issue;
    }
    finally { cloudWorking.current = false; setCloudBusy(false); }
  }

  async function saveCloud(type, payload) {
    try { return await cloudCommand(type, payload); } catch (issue) { flash(issue.message); return null; }
  }

  async function pipeCommand(type, payload) {
    try {
      return await withPipeRetry(
        () => cloudCommand(type, payload),
        (holder) => setPipeBusy(holder?.displayName || '另一位同事'),
      );
    } catch (issue) { flash(issue.message); return null; }
    finally { setPipeBusy(''); }
  }

  async function refreshCloud() {
    if (cloudWorking.current || couponWorking.current) return;
    if ((editingProduct || editingOrder) && !window.confirm('刷新会关闭尚未保存的商品或订单编辑，重新读取云端资料。确认刷新吗？')) return;
    cloudWorking.current = true; setCloudBusy(true); setCloudError('');
    try { acceptCloud(await onlineRequest('ledger')); setEditingProduct(null); setEditingOrder(null); }
    catch (issue) { setCloudError(issue.message); }
    finally { cloudWorking.current = false; setCloudBusy(false); }
  }

  async function recoverTransactions() {
    if (recovering.current || couponWorking.current) return;
    if (cloudWorking.current) return;
    // FCFS pipe: recovery is a pipe-scoped command. Only the pipe holder (or the
    // owner of a pending transaction) has anything to recover — everyone else
    // skips silently instead of surfacing LEASE_REQUIRED walls every 30s.
    const canPos = session.user.role === 'admin' || (session.user.grants || []).includes('pos');
    if (!canPos) return;
    const snap = ledgerRef.current;
    const ownsPending = snap?.pendingPayment?.ownerId === session.user.id || snap?.pendingAdjustment?.ownerId === session.user.id;
    if (!lease?.mine && !ownsPending) return;
    recovering.current = true;
    try {
      const previous = ledgerRef.current;
      const snapshot = await cloudCommand('recovery', {}, { silent: true });
      const current = snapshot.ledger;
      const recoveringIds = [previous.pendingPayment?.draft.id, previous.pendingZero?.draft.id, paymentOrderRef.current?.id, sqbOrderRef.current?.id].filter(Boolean);
      if (current.orders.some((order) => recoveringIds.includes(order.id))) {
        clearCart(); setPaymentOrder(null); setSqbOrder(null); setSqbScanCode(null); setLastResult('云端订单已恢复，库存已核对；请勿重复收款');
      }
      if (shouldOpenPayment(current.pendingPayment)) setSqbOrder(current.pendingPayment.draft);
      else if (previous.pendingPayment && !current.pendingPayment) { setSqbOrder(null); setSqbScanCode(null); }
      if (current.pendingAdjustment) setAfterSalesOrder({ order: current.orders.find((item) => item.id === current.pendingAdjustment.parentId), type: current.pendingAdjustment.request.type });
      else if (previous.pendingAdjustment && !current.pendingAdjustment) setAfterSalesOrder(null);
      setRecoveryMessage(snapshot.recoveryRequired ? '云端仍有待处理交易，请核对后继续收银' : '');
    } catch (issue) {
      // Expected under FCFS when the pipe moved on between poll and command — not user-facing problems.
      if (['FORBIDDEN', 'LEASE_REQUIRED', 'PIPE_BUSY', 'LEASE_HELD'].includes(issue.code)) setRecoveryMessage('');
      else setRecoveryMessage(issue.message);
    }
    finally { recovering.current = false; }
  }

  useEffect(() => {
    // One recovery pass on first load (early-returns without any request for
    // sessions that hold no residue). No periodic polling and no tab-switch
    // refetch: the full snapshot is only fetched on 刷新, on first load, and as
    // the natural response of every user action (including payment-sync right
    // after a paid order).
    recoverTransactions();
    const online = () => recoverTransactions();
    window.addEventListener('online', online);
    return () => { window.removeEventListener('online', online); };
  }, []);

  useEffect(() => {
    if (visibleTabs.length && !visibleTabs.some(([key]) => key === activeTab)) setActiveTab(visibleTabs[0][0]);
  }, [activeTab, visibleTabs]);

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
      const termMatched = !term || [item.name, item.barcode, item.sku, item.group].some((value) => String(value).toLowerCase().includes(term));
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
  const todayEvents = events.filter((event) => todayKey(new Date(event.at)) === todayKey());
  const ledgerIndex = useMemo(() => createLedgerSearchIndex(orders), [orders]);
  const ledgerResult = useMemo(() => queryLedger(ledgerIndex, { date: selectedOrderDate, ...ledgerSearch }), [ledgerIndex, selectedOrderDate, ledgerSearch]);
  const pricedCart = cart.length ? priceOrder(cart) : { items: [], subtotal: 0, discount: 0, total: 0, couponDiscount: 0 };
  const { subtotal: cartSubtotal, discount: cartDiscount, total: cartTotal } = pricedCart;
  const todayTotal = todayEvents.reduce((sum, event) => sum + Math.round(event.amount * 100), 0) / 100;
  const todayCount = todayEvents.filter((event) => event.type === '收款').length;
  const saleProducts = useMemo(() => products.filter((item) => item.productType === 'sale'), [products]);
  const giftProducts = useMemo(() => products.filter(canBePromoGift), [products]);

  function addToCart(product, qty = 1) {
    if (!product || couponWorking.current || financiallyLocked) return;
    const currentProduct = products.find((item) => item.id === product.id) || product;
    const mainResult = addLineToCart(cart, currentProduct, qty, { source: currentProduct.productType });
    if (!mainResult.added) {
      if (mainResult.reason === 'coupon-limit') { flash('每笔订单最多使用一张优惠券，请先移除原券'); return; }
      if (mainResult.reason === 'coupon-invalid') { flash('请先设置有效的优惠券抵扣金额'); return; }
      if (mainResult.reason === 'limit') { flash(`${currentProduct.name} 已达到库存上限`); return; }
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
        .map((gift) => ({ ...gift, qty: gift.qty * multiplier, product: products.find((item) => item.id === gift.productId && canBePromoGift(item)) }))
        .filter((gift) => gift.product);

      if (!validGifts.length) { giftMessages.push('赠品规则已失效'); return; }

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
            gifts: validGifts.map(({ product: giftProduct, qty: giftQty }) => ({ productId: giftProduct.id, name: giftProduct.name, qty: giftQty })),
          },
        ]);
        setGiftChoicePanelOpen(true);
        return;
      }

      validGifts.forEach(({ product: giftProduct, qty: giftQty }) => {
        const giftResult = addLineToCart(nextCart, promoGiftLine(giftProduct, rule.id), giftQty, { source: 'promo', promoRuleId: rule.id });
        nextCart = giftResult.next;
        if (giftResult.added) giftMessages.push(`赠品 ${giftProduct.name} 已加入 ${giftResult.addedQty} 件${giftResult.addedQty < giftQty ? '，剩余赠送数量库存不足' : ''}`);
        else giftMessages.push(`赠品 ${giftProduct.name} 库存不足`);
      });
    });

    setCart(nextCart);
    flash([`${currentProduct.name} 已加入购物车`, ...giftMessages].join('，'));
  }

  function choosePromoGift(choice, giftProductId) {
    const gift = choice?.gifts.find((item) => item.productId === giftProductId);
    const giftProduct = products.find((item) => item.id === giftProductId && canBePromoGift(item));
    if (!choice || !gift || !giftProduct) { flash('赠品已失效'); return; }

    const result = addLineToCart(cart, promoGiftLine(giftProduct, choice.ruleId), gift.qty, { source: 'promo', promoRuleId: choice.ruleId });
    if (!result.added || result.addedQty !== gift.qty) { flash(`${giftProduct.name} 库存不足`); return; }

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
    if (shouldReserveAward(normalized, products)) {
      if (cart.some((item) => isCoupon(item) || isExternalAward(item))) { flash('每单仅能使用一份抽奖奖品或优惠券，请先移除已有奖品'); return; }
      if (!physicalCode && (!cart.some((item) => !isCoupon(item)) || priceOrder(cart).total <= 0)) { flash('请先加入需要付款的商品，再扫描中奖券'); return; }
      if (physicalCode) {
        // 16 位领奖码先问活动端是现金券还是实物奖品：实物直接加 ¥0 赠品行，
        // 结算完成后由云端自动核销并扣库存；现金券落回原有中奖券占用流程。
        const upper = normalized.toUpperCase();
        if (cart.some((item) => item.prize?.code === upper)) { flash('该奖品已在购物车中，请勿重复扫码'); return; }
        couponWorking.current = true; setCouponBusy(true);
        let check;
        try { check = await sqbCall('activity-prize-check', { code: upper }); }
        catch (error) {
          flash(error.code === 'ALREADY_REDEEMED' ? '该奖品已核销，请勿重复发放' : error.message);
          return;
        } finally { couponWorking.current = false; setCouponBusy(false); }
        if (check?.kind === 'physical') {
          const current = ledgerRef.current.products.find((item) => item.id === check.product?.id);
          if (!current) { flash('奖品对应商品不存在，请先在商品管理中核对赠品'); return; }
          const line = { ...current, productType: 'gift', price: 0, discount: 0, qty: 1, source: 'prize', lineKey: `prize:${check.entryCode}`, prize: { code: check.entryCode, prizeName: check.prizeName } };
          try { reconcileStock(ledgerRef.current.products, [], [...cart, line]); }
          catch (error) { flash(error.message); return; }
          setCart([...cart, line]);
          setBarcodeInput('');
          flash(`已添加奖品：${check.prizeName}（免费 1 件，结算后自动核销）`);
          return;
        }
        // Cash prize over a 16-hex win code: reserve pins the discount to the
        // current payable amount, so an empty or ¥0-only cart has nothing to
        // pin — the backend would reject it as 商品应收金额不正确.
        if (!cart.some((item) => !isCoupon(item)) || priceOrder(cart).total <= 0) { flash('请先加入需要付款的商品，再扫描中奖券'); return; }
      }
      couponWorking.current = true; setCouponBusy(true);
      setCloudSyncRequired(true);
      try {
        const inventory = physicalCode ? ledgerRef.current.products.map(({ id, name, sku, barcode, productType, price, originalPrice, stock, group }) => ({ id, name, sku, barcode, productType, price, originalPrice, stock, group })) : undefined;
        const line = await sqbCall('coupon-reserve', { code: physicalCode ? normalized.toUpperCase() : normalized, checkoutId: crypto.randomUUID(), eligibleCents: cart.length ? Math.round(priceOrder(cart).total * 100) : 0, requestId: crypto.randomUUID(), products: inventory });
        try { reconcileStock(ledgerRef.current.products, [], [...cart, line]); }
        catch (error) { await sqbCall('coupon-release', { id: line.externalCoupon.reservationId }); throw error; }
        setCart((current) => [...current, line]);
        setBarcodeInput('');
        flash(isExternalPhysical(line) ? `${line.name} · 抽奖赠品已加入，免费 1 件` : `中奖券已加入，最多抵扣 ${line.couponAmount.toFixed(2)} 元`);
      } catch (error) { flash(error.message); }
      finally {
        try { acceptCloud(await onlineRequest('ledger')); }
        catch (issue) { setCloudError(`领奖券状态需要核对：${issue.message}。请刷新云端数据后再继续，勿重复扫码。`); }
        couponWorking.current = false; setCouponBusy(false);
      }
      return;
    }
    const matches = products.filter((item) => item.barcode === normalized);
    if (matches.length > 1) { flash('条码重复，请先在商品管理中修正'); return; }
    const product = matches[0];
    if (product) { addToCart(product); setBarcodeInput(''); return; }
    setEditingProduct({
      id: crypto.randomUUID(), barcode: normalized, sku: '', group: '未分组', imageUrl: '',
      productType: 'sale', name: '', originalPrice: '', price: '', stock: 0,
    });
    flash('未找到商品，请先补全商品信息');
  }

  // USB scanner (keyboard-wedge) routing for the POS screen. The capture
  // layer lives in lib/scanner.js and emits 'bubble-scan'; this subscriber
  // only runs while the cashier tab is active and no other modal holds focus.
  const usbScanContext = useRef(null);
  usbScanContext.current = {
    activeTab, cart, products, sqbOrder, checkout, addToCart, scanBarcode, flash,
    modalOpen: Boolean(scannerOpen || editingProduct || paymentOrder || heldPanelOpen || giftChoicePanelOpen || afterSalesOrder || couponBusy),
  };
  useEffect(() => {
    startUsbScanner();
    const onUsbScan = (event) => {
      const ctx = usbScanContext.current;
      const payload = String(event.detail ?? '').trim();
      if (!payload || ctx.activeTab !== 'cashier' || ctx.modalOpen) return;
      const digits = payload.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/[^0-9]/g, '');
      if (/^\d{16,32}$/.test(digits)) {
        // 顾客付款码（收钱吧动态码）
        if (ctx.sqbOrder) { setSqbScanCode(digits); return; }
        if (!ctx.cart.length) { ctx.flash('请先添加商品，再扫描顾客付款码'); return; }
        const opened = ctx.checkout('收钱吧');
        if (opened) setSqbScanCode(digits);
        return;
      }
      const matches = ctx.products.filter((item) => item.barcode === payload || item.sku === payload);
      if (matches.length > 1) { ctx.flash('条码重复，请先在商品管理中修正'); return; }
      if (matches[0]) { ctx.addToCart(matches[0]); return; }
      // 16 位十六进制 / LJC1_ 领奖券走原有的中奖券占用路径（与手动输入条码一致）
      if (/^[0-9A-Fa-f]{16}$/.test(payload) || payload.startsWith('LJC1_')) { ctx.scanBarcode(payload); return; }
      ctx.flash(`未找到该条码对应的商品：${payload.slice(0, 20)}`);
    };
    window.addEventListener('bubble-scan', onUsbScan);
    return () => window.removeEventListener('bubble-scan', onUsbScan);
  }, []);

  async function changeQty(productId, delta) {
    const existing = cart.find((item) => basketLineKey(item) === productId);
    if (existing && (isExternalPhysical(existing) || existing.prize) && delta > 0) return;
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
          if (isExternalPhysical(item)) return { ...item, qty: delta < 0 ? 0 : 1 };
          if (item.prize) return { ...item, qty: delta < 0 ? 0 : 1 };
          if (isCoupon(item)) return { ...item, qty: delta < 0 ? 0 : 1 };
          const stock = Number(ledgerRef.current.products.find((product) => product.id === item.id)?.stock || 0);
          const usedByOtherLines = current.filter((line) => line.id === item.id && basketLineKey(line) !== productId).reduce((sum, line) => sum + line.qty, 0);
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

  function assembleDraft(priced, method) {
    return {
      id: crypto.randomUUID(),
      orderNo: `POS${Date.now()}${crypto.randomUUID().slice(0, 4)}`,
      createdAt: new Date().toISOString(),
      day: todayKey(),
      method,
      status: '待收款',
      ...priced,
    };
  }

  function createOrder(method) {
    if (!cart.length) { flash('购物车还是空的'); return null; }
    if (giftChoiceQueue.length) { flash('还有赠品未选择，请先选择赠品'); return null; }

    let priced;
    try {
      priced = priceOrder(cart, method === '0元出库');
      const coupon = cart.find((item) => item.externalCoupon);
      if (coupon) {
        if (method !== '收钱吧') throw new Error('中奖券请使用收钱吧结算；全额抵扣会自动进入零元结算');
        if (!isExternalPhysical(coupon) && (Math.round((priced.total + priced.couponDiscount) * 100) < coupon.minimumCents || priced.couponDiscount <= 0)) throw new Error('当前商品金额未达到中奖券门槛，请调整商品或移除券');
      }
      reconcileStock(ledgerRef.current.products, [], priced.items);
    } catch (error) { flash(error.message); return null; }

    return assembleDraft(priced, method);
  }

  function checkout(method) {
    if (ledgerRef.current.pendingAdjustment) { flash('请先完成退换货'); return null; }
    if (ledgerRef.current.pendingPayment) {
      setSqbOrder(ledgerRef.current.pendingPayment.draft);
      setSqbScanCode(null);
      flash('请先核实正在进行的收钱吧支付');
      return null;
    }
    const order = createOrder(method);
    if (!order) return null;

    setSqbScanCode(null);
    if (method !== '0元出库' && order.total === 0) { setPaymentOrder({ ...order, method: '零元结算' }); return null; }
    if (method === '收钱吧') { enablePaymentNotifications().catch(() => {}); setSqbOrder(order); return order; }
    if (method === '0元出库') setCart(order.items);
    setPaymentOrder(order);
    return null;
  }


  function clearCart() {
    setCart([]);
    setGiftChoiceQueue([]);
    setGiftChoicePanelOpen(false);
  }

  async function clearCartAll() {
    if (!cart.length || couponWorking.current) return;
    const external = cart.find((item) => item.externalCoupon);
    if (external) {
      couponWorking.current = true; setCouponBusy(true); setCartClearing(true);
      try { await sqbCall('coupon-release', { id: external.externalCoupon.reservationId }); }
      catch (error) { flash(`清空失败：${error.message}`); return; }
      finally { couponWorking.current = false; setCouponBusy(false); setCartClearing(false); }
    }
    clearCart();
    flash('购物车已清空');
  }

  async function handoutGift(product, qty) {
    if (ledgerRef.current.pendingAdjustment) { flash('请先完成退换货'); return false; }
    if (ledgerRef.current.pendingPayment) { flash('请先核实正在进行的收钱吧支付'); return false; }
    if (financiallyLocked) { flash('请先核对待处理收退款'); return false; }
    const currentProduct = products.find((item) => item.id === product.id && canBePromoGift(item));
    if (!currentProduct) { flash('赠品已失效，请刷新后重试'); return false; }
    let priced;
    try {
      priced = priceOrder([{ ...currentProduct, qty, discount: 0 }], true);
      reconcileStock(ledgerRef.current.products, [], priced.items);
    } catch (error) { flash(error.message); return false; }
    const result = await pipeCommand('manual-complete', { draft: assembleDraft(priced, '0元出库') });
    if (!result) return false;
    setLastResult(`赠品已发放：${currentProduct.name} × ${qty} · 云端库存已扣减`);
    return true;
  }

  async function markPaid() {
    if (financiallyLocked) { flash('请先核对待处理收款'); return; }
    if (!paymentOrder || couponWorking.current) return;
    const external = paymentOrder.items.some((item) => item.externalCoupon);
    const result = await pipeCommand(external ? 'zero-complete' : 'manual-complete', { draft: paymentOrder });
    if (result) {
      setPaymentOrder(null); clearCart();
      const prizes = paymentOrder.items.filter((item) => item.prize).map((item) => item.prize.prizeName);
      flash(external ? '云端已核销并保存订单，可发放奖品'
        : prizes.length ? `云端订单已保存，奖品已核销：${prizes.join('、')}`
        : '云端订单已保存，库存已更新');
    }
  }

  async function beforeSqbStart() {
    return Boolean(await pipeCommand('payment-prepare', { draft: sqbOrder }));
  }

  async function syncPhysicalOrder(orderId) {
    const result = await saveCloud('physical-sync', { orderId });
    return Boolean(result?.ledger.orders.find((order) => order.id === orderId)?.physicalFulfilled);
  }

  async function applySqbRecord(record) {
    if (record.state !== 'paid') return;
    const snapshot = await cloudCommand('payment-sync', { id: record.id });
    clearCart(); setSqbOrder(null); setSqbScanCode(null);
    flash('云端已确认收款，订单和库存已保存');
    const paidOrder = snapshot.ledger.orders.find((order) => order.id === record.id);
    const prizes = (paidOrder?.items || []).filter((item) => item.prize).map((item) => item.prize.prizeName);
    setLastResult(`收款成功 ${(record.amount / 100).toFixed(2)} 元 · 云端订单已保存${prizes.length ? ` · 奖品已核销：${prizes.join('、')}` : ''}`);
    await notifyConfirmedPayment(record.id);
    if (paidOrder?.items.some(isExternalPhysical)) {
      const ready = await syncPhysicalOrder(record.id);
      setLastResult(ready ? '收款及奖品核销已完成，可发放实物奖品' : '收款已成功 · 实物奖品领取确认待同步，请暂缓发放');
    }
  }

  async function closeSqb(record) {
    if (record?.state === 'paid') {
      if (!ledgerRef.current.orders.some((order) => order.id === record.id)) await cloudCommand('payment-review', { id: record.id, dismissed: true });
      setSqbOrder(null);
      setSqbScanCode(null);
      return;
    }
    if (ledgerRef.current.pendingPayment && !['failed', 'not-started'].includes(record?.state)) return;
    if (ledgerRef.current.pendingPayment) {
      const draft = ledgerRef.current.pendingPayment.draft;
      await cloudCommand('payment-clear', { id: draft.id });
      setCart(draft.items.filter((item) => !item.externalCoupon));
    }
    setSqbOrder(null);
    setSqbScanCode(null);
  }

  function cancelPayment() {
    if (couponWorking.current) return;
    if (paymentOrder?.items.some((item) => item.externalCoupon)) { setPaymentOrder(null); flash('已返回购物车，移除中奖券可释放占用'); return; }
    // Keep the cart untouched: canceling a collection only closes the modal,
    // so staff can fix whatever went wrong and re-initiate收款 immediately.
    setPaymentOrder(null);
    flash('已返回购物车，可重新发起收款');
  }

  function makeZeroOrder() {
    if (couponWorking.current || paymentOrder?.items.some((item) => item.externalCoupon)) { flash('中奖券已参与抵扣，不能再改为0元出库'); return; }
    if (!paymentOrder) return;
    const priced = priceOrder(paymentOrder.items, true);
    setPaymentOrder({ ...paymentOrder, ...priced, method: '0元出库' });
    setCart(priced.items);
  }

  async function holdCart() {
    if (giftChoiceQueue.length) { flash('请先完成赠品选择，再挂单'); return false; }
    if (cart.some((item) => item.externalCoupon)) { flash('请先移除中奖券再挂单，取单后可重新扫码'); return false; }
    if (!cart.length) { flash('购物车还是空的'); return false; }
    const held = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), items: cart, giftChoiceQueue };
    if (!await saveCloud('hold', { basket: held })) return false;
    clearCart();
    flash('已挂起，可继续为下一位顾客收银');
    return true;
  }

  async function resumeCart(id) {
    if (cart.some((item) => item.externalCoupon)) { flash('请先移除当前中奖券，再取单'); return; }
    if (!ledgerRef.current.heldCarts.some((entry) => entry.id === id)) return;
    const currentBasket = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), items: cart, giftChoiceQueue };
    const result = await saveCloud('retrieve', { id, currentBasket });
    if (!result) return;
    const held = result.extra.basket;
    setCart(held.items);
    setGiftChoiceQueue(held.giftChoiceQueue || []);
    setGiftChoicePanelOpen(Boolean(held.giftChoiceQueue?.length));
    setHeldPanelOpen(false);
    flash(cart.length ? '已取单，原购物车已自动挂起' : '已取单');
  }

  async function deleteHeldCart(id) {
    if (!window.confirm('确定删除这笔挂单吗？')) return;
    await saveCloud('held-delete', { id });
  }

  async function cancelOrder(id) {
    if (financiallyLocked) { flash('请先核对待处理收退款，暂不能取消其他订单'); return; }
    const existing = ledgerRef.current.orders.find((order) => order.id === id);
    if (existing?.payment?.provider === 'sqb') { openAfterSales(existing, 'return'); return; }
    if (!window.confirm('确定取消订单？商品将退回库存，该订单金额将从营收中扣除。实际退款请另行完成。')) return;
    if (await saveCloud('order-revise', { id, items: [], cancel: true })) flash('云端订单已取消，库存和营收已回退');
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
    return Boolean(await pipeCommand('adjustment-prepare', { parentId: pending.parentId, request: pending.request, preview: pending.preview }));
  }

  async function applyAfterSalesRecord(record) {
    if (!['paid', 'refunded', 'completed'].includes(record.state)) return;
    await cloudCommand('adjustment-sync', { id: record.id });
    setAfterSalesOrder(null);
    setLastResult('退换货已核对，云端订单与库存已同步');
    if (record.kind === 'exchange-charge') await notifyConfirmedPayment(record.id);
  }

  async function closeAfterSales(record) {
    if (['paid', 'refunded', 'completed'].includes(record?.state)) { await applyAfterSalesRecord(record); return; }
    if (ledgerRef.current.pendingAdjustment && !['failed', 'not-started'].includes(record?.state)) return;
    if (ledgerRef.current.pendingAdjustment) await cloudCommand('adjustment-clear', { id: ledgerRef.current.pendingAdjustment.id });
    setAfterSalesOrder(null);
  }

  async function saveOrderEdit(id, items) {
    if (financiallyLocked) { flash('请先核对待处理收退款，暂不能修改其他订单'); return; }
    if (await saveCloud('order-revise', { id, items, cancel: false })) { setEditingOrder(null); flash('云端换货已保存，库存和流水已更新'); }
  }

  async function confirmLegacyOrder(id) {
    if (financiallyLocked) { flash('请先核对待处理收退款'); return; }
    if (!window.confirm('确认这笔旧版待收款订单已经收到款项？')) return;
    await saveCloud('legacy-confirm', { id });
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

    if (!payload.name || !payload.barcode || (payload.productType === 'sale' && payload.price <= 0)) { flash('请填写商品名、条码和售卖品售价'); return; }
    if (isCoupon(payload) && (!Number.isFinite(payload.couponAmount) || payload.couponAmount <= 0)) { flash('优惠券抵扣金额必须大于 0'); return; }
    const duplicate = products.find((item) => item.id !== payload.id && item.barcode === payload.barcode);
    if (duplicate) { flash(isCoupon(duplicate) ? `该条码已被优惠券「${duplicate.name}」使用` : `该条码已被「${duplicate.name}」使用，请编辑原商品；需要售卖兼赠送时，设置售价并勾选“可参与买赠”`); return; }
    if (!Number.isSafeInteger(payload.stock) || payload.stock < 0 || !Number.isFinite(payload.price) || !Number.isFinite(payload.originalPrice) || payload.originalPrice < 0) {
      flash('库存须为非负整数，价格须为有效的非负金额');
      return;
    }

    if (!await saveCloud('product-save', { product: payload })) return;
    setEditingProduct(null);
    flash('商品已保存');
  }

  async function removeProduct(id) {
    if (cart.some((item) => item.id === id && isExternalAward(item))) { flash('请先移除购物车中的抽奖奖品，再删除对应商品'); return; }
    if (await saveCloud('product-delete', { id })) {
      setCart((current) => current.filter((item) => item.id !== id));
      setGiftChoiceQueue((current) => current.filter((choice) => choice.mainProductId !== id && !choice.gifts.some((gift) => gift.productId === id)));
    }
  }

  async function savePromoRule(rule) {
    const payload = normalizePromoRules([rule])[0];
    const mainProducts = payload.mainProductIds.filter((productId) => productId);
    const gifts = payload.gifts.filter((gift) => gift.productId);

    if (!mainProducts.length) { flash('请至少选择 1 个主品'); return false; }
    if (mainProducts.some((productId) => !products.some((item) => item.id === productId && item.productType === 'sale'))) { flash('主品只能选择售卖品'); return false; }
    if (!gifts.length) { flash('请至少选择 1 个赠品'); return false; }
    if (gifts.some((gift) => !products.some((item) => item.id === gift.productId && canBePromoGift(item)))) { flash('请选择赠品或已启用“可参与买赠”的售卖品'); return false; }
    if (payload.startAt && payload.endAt && new Date(payload.startAt) > new Date(payload.endAt)) { flash('结束时间不能早于开始时间'); return false; }

    const current = ledgerRef.current.promoRules || [];
    const exists = current.some((item) => item.id === payload.id);
    if (!await saveCloud('settings-save', { promoRules: exists ? current.map((item) => item.id === payload.id ? payload : item) : [payload, ...current] })) return false;
    flash('加赠规则已保存到云端');
    return true;
  }

  async function togglePromoRule(ruleId) {
    await saveCloud('settings-save', { promoRules: (ledgerRef.current.promoRules || []).map((rule) => rule.id === ruleId ? { ...rule, enabled: !rule.enabled } : rule) });
  }

  async function removePromoRule(ruleId) {
    if (await saveCloud('settings-save', { promoRules: (ledgerRef.current.promoRules || []).filter((rule) => rule.id !== ruleId) })) flash('加赠规则已删除');
  }

  async function importProducts(file) {
    if (!file) return;
    try {
      const lowerName = file.name.toLowerCase();
      const rows = lowerName.endsWith('.csv') ? parseCsv(await readCsvFile(file)) : await readXlsxFile(file);
      const incoming = rowsToProducts(rows, giftEligibilityImport);
      if (!incoming.length) { flash('没有读到可导入的商品'); return; }
      if (!await saveCloud('products-import', { products: incoming })) return;
      flash(`已导入 ${incoming.length} 个商品`);
    } catch (error) { flash(error.message || '导入失败，请检查表头'); }
  }

  function exportTemplate() {
    downloadCsv([
      ['产品名称', '条码', '货品编码', '商品分组', '商品类型', '商品图片', '原价', '售价', '库存数量', '抵扣金额', '可参与买赠'],
      ['示例饮料', 'ABC-001', 'DRINK-001', '饮料', '售卖品', '', '6', '5', '20', '', '否'],
      ['示例赠品', '6970000000001', 'GIFT-001', '赠品', '赠品', '', '0', '0', '30', '', '是'],
      ['可售可赠示例', 'SALE-GIFT-001', 'SALE-GIFT-001', '配件', '售卖品', '', '30', '20', '10', '', '是'],
      ['满单抵扣5元券', '6900000000002', 'COUPON-005', '优惠券', '优惠券', '', '0', '0', '0', '5', '否'],
    ], '商品导入模板.csv');
  }

  function exportOrders(dateOnly = false) {
    downloadCsv(
      dateOnly === true ? ledgerResult.rows : financialExportRows(orders),
      `摆摊流水_${dateOnly === true ? selectedOrderDate || '全部日期' : '全部'}${dateOnly === true && ledgerSearch.keyword ? '_查询结果' : ''}_商品明细.csv`,
    );
  }

  async function exportBackup() {
    if (financiallyLocked) { flash('请先处理收退款或恢复任务'); return; }
    try {
      const backup = await onlineRequest('export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `收银系统备份_${todayKey()}_${Date.now()}.json`;
      link.click();
      URL.revokeObjectURL(url);
      flash('完整经营备份已导出');
    } catch (issue) { flash(issue.message); }
  }

  function uploadPaymentQr(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      if (await saveCloud('settings-save', { paymentQr: String(reader.result || '') })) flash('收款码已保存到云端');
    };
    reader.readAsDataURL(file);
  }

  const isAdmin = session.user.role === 'admin';
  const posLocked = financiallyLocked;

  return (
    <main className="relative min-h-screen">
      <Aurora />
      <Navbar
        user={session.user}
        lease={lease}
        cloudBusy={cloudBusy}
        revision={cloudRevision.current}
        onRefresh={refreshCloud}
        onLogout={logout}
      />

      {cloudError && <p className="mx-auto mt-3 max-w-7xl rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-2.5 text-sm text-red-300 sm:mx-6 lg:mx-auto" role="alert">{cloudError}</p>}
      {pipeBusy && (
        <p className="mx-auto mt-3 flex max-w-7xl items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-2.5 text-sm text-amber-300 sm:mx-6 lg:mx-auto" role="status">
          <RefreshCw size={14} className="animate-spin" /> {pipeBusy} 正在收款，请稍候…（自动重试中）
        </p>
      )}

      {/* 今日概览 */}
      <div className="mx-auto grid max-w-7xl grid-cols-3 gap-3 px-4 pt-4 sm:px-6">
        {[
          ['今日净收入', money(todayTotal)],
          ['订单', todayCount],
          ['购物车', cart.length],
        ].map(([label, value]) => (
          <div key={label} className="glass px-4 py-3.5 text-center">
            <p className="text-[11px] text-mist">{label}</p>
            <p className="mt-0.5 text-lg font-black text-milk sm:text-xl">{value}</p>
          </div>
        ))}
      </div>

      {lastResult && (
        <div className="mx-auto mt-3 flex max-w-7xl items-center justify-between gap-3 px-4 sm:px-6" role="status">
          <div className="glass flex-1 border-emerald-400/30 px-4 py-2.5 text-sm text-emerald-300">{lastResult}</div>
          <button className="btn-icon !h-9 !w-9" aria-label="关闭交易结果" onClick={() => setLastResult('')}>×</button>
        </div>
      )}

      {pendingPayment?.review && (
        <div className="mx-auto mt-3 flex max-w-7xl flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 sm:mx-6 lg:mx-auto" role="alert">
          <div>
            <strong className="text-amber-200">收款待核对 · {pendingPayment.draft.orderNo} · {money(pendingPayment.record.amount / 100)}</strong>
            <p className="text-sm text-amber-200/80">{pendingPayment.review.message}</p>
            <small className="text-xs text-amber-200/60">云端暂停收银及账务修改，待核对记录仍保留。</small>
          </div>
          <button className="btn-primary" onClick={() => setSqbOrder(ledgerRef.current.pendingPayment.draft)}>
            <History size={16} /> 查看待核对收款
          </button>
        </div>
      )}

      {recoveryMessage && (
        <div className="mx-auto mt-3 flex max-w-7xl items-center justify-between gap-3 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 sm:mx-6 lg:mx-auto" role="alert">
          <span className="text-sm text-amber-200">待核实：{recoveryMessage}</span>
          <button className="btn-ghost !min-h-[38px] !px-3 !py-1.5 text-sm" onClick={recoverTransactions}><RefreshCw size={14} /> 重试对账</button>
        </div>
      )}

      <>
        {activeTab === 'cashier' && (
          <div key="cashier">
            <PosScreen
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
              onClearCart={clearCartAll}
              clearing={cartClearing}
              heldCount={heldCarts.length}
              cartTotal={cartTotal}
              cartSubtotal={cartSubtotal}
              cartDiscount={cartDiscount}
              openScanner={() => setScannerOpen(true)}
              locked={posLocked}
            />
          </div>
        )}
        {activeTab === 'products' && (
          <ProductsScreen
            key="products"
            products={filteredProducts}
            groups={groups}
            activeGroup={activeGroup}
            setActiveGroup={setActiveGroup}
            query={query}
            setQuery={setQuery}
            paymentQr={paymentQr}
            onNew={() => setEditingProduct({ id: crypto.randomUUID(), barcode: '', sku: '', group: '未分组', imageUrl: '', productType: 'sale', name: '', originalPrice: '', price: '', stock: 0 })}
            onEdit={setEditingProduct}
            onRemove={removeProduct}
            onImport={importProducts}
            onTemplate={exportTemplate}
            onPaymentQr={uploadPaymentQr}
            onBackup={exportBackup}
            onMigrate={() => setActiveTab('settings')}
            readOnly={financiallyLocked}
            isAdmin={isAdmin}
          />
        )}
        {activeTab === 'orders' && (
          <OrdersScreen
            key="orders"
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
            isAdmin={isAdmin}
          />
        )}
        {activeTab === 'coupons' && <CouponsScreen key="coupons" products={products} />}
        {activeTab === 'gifts' && (
          <GiftsScreen
            key="gifts"
            products={products}
            orders={orders}
            promoRules={promoRules}
            locked={financiallyLocked}
            readOnly={financiallyLocked}
            isAdmin={isAdmin}
            saleProducts={saleProducts}
            giftProducts={giftProducts}
            flash={flash}
            onHandout={handoutGift}
            onSaveRule={savePromoRule}
            onToggleRule={togglePromoRule}
            onRemoveRule={removePromoRule}
          />
        )}
        {activeTab === 'events' && <EventsScreen key="events" isAdmin={isAdmin} flash={flash} products={products} />}
        {activeTab === 'maintenance' && <MaintenanceScreen key="maintenance" flash={flash} />}
        {activeTab === 'settings' && <SettingsScreen key="settings" user={session.user} onImport={(bundle) => cloudCommand('initial-import', { bundle })} flash={flash} />}
      </>

      {/* 底部导航 */}
      {visibleTabs.length > 0 && (
      <nav className="app-nav fixed bottom-0 left-0 right-0 z-40 border-t border-white/[0.07] bg-ink-900/85 backdrop-blur-xl" aria-label="主导航" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="mx-auto grid max-w-4xl gap-1 px-2 py-2" style={{ gridTemplateColumns: `repeat(${visibleTabs.length}, minmax(0, 1fr))` }}>
          {visibleTabs.map(([key, Icon, label]) => (
            <button
              key={key}
              aria-current={activeTab === key ? 'page' : undefined}
              onClick={() => setActiveTab(key)}
              className={`nav-btn relative flex min-h-[52px] flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-medium transition active:scale-95 sm:text-xs ${
                activeTab === key ? 'text-coral-soft' : 'text-mist hover:text-milk'
              }`}
            >
              {activeTab === key && (
                <motion.span layoutId="nav-pill" className="nav-pill absolute inset-0 rounded-xl bg-coral/15 shadow-pop" transition={{ type: 'spring', stiffness: 400, damping: 32 }} />
              )}
              <Icon size={20} className="relative" />
              <span className="relative">{label}</span>
            </button>
          ))}
        </div>
      </nav>
      )}

      {!visibleTabs.length && (
        <div className="mx-auto mt-6 max-w-7xl px-4 pb-32 sm:px-6">
          <div className="glass px-6 py-14 text-center text-mist">当前账号未分配任何功能权限，请联系管理员。</div>
        </div>
      )}

      <AnimatePresence>
        {scannerOpen && <ScannerModal key="scanner" onClose={() => setScannerOpen(false)} onDetected={scanBarcode} />}
        {editingProduct && <ProductModal key="product" product={editingProduct} onClose={() => setEditingProduct(null)} onSave={saveProduct} />}
        {paymentOrder && (
          <PaymentModal
            key="payment"
            order={paymentOrder}
            paymentQr={paymentQr}
            onClose={cancelPayment}
            onPaid={markPaid}
            onZero={makeZeroOrder}
            onHold={async () => { if (await holdCart()) setPaymentOrder(null); }}
          />
        )}
        {editingOrder && <OrderEditModal key="order-edit" order={editingOrder} products={products} onClose={() => setEditingOrder(null)} onSave={saveOrderEdit} />}
        {afterSalesOrder?.order && (
          <AfterSalesModal
            key={afterSalesOrder.order.id}
            order={afterSalesOrder.order}
            products={products}
            initialType={afterSalesOrder.type}
            pending={pendingAdjustment}
            onBeforeStart={beforeAfterSalesStart}
            onRecord={applyAfterSalesRecord}
            onClose={(record) => closeAfterSales(record).catch((issue) => flash(issue.message))}
          />
        )}
        {sqbOrder && (
          <SqbPaymentModal
            key={sqbOrder.id}
            order={sqbOrder}
            pending={pendingPayment}
            scanCode={sqbScanCode}
            onBeforeStart={beforeSqbStart}
            onRecord={applySqbRecord}
            onClose={closeSqb}
            onSettings={() => { setSqbOrder(null); setSqbScanCode(null); setActiveTab('settings'); }}
          />
        )}
        {heldPanelOpen && <HeldCartsModal key="held" heldCarts={heldCarts} onClose={() => setHeldPanelOpen(false)} onResume={resumeCart} onDelete={deleteHeldCart} />}
        {giftChoicePanelOpen && giftChoiceQueue[0] && (
          <GiftChoiceModal
            key="gift-choice"
            choice={giftChoiceQueue[0]}
            products={products}
            cart={cart}
            onChoose={choosePromoGift}
            onClose={() => setGiftChoicePanelOpen(false)}
          />
        )}
      </AnimatePresence>

      <Toast message={toast} />
    </main>
  );
}

function giftEligibilityImport(value) {
  return ['true', '1', 'yes', '是', '可赠送', '可参与买赠'].includes(String(value ?? '').trim().toLowerCase());
}
