import React, { useState } from 'react';
import { motion } from '../lib/motion.js';
import { Check, Download, Pencil, RefreshCw, Search } from 'lucide-react';
import { PageShell, Badge } from '../components/ui.jsx';
import { money, todayKey } from '../lib/format.js';
import { isExternalPhysical, orderSerial } from '../logic/orderLogic.js';
import { channelName, orderDisplayStatus, orderNet, remainingLines, tenderTotals, transactionTime } from '../logic/afterSales.js';
import { LEDGER_SEARCH_FIELDS, LEDGER_SEARCH_GROUPS } from '../logic/ledgerSearch.js';

export function OrdersScreen({
  readOnly = false,
  orders, selectedDate, setSelectedDate, search, setSearch,
  selectedTotal, selectedSubtotal, selectedDiscount,
  onEdit, onCancel, onConfirmLegacy, onExport, isAdmin = true,
}) {
  const [field, setField] = useState(search.field);
  const [keyword, setKeyword] = useState(search.keyword);
  const activeField = LEDGER_SEARCH_FIELDS.find((item) => item.id === search.field);
  const draftField = LEDGER_SEARCH_FIELDS.find((item) => item.id === field);
  const hasSearch = !!search.keyword;
  const dirty = field !== search.field || keyword.trim() !== search.keyword;
  const scopeLabel = selectedDate || '全部日期';

  function resetSearch() {
    setField(''); setKeyword(''); setSearch({ field: '', keyword: '' });
  }

  return (
    <PageShell
      kicker="Ledger"
      title="收款流水"
      actions={
        <button className="btn-ghost text-sm" onClick={onExport} disabled={!orders.length || dirty}>
          <Download size={16} /> {hasSearch ? '导出匹配订单明细' : selectedDate ? '导出当天明细' : isAdmin ? '导出全部明细' : '导出我的明细'}
        </button>
      }
    >
      <div className="glass mb-4 flex flex-wrap items-end gap-3 px-4 py-4">
        <label className="block">
          <span className="field-label">查看日期</span>
          <input className="field !w-44" type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} />
        </label>
        <button className="btn-ghost !min-h-[44px]" onClick={() => setSelectedDate(todayKey())}>回到今天</button>
        <button className="btn-ghost !min-h-[44px]" aria-pressed={!selectedDate} onClick={() => setSelectedDate('')}>全部日期</button>
        <span className="ml-auto text-sm text-mist">{hasSearch ? '匹配 ' : ''}{orders.length} 笔</span>
      </div>

      <form
        className="glass mb-4 grid gap-3 px-4 py-4 sm:grid-cols-[200px_1fr_auto] sm:items-end"
        aria-label="流水查询"
        onSubmit={(event) => {
          event.preventDefault();
          if (field && keyword.trim()) setSearch({ field, keyword: keyword.trim() });
        }}
      >
        <label className="block">
          <span className="field-label">查询字段</span>
          <select className="field" aria-label="查询字段" value={field} onChange={(e) => { setField(e.target.value); setKeyword(''); }}>
            <option value="">请选择查询字段</option>
            {LEDGER_SEARCH_GROUPS.map((group) => (
              <optgroup key={group} label={group}>
                {LEDGER_SEARCH_FIELDS.filter((item) => item.group === group).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="field-label">查询内容</span>
          <input
            className="field"
            type="search"
            value={keyword}
            disabled={!field}
            maxLength={200}
            inputMode={draftField?.kind === 'money' ? 'decimal' : draftField?.kind === 'number' ? 'numeric' : 'text'}
            placeholder={!field ? '先选择字段' : draftField?.kind === 'money' ? '金额（元）' : draftField?.kind === 'number' ? '数量' : '输入查询内容'}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </label>
        <div className="flex gap-2">
          <button type="submit" className="btn-primary" disabled={!field || !keyword.trim()}><Search size={16} /> 查询</button>
          <button type="button" className="btn-ghost" onClick={resetSearch} disabled={!field && !keyword && !hasSearch}><RefreshCw size={16} /> 重置</button>
        </div>
      </form>

      <div className="mb-5 grid grid-cols-3 gap-3">
        {[
          [hasSearch ? '匹配订单净收入' : selectedDate ? '当天净收入' : '全部净收入', selectedTotal, 'text-coral-soft'],
          [hasSearch ? '匹配订单收款' : selectedDate ? '当天收款' : '全部收款', selectedSubtotal, 'text-emerald-300'],
          [hasSearch ? '匹配订单退款' : selectedDate ? '当天退款' : '全部退款', selectedDiscount, 'text-red-300'],
        ].map(([label, value, tone]) => (
          <motion.div key={label} className="glass px-4 py-4 text-center" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
            <p className="text-xs text-mist">{label}</p>
            <p className={`mt-1 text-xl font-black sm:text-2xl ${tone}`}>{money(value)}</p>
          </motion.div>
        ))}
      </div>

      <p className="mb-3 text-xs text-mist" role="status" aria-live="polite">
        {scopeLabel}{hasSearch ? ` · ${activeField?.label}：${search.keyword}` : isAdmin ? ' · 全部流水' : ' · 我的流水'}
        {dirty && <span className="ml-2 text-amber-300">查询条件已修改，尚未应用</span>}
      </p>

      {orders.length === 0 ? (
        <div className="glass py-14 text-center text-mist">{hasSearch ? '没有符合查询条件的流水' : selectedDate ? '这个日期还没有收款记录' : '暂无收款记录'}</div>
      ) : (
        <div className="space-y-3">
          {orders.map((order) => (
            <motion.article
              layout
              key={order.id}
              className="glass flex flex-wrap items-start justify-between gap-4 px-5 py-4"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-lg text-coral-soft">净额 {money(orderNet(order))}</strong>
                  <Badge tone={order.status === '已取消' ? 'danger' : order.status === '待收款' ? 'warn' : 'ok'}>{orderDisplayStatus(order)}</Badge>
                  {order.payment?.mode === 'test' && <Badge tone="warn">测试商户交易</Badge>}
                </div>
                <p className="text-sm text-mist">{new Date(transactionTime(order.payment?.tenders, order.paidAt || order.createdAt)).toLocaleString('zh-CN')} · {order.method}</p>
                <p className="text-xs text-mist">原金额 {money(order.subtotal ?? order.total)} · 优惠 {money(order.discount || 0)}</p>
                <p className="font-mono text-xs text-mist/70">流水号 {orderSerial(order) || '待补齐收钱吧流水号'}</p>
                {order.payment?.orderSn && <p className="text-xs text-mist/70">本地订单 {order.orderNo} · 收钱吧轻POS订单号 {order.payment.orderSn}</p>}
                {order.payment?.tenders?.map((tender) => (
                  <p className="text-xs text-mist/80" key={tender.tenderSn}>
                    {channelName(tender)} · 原支付 {(tender.amount / 100).toFixed(2)} 元{tender.internalTransactionSn ? ` · 流水号 ${tender.internalTransactionSn}` : ''}
                  </p>
                ))}
                {order.payment?.provider === 'sqb' && (
                  <p className="text-xs text-mist/80">
                    渠道顾客实付 {tenderTotals(order.payment.tenders, 'paidAmount') == null ? '未返回' : money(tenderTotals(order.payment.tenders, 'paidAmount'))} · 渠道商户实收 {tenderTotals(order.payment.tenders, 'collectedAmount') == null ? '未返回' : money(tenderTotals(order.payment.tenders, 'collectedAmount'))}
                  </p>
                )}
                {order.items.some(isExternalPhysical) && <p className="text-xs text-amber-300">{order.physicalFulfilled ? '实物奖品已核销' : '实物奖品领取确认待同步'}</p>}
                <p className="text-xs text-mist">原商品：{order.items.map((item) => `${item.name} × ${item.qty}`).join('，')}</p>
                {!!order.afterSales?.length && <p className="text-xs text-mist">当前商品：{remainingLines(order).map((item) => `${item.name} × ${item.qty}`).join('，') || '已全部退回'}</p>}
                {!!order.afterSales?.length && (
                  <details className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs">
                    <summary className="cursor-pointer text-mist">退换货记录 ({order.afterSales.length})</summary>
                    {order.afterSales.map((entry) => (
                      <div key={entry.id} className="mt-2 space-y-0.5 border-t border-white/[0.05] pt-2">
                        <b>{entry.plan.deltaCents < 0 ? '已退款' : entry.plan.deltaCents > 0 ? '已补款' : '零差价调整'} {money(Math.abs(entry.plan.deltaCents) / 100)}</b>
                        <p className="text-mist">{new Date(transactionTime(entry.tenders, entry.completedAt)).toLocaleString('zh-CN')} · {entry.orderSn || entry.id}</p>
                        <p className="text-mist">退回：{entry.plan.returns.map((item) => `${item.name} × ${item.qty}（入库 ${item.restockQty}）`).join('，')}</p>
                        {!!entry.plan.newLines.length && <p className="text-mist">换出：{entry.plan.newLines.map((item) => `${item.name} × ${item.qty}`).join('，')}</p>}
                        {!!entry.tenders?.length && <p className="font-mono text-mist/70">流水号 {entry.tenders.map((item) => item.internalTransactionSn || item.tenderSn).join(' / ')}</p>}
                        {entry.plan.reason && <p className="text-mist">原因：{entry.plan.reason}</p>}
                      </div>
                    ))}
                  </details>
                )}
                {order.updatedAt && <p className="text-xs text-mist/60">更新于 {new Date(order.updatedAt).toLocaleString('zh-CN')} · {(order.revisions?.length || 0) + (order.afterSales?.length || 0)} 次变更</p>}
              </div>
              {order.status !== '已取消' && (
                <div className="flex shrink-0 flex-col items-stretch gap-2">
                  {order.status === '待收款' ? (
                    <button className="btn-ghost !min-h-[40px] !py-2 text-sm" disabled={readOnly} onClick={() => onConfirmLegacy(order.id)}>
                      <Check size={15} /> 确认收款
                    </button>
                  ) : (
                    <button className="btn-ghost !min-h-[40px] !py-2 text-sm" disabled={readOnly} onClick={() => onEdit(order)}>
                      <Pencil size={15} /> 编辑 / 换货
                    </button>
                  )}
                  <button className="btn-danger !min-h-[40px] !py-2 text-sm" disabled={readOnly} onClick={() => onCancel(order.id)}>
                    {order.payment?.provider === 'sqb' ? '退货 / 取消并退款' : '取消订单'}
                  </button>
                </div>
              )}
            </motion.article>
          ))}
        </div>
      )}
    </PageShell>
  );
}
