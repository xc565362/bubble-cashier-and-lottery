import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, RefreshCw } from 'lucide-react';
import { sqbCall } from './sqb.jsx';
import { drawIssuanceLabel, drawOutcomeLabel, drawRedemptionLabel, drawTime, drawWarningLabel, normalizeDrawRecords } from './lotteryRecords.js';

export function LotteryRecordsTable({ page }) {
  return <div className="lotteryTableWrap"><table className="lotteryTable lotteryRecordsTable"><thead><tr>
    <th>抽奖时间 / 记录编号</th><th>参与人标识</th><th>结果 / 奖品</th><th>凭证发放</th><th>券中心核销状态</th>
  </tr></thead><tbody>{page.items.map(row => <tr key={row.recordId}>
    <td><time>{drawTime(row.createdAt)}</time><code>{row.recordId}</code></td>
    <td><code>{row.participantRef}</code></td>
    <td><strong className={`drawResult ${row.outcome}`}>{drawOutcomeLabel(row.outcome)}</strong><small>{row.prize?.name || (row.outcome === 'lost' ? '谢谢惠顾' : '奖品待核对')}</small></td>
    <td><span>{drawIssuanceLabel(row.issuance.status)}</span>{row.issuance.couponId && <small>券编号：{row.issuance.couponId}</small>}
      {row.issuance.status === 'pending' && <small>结果已保存，凭证尚未发出</small>}</td>
    <td><span>{drawRedemptionLabel(row)}</span>{row.redemption.source === 'coupon_center' && row.redemption.checkedAt != null && <small>核对于 {drawTime(row.redemption.checkedAt)}</small>}
      {row.redemption.source === 'coupon_center' && row.redemption.status === 'REDEEMED' && row.redemption.redeemedAt != null && <small>核销于 {drawTime(row.redemption.redeemedAt)}</small>}
      {row.redemption.source === 'legacy_record' && <small>旧记录保留，尚无券中心确认</small>}</td>
  </tr>)}</tbody></table></div>;
}

export function LotteryRecords({ activity, campaignId, supported, connectionKey = '' }) {
  const [outcome, setOutcome] = useState('all'), [cursors, setCursors] = useState(['']);
  const [refresh, setRefresh] = useState(0), [page, setPage] = useState(null), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const generation = useRef(0), cursor = cursors.at(-1);
  useEffect(() => { setCursors(['']); setPage(null); }, [campaignId, connectionKey]);
  useEffect(() => {
    const version = ++generation.current;
    setPage(null); setError('');
    if (!supported) { setLoading(false); return; }
    setLoading(true);
    sqbCall(`${activity}-records`, { limit: 20, cursor, outcome }).then(data => {
      if (generation.current === version) {
        const next = normalizeDrawRecords(data, campaignId);
        if (next.nextCursor && cursors.includes(next.nextCursor)) throw new Error('记录分页游标未前进，请刷新后重试');
        setPage(next);
      }
    }).catch(issue => { if (generation.current === version) setError(issue.message || '抽奖记录读取失败，请重试'); })
      .finally(() => { if (generation.current === version) setLoading(false); });
    return () => { generation.current++; };
  }, [activity, campaignId, connectionKey, supported, cursor, outcome, refresh]);
  function reset() { setCursors(['']); setRefresh(value => value + 1); }
  return <section className="lotteryRecords" aria-label="抽奖记录">
    <div className="sectionHeader"><div><h3>抽奖记录</h3><p className="lotteryHelp">读取云端保存的逐次结果；中奖、发券和核销分别列出。记录按固定编号排序。</p></div>
      <button type="button" className="utilityButton" disabled={!supported || loading} onClick={reset}><RefreshCw size={16} /> 刷新抽奖记录</button></div>
    {!supported ? <p className="lotteryNotice" role="status">当前活动服务尚未提供抽奖明细接口，升级后可查看。这里不会用演示记录代替真实数据。</p> : <>
      <div className="lotteryRecordFilters"><label>抽奖结果<select value={outcome} disabled={loading} onChange={event => { setOutcome(event.target.value); setCursors(['']); }}>
        <option value="all">全部结果</option><option value="won">已中奖</option><option value="lost">未中奖</option>
      </select></label>{page && <span>云端共 {page.total} 条 · 第 {cursors.length} 页 · 查询于 {drawTime(page.queriedAt)}</span>}</div>
      <p className="lotteryHelp">参与人使用匿名标识；未中奖也会保存。刷新可核对最新发券和核销状态。</p>
      {loading && <p role="status">正在读取云端抽奖记录并核对券中心…</p>}
      {error && <p className="lotteryNotice dangerText" role="alert">{error}</p>}
      {page && <>{page.warnings.map((warning, i) => <p className="lotteryNotice" role="status" key={i}>{drawWarningLabel(warning)}</p>)}
        {page.items.length ? <LotteryRecordsTable page={page} /> : <p className="lotteryEmpty">云端暂无符合条件的抽奖记录</p>}
        <div className="lotteryRecordPagination"><button type="button" className="utilityButton" disabled={loading || cursors.length <= 1} onClick={() => setCursors(old => old.slice(0, -1))}><ArrowLeft size={16} /> 上一页记录</button>
          <button type="button" className="utilityButton" disabled={loading || !page.hasMore} onClick={() => setCursors(old => [...old, page.nextCursor])}>下一页记录 <ArrowRight size={16} /></button></div>
      </>}
    </>}
  </section>;
}
