import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from '../lib/motion.js';
import { Barcode, Check, CheckCircle2, RefreshCw, ScanLine, ShieldAlert, X, XCircle } from 'lucide-react';
import { sqbCall, enablePaymentNotifications } from '../api/sqb.js';
import { ConfirmationCheck, Modal, spring } from '../components/ui.jsx';
import { money } from '../lib/format.js';

const stateLabelMap = {
  pending: '等待顾客付款 / 正在核实',
  review: '结果待核实，请联系收钱吧，勿重复收款',
  paid: '收钱吧已确认收款',
  failed: '收钱吧已确认本次未支付成功',
  'not-started': '本次未向收钱吧发起收款',
};

export function SqbPaymentModal({ order, pending, scanCode, onBeforeStart, onRecord, onClose, onSettings }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(pending?.review?.message || '');
  const [record, setRecord] = useState(pending?.record || null);
  const [ready, setReady] = useState(false);
  const [pollExpired, setPollExpired] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [testMode, setTestMode] = useState(true);
  const [confirmPayment, setConfirmPayment] = useState(false);
  const [waitingForCode, setWaitingForCode] = useState(false);
  const [confirmNotCharged, setConfirmNotCharged] = useState(false);
  const pollStartedAt = useRef(Date.now());
  const inputRef = useRef(null);
  const autoSubmitTimer = useRef(null);
  const scanArmed = useRef(false);
  const working = useRef(false);
  const autoHandled = useRef(false);
  const pendingAuto = useRef(null);
  const recordHandler = useRef(onRecord);
  recordHandler.current = onRecord;
  const started = Boolean(pending?.started || record);
  const terminal = record?.state === 'paid' || record?.state === 'failed' || record?.state === 'not-started';

  useEffect(() => {
    sqbCall('config').then((value) => {
      setReady(value.ready);
      setTestMode(value.mode !== 'production');
      if (!value.ready) setMessage('请先完成收钱吧接口配置');
    }).catch((error) => setMessage(error.message));
  }, []);

  // Production checkouts go straight to scanning — the deliberate act is the
  // physical scan of the customer's code, not a checkbox. Test merchants still
  // move real money, so test mode keeps the confirmation checkbox.
  const autoArmed = useRef(false);
  useEffect(() => {
    if (autoArmed.current || !ready || testMode || started || terminal) return;
    autoArmed.current = true;
    scanArmed.current = true;
    setConfirmPayment(true);
    setCode(''); setMessage('');
    setWaitingForCode(true);
    enablePaymentNotifications().catch(() => {}).finally(() => {
      if (scanArmed.current) inputRef.current?.focus();
    });
  }, [ready, testMode, started, terminal]);

  async function execute(action, payload) {
    if (working.current) return;
    working.current = true; setBusy(true);
    try {
      const next = await sqbCall(action, payload);
      setRecord(next); setMessage(next.message || '');
      await recordHandler.current(next);
    } catch (error) { setMessage(error.message); }
    finally { working.current = false; setBusy(false); }
  }

  async function closePayment() {
    if (working.current) return;
    working.current = true; setBusy(true);
    try { await onClose(record); }
    catch (error) { setMessage(error.message); }
    finally { working.current = false; setBusy(false); }
  }

  function beginScanning(event) {
    event.preventDefault();
    if (!ready || busy || working.current || started || (testMode && !confirmPayment)) return;
    scanArmed.current = true;
    setCode(''); setMessage(''); setWaitingForCode(true);
    enablePaymentNotifications().catch(() => {}).finally(() => {
      if (scanArmed.current) inputRef.current?.focus();
    });
  }

  function cancelScanning() {
    clearTimeout(autoSubmitTimer.current);
    scanArmed.current = false;
    setWaitingForCode(false); setConfirmPayment(false); setCode(''); setMessage('');
  }

  async function submitPaymentCode(value) {
    clearTimeout(autoSubmitTimer.current);
    if (!scanArmed.current || started || working.current || !ready || (testMode && !confirmPayment)) return;
    // Scanners on mismatched keyboard layouts emit full-width digits or
    // prefix/suffix junk; normalize to plain ASCII digits before validating.
    const paymentCode = String(value ?? '')
      .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/[^0-9]/g, '');
    if (!/^\d{16,32}$/.test(paymentCode)) {
      setMessage(paymentCode.length >= 16
        ? `扫到 ${paymentCode.length} 位数字（需 16–32 位），请重新扫描`
        : `只扫到 ${paymentCode.length} 位数字，扫描枪可能漏字或顾客出示的不是「收付款」条码，请重新扫描`);
      setCode(''); inputRef.current?.focus();
      return;
    }
    // Disarm synchronously so consecutive scanner terminators cannot submit twice.
    scanArmed.current = false;
    setCode(''); setWaitingForCode(false);
    working.current = true; setBusy(true);
    let prepared = false;
    try { prepared = await onBeforeStart(); }
    catch (issue) { setMessage(issue.message); }
    finally { working.current = false; setBusy(false); }
    if (!prepared) { setConfirmPayment(false); return; }
    await execute('start', { draft: order, code: paymentCode, confirmTestPayment: testMode && confirmPayment });
  }

  useEffect(() => {
    if (!waitingForCode || started || !ready) return;
    const focusScanner = () => {
      if (scanArmed.current && document.visibilityState === 'visible') inputRef.current?.focus();
    };
    focusScanner();
    window.addEventListener('focus', focusScanner);
    document.addEventListener('visibilitychange', focusScanner);
    return () => {
      window.removeEventListener('focus', focusScanner);
      document.removeEventListener('visibilitychange', focusScanner);
    };
  }, [waitingForCode, started, ready]);

  useEffect(() => () => { scanArmed.current = false; }, []);

  // USB-scanned payment code (bubble-scan routing): arm the code input and
  // auto-submit through the exact same submitPaymentCode path a human Enter
  // uses, so validation and double-submit guards stay in charge.
  useEffect(() => { autoHandled.current = false; }, [scanCode]);
  useEffect(() => () => clearTimeout(autoSubmitTimer.current), []);

  useEffect(() => {
    if (!scanCode || autoHandled.current || started || terminal || !ready) return;
    autoHandled.current = true;
    pendingAuto.current = scanCode;
    setConfirmPayment(true);
    scanArmed.current = true;
    setCode(scanCode);
    setMessage('');
    setWaitingForCode(true);
    enablePaymentNotifications().catch(() => {});
  }, [scanCode, ready, started, terminal]);

  useEffect(() => {
    if (!pendingAuto.current || !confirmPayment || !waitingForCode || !ready) return;
    const value = pendingAuto.current;
    pendingAuto.current = null;
    submitPaymentCode(value);
  }, [confirmPayment, waitingForCode, ready]);

  useEffect(() => {
    if (!started || terminal) return;
    let stopped = false;
    let timer;
    async function poll() {
      if (stopped) return;
      const elapsed = Date.now() - pollStartedAt.current;
      if (elapsed >= 60000) setPollExpired(true);
      await execute('query', { id: order.id });
      // Most payments settle within seconds: poll tightly at first so the
      // till confirms while the customer is still looking at their phone.
      if (!stopped) timer = setTimeout(poll, elapsed >= 60000 ? 15000 : elapsed >= 30000 ? 3000 : 1500);
    }
    const createdAt = Date.parse(record?.createdAt || pending?.record?.createdAt || order.createdAt);
    pollStartedAt.current = Number.isFinite(createdAt) && createdAt <= Date.now() ? createdAt : Date.now();
    setElapsed(Math.floor((Date.now() - pollStartedAt.current) / 1000));
    setPollExpired(false);
    timer = setTimeout(poll, 1500);
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - pollStartedAt.current) / 1000)), 1000);
    const online = () => { clearTimeout(timer); poll(); };
    window.addEventListener('online', online);
    return () => { stopped = true; clearTimeout(timer); clearInterval(tick); window.removeEventListener('online', online); };
  }, [started, terminal, order.id]);

  const stateLabel = stateLabelMap[record?.state] || (started ? '正在确认支付结果' : waitingForCode ? '等待顾客付款码' : '准备收款');
  const missingOrder = record?.state === 'pending' && record?.missingOrder && !record.orderSn && !record.remoteOrderSeenAt && !record.tenders?.length;
  const recoveryReady = missingOrder && record.missingOrder.count >= 2
    && Date.parse(record.missingOrder.lastCheckedAt) - Date.parse(record.missingOrder.firstCheckedAt) >= 60000
    && Date.now() - Date.parse(record.createdAt) >= 120000;

  const phase = record?.state === 'paid' ? 'paid'
    : ['failed', 'not-started'].includes(record?.state) ? 'failed'
      : started ? 'polling'
        : waitingForCode ? 'scan' : 'idle';

  return (
    <Modal
      title="收钱吧收款"
      subtitle={order.orderNo}
      onClose={busy || (started && !terminal) ? undefined : closePayment}
      footer={
        <div className="space-y-3">
          {message && <p className="rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-2.5 text-sm text-red-300" role="alert">{message}</p>}
          {record?.state === 'paid' && (
            <p className="text-xs text-mist">收款结果已保留。订单未核对保存前，收银保持暂停；关闭弹窗不会取消付款或清除记录。</p>
          )}
          <div className="flex flex-wrap gap-2">
            {!ready && !started && <button className="btn-ghost" onClick={onSettings}>配置收钱吧</button>}
            {started && (
              <button className="btn-ghost" disabled={busy} onClick={() => execute('query', { id: order.id })}>
                <RefreshCw size={16} className={busy ? 'animate-spin' : ''} />
                {busy ? '正在查询' : record?.state === 'paid' ? '重试保存订单' : '重新查询支付结果'}
              </button>
            )}
            {record?.state === 'paid' && (
              <button className="btn-ghost" disabled={busy} onClick={closePayment}>
                <X size={16} /> 关闭弹窗，保留待核对
              </button>
            )}
            {['failed', 'not-started'].includes(record?.state) && (
              <button className="btn-primary" disabled={busy} onClick={closePayment}>返回购物车</button>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        <motion.div
          className="glass relative overflow-hidden px-6 py-5 text-center"
          animate={phase === 'paid' ? { boxShadow: '0 0 42px rgba(52,211,153,0.28)' } : phase === 'polling' || phase === 'scan' ? { boxShadow: '0 0 34px rgba(255,101,46,0.22)' } : {}}
        >
          <p className="text-xs uppercase tracking-[0.25em] text-mist">本单应收</p>
          <motion.p
            key={order.total}
            className="mt-1 text-5xl font-black tracking-tight text-white"
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={spring}
          >
            {money(order.total)}
          </motion.p>
        </motion.div>

        <AnimatePresence mode="wait">
          <motion.div
            key={phase}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22 }}
          >
            {phase === 'paid' && (
              <div className="flex flex-col items-center gap-2 py-2 text-center">
                <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 16 }}>
                  <CheckCircle2 size={56} className="text-emerald-400" />
                </motion.div>
                <p className="text-lg font-bold text-emerald-300">{stateLabel}</p>
              </div>
            )}
            {phase === 'failed' && (
              <div className="flex flex-col items-center gap-2 py-2 text-center">
                <XCircle size={52} className="text-red-400" />
                <p className="text-lg font-bold text-red-300">
                  {record?.notSubmitted ? '本次未向收钱吧发起收款' : record?.resolution ? '已核对未扣款，本次收款已结束' : stateLabel}
                </p>
              </div>
            )}
            {phase === 'polling' && (
              <div className="space-y-3 text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border-2 border-coral/40 bg-coral/10">
                  <ScanLine size={26} className="animate-pulseGlow text-coral" />
                </div>
                <p className="font-semibold text-amber-300">{missingOrder ? '收钱吧暂未查到本单，正在复核' : stateLabel}</p>
                <p className="text-sm text-mist">
                  {missingOrder
                    ? '订单不存在不等于已确认未扣款，请先核对顾客账单。'
                    : `已等待 ${elapsed} 秒 · ${pollExpired ? '结果仍未明确，每 15 秒继续核实，勿重复收款。' : '请提醒顾客确认支付或输入密码，正在查询结果。'}`}
                </p>
              </div>
            )}
            {phase === 'scan' && (
              <form
                className="space-y-3"
                onSubmit={(event) => { event.preventDefault(); submitPaymentCode(inputRef.current?.value || ''); }}
              >
                <div className="rounded-xl border border-coral/40 bg-coral/10 px-4 py-2.5 text-center text-sm font-semibold text-coral-soft">
                  <ScanLine size={18} className="mr-2 inline animate-pulseGlow" />等待顾客付款码
                </div>
                <label className="block">
                  <span className="field-label">顾客付款码</span>
                  <input
                    ref={inputRef}
                    className="field text-center font-mono text-lg tracking-[0.2em]"
                    type="password"
                    autoComplete="off"
                    autoFocus
                    inputMode="numeric"
                    aria-label="顾客付款码"
                    value={code}
                    onChange={(event) => {
                      const next = event.currentTarget.value;
                      setCode(next);
                      // Scanners that do not send an Enter terminator land here.
                      // Scanner bursts arrive in chunks with unpredictable gaps,
                      // so triggering on "16+ digits" submits truncated codes;
                      // payment codes are exactly 18 digits, and only a complete
                      // 18-digit stream that has gone quiet auto-submits.
                      clearTimeout(autoSubmitTimer.current);
                      const normalized = next
                        .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
                        .replace(/[^0-9]/g, '');
                      if (/^\d{18}$/.test(normalized) && scanArmed.current && !working.current) {
                        autoSubmitTimer.current = setTimeout(() => {
                          if (scanArmed.current && !working.current && inputRef.current) submitPaymentCode(inputRef.current.value);
                        }, 350);
                      }
                    }}
                    onKeyDown={(event) => {
                      if ((event.key === 'Enter' || (event.key === 'Tab' && event.currentTarget.value && !event.shiftKey)) && !event.isComposing && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        submitPaymentCode(event.currentTarget.value);
                      }
                    }}
                    disabled={!ready || busy}
                  />
                </label>
                <div className="flex gap-2">
                  <button className="btn-ghost flex-1" type="button" onClick={cancelScanning} disabled={busy}><X size={16} /> 取消等待</button>
                  <button className="btn-primary flex-1" type="submit" disabled={busy || !/^\d{16,32}$/.test(code.trim())}><Check size={16} /> 提交付款码</button>
                </div>
              </form>
            )}
            {phase === 'idle' && (
              <form className="space-y-4" onSubmit={beginScanning}>
                {testMode && (
                  <ConfirmationCheck checked={confirmPayment} disabled={busy} onChange={(event) => setConfirmPayment(event.target.checked)}>
                    我确认本笔为测试收款，可能真实扣款
                  </ConfirmationCheck>
                )}
                <motion.button whileTap={{ scale: 0.98 }} className="btn-primary w-full !py-4 text-lg" disabled={!ready || busy || (testMode && !confirmPayment)}>
                  <Barcode size={20} /> 发起收款
                </motion.button>
              </form>
            )}
          </motion.div>
        </AnimatePresence>

        {testMode && phase !== 'paid' && (
          <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-2 text-center text-xs text-amber-300">
            测试商户 · 付款会真实扣款，不用于正式营业
          </p>
        )}

        {missingOrder && (
          <section className="space-y-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-4" aria-label="异常收款处理">
            {!recoveryReady && <p className="text-sm text-amber-200"><ShieldAlert size={15} className="mr-1 inline" />正在多次复核订单，请稍候。已扣款或无法确认时，请勿结束收款。</p>}
            <ConfirmationCheck checked={confirmNotCharged} disabled={busy || !recoveryReady} onChange={(event) => setConfirmNotCharged(event.target.checked)}>
              我已核对顾客账单，确认本笔未扣款
            </ConfirmationCheck>
            <button className="btn-danger w-full" disabled={busy || !recoveryReady || !confirmNotCharged} onClick={() => execute('resolve-missing-payment', { id: order.id, confirmNotCharged: true })}>
              <X size={16} /> 核实并结束本次收款
            </button>
          </section>
        )}
      </div>
    </Modal>
  );
}
