import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Trash2, AlertTriangle, Wrench } from 'lucide-react';
import { sqbCall } from '../api/sqb.js';

// Orphan observatory: one screen that shows everything which can latch the
// till (hanging orders, unresolved payment records, unfinished coupon
// transactions, stale award reservations) and lets an admin clear the safe
// ones without touching the database by hand.
export function MaintenanceScreen({ flash }) {
  const [scan, setScan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = useCallback(async (action, payload, okText) => {
    setBusy(true); setError('');
    try {
      const data = await sqbCall(action, payload);
      if (action === 'maintenance-scan') setScan(data);
      else {
        flash?.(okText || '已处理');
        setScan(await sqbCall('maintenance-scan'));
      }
      return data;
    } catch (e) { setError(e.message); return null; }
    finally { setBusy(false); }
  }, [flash]);

  useEffect(() => { run('maintenance-scan'); }, [run]);

  const latch = scan?.latch;
  const clean = scan && !scan.hangingOrders.length && !scan.unresolvedPayments.length
    && !scan.couponTx.length && !scan.awardReservations.length && !latch?.recoveryRequired;

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-milk">
          <Wrench size={18} className="text-coral-soft" /> 系统维护 · 孤儿观测
        </h2>
        <button className="btn-ghost" disabled={busy} onClick={() => run('maintenance-scan')}>
          <RefreshCw size={15} className={busy ? 'animate-spin' : ''} /> 刷新
        </button>
      </header>

      {error && <p className="rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-2.5 text-sm text-red-300" role="alert">{error}</p>}

      {!scan && !error && <p className="text-sm text-mist">正在扫描…</p>}

      {scan && (
        <>
          <div className={`rounded-2xl border p-4 ${clean ? 'border-emerald-400/30 bg-emerald-400/5' : 'border-red-400/30 bg-red-400/5'}`}>
            <p className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle size={15} className={clean ? 'text-emerald-300' : 'text-red-300'} />
              {clean ? '系统干净：没有悬挂订单、未决支付、未完成券交易或领奖占用。' : '发现残留：以下项目可能阻塞收银，请逐项处理。'}
            </p>
            <div className="mt-2 grid gap-x-6 gap-y-1 text-xs text-mist sm:grid-cols-2">
              <p>收银锁：{latch.lease ? `${latch.lease.displayName || latch.lease.userId} 持有（剩余 ${Math.max(0, Math.round(latch.lease.expiresInMs / 1000))}s${latch.lease.recoveryRequired ? ' · 需恢复' : ''}）` : '无'}</p>
              <p>恢复标记：{latch.recoveryRequired ? '是（收银被暂停）' : '否'}</p>
              <p>待收款：{latch.pendingPayment || '无'} · 待退换：{latch.pendingAdjustment || '无'} · 待零元：{latch.pendingZero || '无'}</p>
              <p>确认外箱：{latch.outbox.length ? latch.outbox.join('，') : '空'}</p>
            </div>
          </div>

          <Block title={`悬挂订单（${scan.hangingOrders.length}）`} hint="仅「已取消」且无支付流水的订单可在此移除；其他状态请走正常收退款流程。">
            {scan.hangingOrders.map((o) => (
              <Row key={o.id}>
                <Cell label="单号" value={o.orderNo} />
                <Cell label="状态" value={`${o.status} · ${o.method}`} />
                <Cell label="金额" value={`¥${(Number(o.total) / 100).toFixed(2)}`} />
                <Cell label="创建" value={(o.createdAt || '').replace('T', ' ').slice(0, 19)} />
                <button
                  className="btn-ghost !min-h-[30px] !px-2.5 !py-0.5 text-xs hover:!border-red-400/50 hover:!text-red-300"
                  disabled={busy || o.status !== '已取消' || Boolean(o.paymentOrderSn) || o.afterSales > 0}
                  title={o.status !== '已取消' ? '只有已取消订单可移除' : o.paymentOrderSn ? '存在支付流水，不能移除' : o.afterSales ? '存在售后记录，不能移除' : '移除这条悬挂订单'}
                  onClick={() => {
                    if (!window.confirm(`确定移除悬挂订单 ${o.orderNo}？\n该操作会把它从账本中删除，不可恢复。`)) return;
                    run('maintenance-remove-order', { id: o.id }, '订单已移除');
                  }}
                ><Trash2 size={12} /> 移除</button>
              </Row>
            ))}
          </Block>

          <Block title={`未决支付记录（${scan.unresolvedPayments.length}）`} hint="涉及资金，不能在此删除：请到收银台用「查单」核实后完成或恢复。">
            {scan.unresolvedPayments.map((r) => (
              <Row key={r.id}>
                <Cell label="单号" value={r.orderNo || r.id} />
                <Cell label="状态" value={r.state} />
                <Cell label="金额" value={`¥${(Number(r.amount) / 100).toFixed(2)}`} />
                <Cell label="更新" value={(r.updatedAt || '').replace('T', ' ').slice(0, 19)} />
                <span className="max-w-56 truncate text-xs text-mist" title={r.message}>{r.message || '—'}</span>
              </Row>
            ))}
          </Block>

          <Block title={`未完成券交易（${scan.couponTx.length}）`} hint="中奖券已扫码占用但未完成结算的，可在此释放。">
            {scan.couponTx.map((r) => (
              <Row key={r.id}>
                <Cell label="券" value={r.name} />
                <Cell label="状态" value={r.state + (r.zeroDraft ? ' · 零元' : '')} />
                <Cell label="订单" value={r.orderId || '—'} />
                <button
                  className="btn-ghost !min-h-[30px] !px-2.5 !py-0.5 text-xs"
                  disabled={busy || r.zeroDraft}
                  title={r.zeroDraft ? '零元结算中的券请完成订单恢复' : '释放这张券的占用'}
                  onClick={() => {
                    if (!window.confirm(`确定释放 ${r.name} 的占用？\n券将退回参与者，可重新扫码结算。`)) return;
                    run('coupon-release', { id: r.id }, '券占用已释放');
                  }}
                >释放</button>
              </Row>
            ))}
          </Block>

          <Block title={`领奖占用（${scan.awardReservations.length}）`} hint="已加入购物车或收银的奖品占用；释放后商品库存与奖池由系统重新核对。">
            {scan.awardReservations.map((r) => (
              <Row key={r.id}>
                <Cell label="奖品" value={r.name || '奖品'} />
                <Cell label="编号" value={r.id.slice(0, 13) + '…'} />
                <button
                  className="btn-ghost !min-h-[30px] !px-2.5 !py-0.5 text-xs"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm(`确定释放领奖占用 ${r.id.slice(0, 8)}？`)) return;
                    run('maintenance-release-award', { id: r.id }, '领奖占用已释放');
                  }}
                >释放</button>
              </Row>
            ))}
          </Block>

          {scan.failedPayments.length > 0 && (
            <details className="rounded-2xl border border-line bg-panel/40 p-4">
              <summary className="cursor-pointer text-sm font-medium text-mist">已完结的失败记录（近 {scan.failedPayments.length} 条，仅供参考）</summary>
              <div className="mt-2 space-y-1.5">
                {scan.failedPayments.map((r) => (
                  <Row key={r.id}>
                    <Cell label="单号" value={r.orderNo || r.id} />
                    <Cell label="金额" value={`¥${(Number(r.amount) / 100).toFixed(2)}`} />
                    <Cell label="确认" value={r.acknowledged ? '已确认' : '未确认'} />
                    <span className="max-w-64 truncate text-xs text-mist" title={r.message}>{r.message || '—'}</span>
                  </Row>
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function Block({ title, hint, children }) {
  return (
    <div className="rounded-2xl border border-line bg-panel/60 p-4">
      <h3 className="text-sm font-semibold text-milk">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-mist/80">{hint}</p>}
      <div className="mt-2 space-y-1.5">
        {children.length ? children : <p className="text-xs text-mist/60">无</p>}
      </div>
    </div>
  );
}

function Row({ children }) {
  return <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-ink/40 px-3 py-2">{children}</div>;
}

function Cell({ label, value }) {
  return (
    <span className="text-xs"><span className="text-mist/60">{label} </span><span className="text-milk/90">{value}</span></span>
  );
}
