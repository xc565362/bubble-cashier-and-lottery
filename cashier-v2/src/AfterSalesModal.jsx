import React, { useEffect, useRef, useState } from 'react';
import { ArrowRightLeft, Check, Plus, RefreshCw, RotateCcw, Trash2, X } from 'lucide-react';
import { adjustmentPlan, remainingLines, validateAdjustmentStock } from './afterSales.js';
import { sqbCall } from './sqb.jsx';
import { ConfirmationCheck } from './ConfirmationCheck.jsx';

const money = (cents) => `${(cents / 100).toFixed(2)} 元`;
const settled = (record) => ['paid', 'refunded', 'completed'].includes(record?.state);

export function AfterSalesModal({ order, products, initialType = 'return', pending, onBeforeStart, onRecord, onClose }) {
  const id = useRef(pending?.id || crypto.randomUUID());
  const lines = remainingLines(order);
  const [type, setType] = useState(pending?.request.type || initialType);
  const [selection, setSelection] = useState(() => pending?.request.returns || lines.map((line) => ({ lineId: line.lineId,
    qty: initialType === 'return' && line.productType !== 'gift' ? line.qty : 0,
    restockQty: initialType === 'return' && line.productType !== 'gift' ? line.qty : 0 })));
  const [newItems, setNewItems] = useState(pending?.request.newItems || []);
  const [reason, setReason] = useState(pending?.request.reason || '');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState('');
  const [preview, setPreview] = useState(pending?.preview || null);
  const [record, setRecord] = useState(pending?.record || null);
  const [confirmed, setConfirmed] = useState(false);
  const [testConsent, setTestConsent] = useState(false);
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const working = useRef(false);
  const handler = useRef(onRecord);
  handler.current = onRecord;
  const started = Boolean(pending || record);
  const terminal = settled(record) || ['failed', 'not-started'].includes(record?.state);
  const request = { id: id.current, type, returns: selection.filter((item) => Number(item.qty) > 0),
    newItems: newItems.map(({ imageUrl, ...item }) => item), reason };
  let plan;
  let error = '';
  try { plan = adjustmentPlan(order, request); validateAdjustmentStock(products, plan); }
  catch (issue) { error = issue.message; }

  function changed() { setPreview(null); setConfirmed(false); setMessage(''); }
  function updateReturn(lineId, field, value) {
    changed();
    setSelection((current) => current.map((item) => {
      if (item.lineId !== lineId) return item;
      const number = Number(value);
      return field === 'qty' ? { ...item, qty: number, restockQty: number } : { ...item, [field]: number };
    }));
  }
  function updateNew(index, field, value) {
    changed(); setNewItems((current) => current.map((item, position) => position === index ? { ...item, [field]: value } : item));
  }
  async function execute(action, payload) {
    if (working.current) return;
    working.current = true; setBusy(true);
    try {
      const next = await sqbCall(action, payload);
      setRecord(next); setMessage(next.message || '');
      if (settled(next)) {
        try { await handler.current(next); }
        catch (issue) { setMessage(`资金已处理，账务尚未保存：${issue.message}。请重试保存，勿再次收退款。`); }
      }
    } catch (issue) { setMessage(issue.message); }
    finally { working.current = false; setBusy(false); }
  }
  useEffect(() => {
    if (!started || terminal) return;
    let stopped = false;
    let timer;
    const start = Date.now();
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    async function poll() {
      if (stopped) return;
      await execute('query', { id: id.current });
      if (!stopped) timer = setTimeout(poll, Date.now() - start < 60000 ? 3000 : 15000);
    }
    const online = () => { clearTimeout(timer); poll(); };
    window.addEventListener('online', online);
    timer = setTimeout(poll, 1500);
    return () => { stopped = true; clearTimeout(timer); clearInterval(tick); window.removeEventListener('online', online); };
  }, [started, terminal]);

  async function review() {
    if (error || busy) return;
    setBusy(true); setMessage('');
    try {
      const value = await sqbCall('preview-adjustment', { parentId: order.id, request });
      const key = (p) => JSON.stringify([p.revision, p.deltaCents, p.returns.map((line) => [line.lineId, line.qty, line.restockQty, line.creditCents]), p.newLines.map((line) => [line.id, line.qty, line.price, line.discount, line.productType])]);
      if (key(value.plan) !== key(plan)) throw new Error('本地订单与支付记录不一致，请先恢复最新经营备份');
      setPreview(value);
    } catch (issue) { setMessage(issue.message); }
    finally { setBusy(false); }
  }

  const available = products.filter((item) => item.productType !== 'coupon' && [item.name, item.barcode, item.sku].some((value) => String(value || '').toLowerCase().includes(search.toLowerCase())));
  const display = record?.plan || preview?.plan || plan;
  const amount = display?.deltaCents || 0;
  const stateLabel = settled(record) ? '收钱吧已确认，待保存账务' : record?.state === 'failed' ? '本次资金操作未成功' : record?.state === 'not-started' ? '本次尚未提交' : record?.state === 'review' ? '部分资金结果待核实' : '正在核实资金结果';

  return <div className="modalBackdrop"><div className="modal afterSalesModal" role="dialog" aria-modal="true" aria-label="退货换货">
    <div className="modalHead"><div><h2>退货 / 换货</h2><small>原订单 {order.orderNo}</small></div>
      <button className="iconButton" aria-label="关闭退换货" disabled={busy || started && !terminal} onClick={() => onClose(record)}><X size={20} /></button></div>
    <div className="modalScroll afterSalesBody">
      {order.payment?.mode === 'test' && <p className="sqbWarning">测试商户交易 · 收退款仍可能真实发生</p>}
      <fieldset disabled={started || busy}>
        <div className="afterSalesModes" role="group" aria-label="售后类型">
          <button type="button" aria-pressed={type === 'return'} onClick={() => { setType('return'); changed(); }}><RotateCcw size={17} /> 退货退款</button>
          <button type="button" aria-pressed={type === 'exchange'} onClick={() => { setType('exchange'); changed(); }}><ArrowRightLeft size={17} /> 换货</button>
        </div>
        <h3>退回商品</h3>
        <div className="returnLines">
          {lines.map((line) => {
            const value = selection.find((item) => item.lineId === line.lineId) || { qty: 0, restockQty: 0 };
            const gift = line.productType === 'gift';
            return <div className="returnLine" key={line.lineId}>
              <div><strong>{line.name}</strong><small>{gift ? '赠品' : `可退金额 ${money(line.remainingCents)}`} · 可退 {line.qty} 件</small>
                {gift && <label className="settlementCheck"><input type="checkbox" aria-label={`实际收回${line.name}`} checked={value.qty > 0} onChange={(event) => updateReturn(line.lineId, 'qty', event.target.checked ? line.qty : 0)} />实际收回赠品</label>}</div>
              <label>{gift ? '收回数量' : '退货数量'}<input aria-label={`${line.name}退货数量`} type="number" min="0" max={line.qty} step="1" value={value.qty} onChange={(event) => updateReturn(line.lineId, 'qty', event.target.value)} /></label>
              {!gift && <label>实际入库<input aria-label={`${line.name}入库数量`} type="number" min="0" max={value.qty} step="1" value={value.restockQty} onChange={(event) => updateReturn(line.lineId, 'restockQty', event.target.value)} /></label>}
            </div>;
          })}
        </div>
        {type === 'exchange' && <section className="exchangeSection"><h3>换给顾客的商品</h3>
          {newItems.map((item, index) => <div className="replacementLine" key={index}>
            <div className="sectionHeader"><strong>{item.name}</strong><button type="button" className="dangerIcon" aria-label={`移除换入${item.name}`} onClick={() => { setNewItems((current) => current.filter((_, position) => position !== index)); changed(); }}><Trash2 size={17} /></button></div>
            <div className="editLineFields">
              <label>数量<input type="number" min="1" step="1" value={item.qty} onChange={(event) => updateNew(index, 'qty', event.target.value)} /></label>
              <label>单价<input type="number" min="0" step="0.01" disabled={item.productType === 'gift'} value={item.price} onChange={(event) => updateNew(index, 'price', event.target.value)} /></label>
              <label>优惠金额<input type="number" min="0" step="0.01" disabled={item.productType === 'gift'} value={item.discount} onChange={(event) => updateNew(index, 'discount', event.target.value)} /></label>
            </div>
          </div>)}
          <div className="exchangePicker"><label>查找商品<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="商品名、条码或编码" /></label>
            <label>换入商品<select aria-label="换入商品" value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">选择商品</option>{available.map((item) => <option key={item.id} value={item.id}>{item.name} · 库存 {item.stock} · {money(Math.round(item.price * 100))}</option>)}</select></label>
            <button className="utilityButton" type="button" disabled={!selected} onClick={() => { const item = products.find((entry) => entry.id === selected); if (!item) return; setNewItems((current) => [...current, { ...item, qty: 1, discount: 0 }]); changed(); }}><Plus size={17} /> 加入</button>
          </div>
        </section>}
        <label>退换原因<input maxLength="200" value={reason} onChange={(event) => { setReason(event.target.value); changed(); }} /></label>
      </fieldset>
      {started && <div className="transactionProgress" role="status"><strong>{stateLabel}</strong>{!terminal && <span>已等待 {elapsed} 秒 · 自动查单中</span>}</div>}
      {message && <p className="dangerText" role="alert">{message}</p>}
    </div>
    <div className="modalFooter afterSalesFooter">
      <div className="afterSalesTotals"><span>原商品可退 <b>{money(display?.creditCents || 0)}</b></span><span>换入商品 <b>{money(display?.replacementCents || 0)}</b></span><strong>{amount < 0 ? '原路退款' : amount > 0 ? '需补收' : '差额'} {money(Math.abs(amount))}</strong></div>
      {!started && <>
        {error && <p className="dangerText" role="alert">{error}</p>}
        {!preview ? <button className="submitButton" disabled={busy || !!error} onClick={review}><Check size={18} /> 核对退换货</button> : <form onSubmit={async (event) => {
          event.preventDefault(); if (working.current || busy || !confirmed || preview.mode === 'test' && !testConsent) return;
          if (amount > 0 && !/^\d{16,32}$/.test(code.trim())) { setMessage('请扫描顾客付款码'); return; }
          working.current = true; setBusy(true);
          let prepared = false;
          try { prepared = await onBeforeStart({ id: id.current, parentId: order.id, request, preview }); }
          catch (issue) { setMessage(issue.message); }
          finally { working.current = false; setBusy(false); }
          if (!prepared) return;
          const paymentCode = code.trim(); setCode('');
          await execute('start-adjustment', { parentId: order.id, request, digest: preview.digest, confirm: true, confirmTestPayment: testConsent, code: paymentCode });
        }}>
          {amount > 0 && <label>补款付款码<input type="password" autoComplete="off" aria-label="补款付款码" value={code} onChange={(event) => setCode(event.target.value)} /></label>}
          <ConfirmationCheck checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)}>确认商品数量、实际入库及{amount < 0 ? `原路退款 ${money(-amount)}` : amount > 0 ? `补收 ${money(amount)}` : '无资金差额'}</ConfirmationCheck>
          {preview.mode === 'test' && <ConfirmationCheck checked={testConsent} disabled={busy} onChange={(event) => setTestConsent(event.target.checked)}>确认测试商户可能真实收退款</ConfirmationCheck>}
          <button className="submitButton" disabled={busy || !confirmed || preview.mode === 'test' && !testConsent}><Check size={18} /> {amount < 0 ? '确认原路退款' : amount > 0 ? '确认补款' : '确认退换货'}</button>
        </form>}
      </>}
      {started && <button className="utilityButton" disabled={busy} onClick={() => execute('query', { id: id.current })}><RefreshCw size={18} /> {settled(record) ? '重试保存账务' : '查询处理结果'}</button>}
      {['failed', 'not-started'].includes(record?.state) && <button className="submitButton" disabled={busy} onClick={() => onClose(record)}>关闭本次处理</button>}
    </div>
  </div></div>;
}
