import React, { useEffect, useRef, useState } from 'react';
import { Barcode, Bell, Check, Download, KeyRound, RefreshCw, Save, ScanLine, ShieldCheck, Upload, X } from 'lucide-react';
import { ConfirmationCheck } from './ConfirmationCheck.jsx';
import { getOnlineSession, onlineHeaders } from './onlineApi.js';

export async function enablePaymentNotifications() {
  if (window.sqb) return '系统通知由电脑通知设置控制';
  if (!('Notification' in window) || !window.isSecureContext) return '当前浏览器不支持系统通知，收款结果仍会在页面显示';
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  return permission === 'granted' ? '已允许收款通知' : '通知未授权，请在浏览器网站设置中允许通知';
}

export async function notifyConfirmedPayment(id) {
  try {
    if (!window.sqb && (!('Notification' in window) || Notification.permission !== 'granted')) return false;
    const notice = await sqbCall('claim-payment-notification', { id });
    if (!notice) return true;
    if (notice.desktop) return notice.shown;
    const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (registration?.active) await registration.showNotification(notice.title, { body: notice.body, tag: notice.id, silent: false });
    else new Notification(notice.title, { body: notice.body, tag: notice.id, silent: false });
    return true;
  } catch { return false; }
}

export async function sqbCall(action, payload = {}) {
  let result;
  if (window.sqb) result = await window.sqb.call(action, payload);
  else {
    const response = await fetch(`/api/sqb/${action}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...onlineHeaders() }, body: JSON.stringify(payload), cache: 'no-store',
    });
    try { result = await response.json(); } catch { throw new Error('支付服务未启动，请使用新版桌面软件或本机支付服务'); }
    if (response.status === 401 && getOnlineSession()) window.dispatchEvent(new Event('online-session-expired'));
    if (!response.ok) throw Object.assign(new Error(result.error || '支付服务暂不可用'), { code: result.code, status: response.status });
  }
  if (!result.ok) throw Object.assign(new Error(result.error || '支付服务暂不可用'), { code: result.code });
  return result.data;
}

const labels = { appid: '轻 POS 应用编号 appid', brand_code: '品牌编号 brand_code', store_sn: '门店编号 store_sn', workstation_sn: '收银机编号 workstation_sn', operator: '收银员', gateway: '收钱吧 API 网关', notify_url: '公网支付通知地址（选填）' };

export function SqbSettings({ onClose }) {
  const [config, setConfig] = useState({ mode: 'test', workstation_sn: '0', operator: '收银员', gateway: 'https://vapi.shouqianba.com' });
  const [message, setMessage] = useState('正在读取配置');
  const [busy, setBusy] = useState(false);
  const [deviceCode, setDeviceCode] = useState('');
  const [deviceResult, setDeviceResult] = useState('');
  const [privateFile, setPrivateFile] = useState(null);
  const [password, setPassword] = useState('');
  const [passwordAgain, setPasswordAgain] = useState('');
  const [dirty, setDirty] = useState(false);
  const keyInput = useRef(null);
  const bundleInput = useRef(null);
  const update = (key, value) => { setConfig((current) => ({ ...current, [key]: value })); setDirty(true); };
  useEffect(() => { sqbCall('config').then((value) => { setConfig((current) => ({ ...current, ...value })); setMessage(value.ready ? '配置齐全，尚需实机支付验证' : '等待接口开通与参数配置'); }).catch((error) => setMessage(error.message)); }, []);
  async function run(action) {
    setBusy(true);
    try {
      let value;
      if (action === 'save-config' && privateFile) {
        if (config.merchantPublicKey && !window.confirm('将替换本机支付配置和签名私钥，原配置会自动备份。确认使用这套参数和密钥吗？')) return;
        if (privateFile.size > 16000) throw new Error('私钥文件过大，请选择 PKCS1 或 PKCS8 文本文件');
        value = await sqbCall('import-credentials', { config, privateKey: await privateFile.text(), confirmReplace: true });
        setPrivateFile(null);
      } else value = await sqbCall(action, config);
      if (action === 'generate-key') setConfig((current) => ({ ...current, merchantPublicKey: value.merchantPublicKey, keyFingerprint: value.keyFingerprint }));
      else { setConfig(value); setDirty(false); }
      setMessage(action === 'check-connection' ? value.connectionCheck?.message || '检测未完成' : action === 'generate-key' ? '商户公钥已生成，可下载交给收钱吧技术支持' : '配置已保存，请运行联网检测（不扣款）');
    }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }
  function downloadJson(value, name) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url);
  }
  async function transfer(file) {
    if (password.length < 12 || password.length > 200) { setMessage('请输入 12 至 200 个字符的配置包密码'); return; }
    setBusy(true);
    try {
      if (file) {
        if (file.size > 64000) throw new Error('配置包过大');
        if (!window.confirm('将导入此配置包中的收钱吧账号及密钥，原配置会自动备份。确认继续吗？')) return;
        const value = await sqbCall('import-credentials', { bundle: JSON.parse(await file.text()), password, confirmReplace: true });
        setConfig(value); setPrivateFile(null); setDirty(false);
        setMessage('加密配置包已导入，请运行联网检测');
      } else {
        if (password !== passwordAgain) throw new Error('两次密码不一致');
        downloadJson(await sqbCall('export-credentials', { password }), '收钱吧加密配置.sqb.json');
        setMessage('加密配置包已导出，密码请另行保管');
      }
      setPassword(''); setPasswordAgain('');
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }
  async function exportDiagnostics() {
    setBusy(true);
    try { downloadJson(await sqbCall('diagnostics'), '收钱吧诊断记录.json'); setMessage('已导出诊断记录，不含密钥和顾客付款码'); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }
  function downloadKey() {
    const url = URL.createObjectURL(new Blob([config.merchantPublicKey], { type: 'text/plain' }));
    const link = document.createElement('a'); link.href = url; link.download = 'sqb-merchant-public.pem'; link.click(); URL.revokeObjectURL(url);
  }
  return <div className="modalBackdrop"><div className="modal sqbSettings" role="dialog" aria-modal="true" aria-label="收钱吧设置">
    <div className="modalHead"><h2>收钱吧设置</h2><button className="iconButton" aria-label="关闭收钱吧设置" disabled={busy} onClick={onClose}><X size={20} /></button></div>
    <div className="modalScroll">
      <p className={config.mode === 'production' ? 'sqbStatus' : 'sqbWarning'}>{config.mode === 'production' ? '正式商户参数' : '测试商户参数 · 非模拟环境 · 付款会真实扣款'}</p>
      <form id="sqb-config" className="sqbConfigForm" onSubmit={(event) => { event.preventDefault(); run('save-config'); }}>
        <label className="fullField">参数用途<select value={config.mode || 'test'} disabled={busy} onChange={(event) => update('mode', event.target.value)}><option value="test">测试商户（真实扣款）</option><option value="production">正式商户</option></select></label>
        {Object.entries(labels).map(([key, label]) => <label key={key}>{label}<input disabled={busy} required={key !== 'notify_url'} value={config[key] || ''} onChange={(event) => update(key, event.target.value)} /></label>)}
        <label className="fullField">收钱吧验签公钥（PEM / Base64）<textarea rows="4" disabled={busy} required value={config.platformPublicKey || ''} onChange={(event) => update('platformPublicKey', event.target.value)} /></label>
      </form>
      <div className="keyImport">
        <button className="utilityButton" disabled={busy} onClick={() => keyInput.current?.click()}><Upload size={18} /> 选择签名私钥文件</button>
        <span>{privateFile ? privateFile.name : config.keyFingerprint ? '已配置签名私钥' : '尚未配置签名私钥'}</span>
        {config.keyFingerprint && <small className="keyFingerprint">当前密钥指纹 {config.keyFingerprint.slice(0, 16)}</small>}
        <input className="hiddenInput" ref={keyInput} type="file" aria-label="签名私钥文件" accept=".txt,.pem,.key" onChange={(event) => { setPrivateFile(event.target.files?.[0] || null); setDirty(true); event.target.value = ''; }} />
      </div>
      <div className="cartActions keyActions"><button className="utilityButton" disabled={busy} onClick={() => run('generate-key')}><KeyRound size={18} /> {config.merchantPublicKey ? '查看商户公钥' : '生成商户公钥'}</button>
        <button className="utilityButton" disabled={!config.merchantPublicKey} onClick={downloadKey}><Download size={18} /> 下载商户公钥</button></div>
      <button className="utilityButton notificationPermission" onClick={() => enablePaymentNotifications().then(setMessage).catch(() => setMessage('通知设置失败，请检查系统权限'))}><Bell size={18} /> 收款通知权限</button>
      <section className="sqbSection" aria-label="连接检测">
        <h3>连接检测</h3>
        <div className="cartActions"><button className="utilityButton" disabled={busy || dirty || !config.ready} onClick={() => run('check-connection')}><ShieldCheck size={18} /> 联网检测（不扣款）</button>
          <button className="utilityButton" disabled={busy} onClick={exportDiagnostics}><Download size={18} /> 导出诊断记录</button></div>
        <p className="sqbStatus">{dirty ? '有未保存的配置' : config.connectionCheck ? `${config.connectionCheck.verified ? '已通过签名查单和验签' : '检测未通过'} · ${new Date(config.connectionCheck.checkedAt).toLocaleString('zh-CN')}` : '尚未联网检测'}</p>
        {config.connectionCheck?.terminalIp && <small>终端公网 IPv4：{config.connectionCheck.terminalIp}</small>}
      </section>
      <section className="sqbSection" aria-label="配置迁移">
        <h3>加密配置迁移</h3>
        <div className="sqbConfigForm"><label>配置包密码<input type="password" autoComplete="new-password" maxLength={200} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 12 个字符" /></label>
          <label>导出时再次输入密码<input type="password" autoComplete="new-password" maxLength={200} value={passwordAgain} onChange={(event) => setPasswordAgain(event.target.value)} /></label></div>
        <div className="cartActions"><button className="utilityButton" disabled={busy || dirty || !config.ready || password.length < 12 || password !== passwordAgain} onClick={() => transfer()}><Download size={18} /> 导出加密配置</button>
          <button className="utilityButton" disabled={busy || password.length < 12} onClick={() => bundleInput.current?.click()}><Upload size={18} /> 导入加密配置</button></div>
        <input className="hiddenInput" ref={bundleInput} type="file" aria-label="加密配置文件" accept=".json" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) transfer(file); }} />
      </section>
      <form className="deviceTest" onSubmit={(event) => { event.preventDefault(); setDeviceResult(deviceCode ? `已收到 ${deviceCode.length} 位扫码内容，未发起收款` : '尚未收到扫码内容'); setDeviceCode(''); }}>
        <label>USB 扫码检测<input type="password" autoComplete="off" value={deviceCode} onChange={(event) => setDeviceCode(event.target.value)} placeholder="在此扫描商品条码进行检测" /></label>
        <button className="utilityButton" type="submit"><Check size={18} /> 检测输入</button><span role="status">{deviceResult}</span>
      </form>
    </div>
    <div className="modalFooter"><p className="sqbStatus" role="status">{message}</p><button className="submitButton" form="sqb-config" disabled={busy}><Save size={18} /> 保存配置</button></div>
  </div></div>;
}

export function SqbPaymentModal({ order, pending, onBeforeStart, onRecord, onClose, onSettings }) {
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
  const scanArmed = useRef(false);
  const working = useRef(false);
  const recordHandler = useRef(onRecord);
  recordHandler.current = onRecord;
  const started = Boolean(pending?.started || record);
  const terminal = record?.state === 'paid' || record?.state === 'failed' || record?.state === 'not-started';
  useEffect(() => { sqbCall('config').then((value) => { setReady(value.ready); setTestMode(value.mode !== 'production'); if (!value.ready) setMessage('请先完成收钱吧接口配置'); }).catch((error) => setMessage(error.message)); }, []);
  async function execute(action, payload) {
    if (working.current) return;
    working.current = true; setBusy(true);
    try { const next = await sqbCall(action, payload); setRecord(next); setMessage(next.message || ''); await recordHandler.current(next); }
    catch (error) { setMessage(error.message); }
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
    if (!ready || busy || working.current || started || !confirmPayment) return;
    scanArmed.current = true;
    setCode(''); setMessage(''); setWaitingForCode(true);
    enablePaymentNotifications().catch(() => {}).finally(() => {
      if (scanArmed.current) inputRef.current?.focus();
    });
  }
  function cancelScanning() {
    scanArmed.current = false;
    setWaitingForCode(false); setConfirmPayment(false); setCode(''); setMessage('');
  }
  async function submitPaymentCode(value) {
    if (!scanArmed.current || started || working.current || !ready || !confirmPayment) return;
    const paymentCode = value.trim();
    if (!/^\d{16,32}$/.test(paymentCode)) {
      setMessage('付款码不完整或不是顾客付款码，请重新扫描');
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
  useEffect(() => {
    if (!started || terminal) return;
    let stopped = false;
    let timer;
    async function poll() {
      if (stopped) return;
      if (Date.now() - pollStartedAt.current >= 60000) setPollExpired(true);
      await execute('query', { id: order.id });
      if (!stopped) timer = setTimeout(poll, Date.now() - pollStartedAt.current >= 60000 ? 15000 : 3000);
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
  const stateLabel = { pending: '等待顾客付款 / 正在核实', review: '结果待核实，请联系收钱吧，勿重复收款', paid: '收钱吧已确认收款', failed: '收钱吧已确认本次未支付成功', 'not-started': '本次未向收钱吧发起收款' }[record?.state] || (started ? '正在确认支付结果' : waitingForCode ? '等待顾客付款码' : '待确认本笔收款');
  const missingOrder = record?.state === 'pending' && record?.missingOrder && !record.orderSn && !record.remoteOrderSeenAt && !record.tenders?.length;
  const recoveryReady = missingOrder && record.missingOrder.count >= 2
    && Date.parse(record.missingOrder.lastCheckedAt) - Date.parse(record.missingOrder.firstCheckedAt) >= 60000
    && Date.now() - Date.parse(record.createdAt) >= 120000;
  return <div className="modalBackdrop"><div className="modal sqbPayment" role="dialog" aria-modal="true" aria-label="收钱吧收款">
    <div className="modalHead"><h2>收钱吧收款</h2><button className="iconButton" aria-label="关闭收钱吧收款" title={record?.state === 'paid' ? '关闭弹窗，保留待核对记录' : '关闭收钱吧收款'} disabled={busy || (started && !terminal)} onClick={closePayment}><X size={20} /></button></div>
    <div className="payAmount"><span>本单应收</span><strong>{Number(order.total).toFixed(2)} 元</strong><small>{order.orderNo}</small></div>
    <p className={`sqbStatus${waitingForCode && !started ? ' sqbScanReady' : ''}`} role="status">{waitingForCode && !started && <ScanLine size={24} aria-hidden="true" />}{record?.notSubmitted ? '本次未向收钱吧发起收款' : record?.resolution && record.state === 'failed' ? '已核对未扣款，本次收款已结束' : missingOrder ? '收钱吧暂未查到本单，正在复核' : stateLabel}</p>
    {testMode && <p className="sqbWarning">测试商户 · 付款会真实扣款，不用于正式营业</p>}
    {started && !terminal && <p className="sqbStatus">{missingOrder ? '订单不存在不等于已确认未扣款，请先核对顾客账单。' : `已等待 ${elapsed} 秒 · ${pollExpired ? '结果仍未明确，每 15 秒继续核实，勿重复收款。' : '请提醒顾客确认支付或输入密码，正在查询结果。'}`}</p>}
    {!started && !waitingForCode && <form onSubmit={beginScanning}>
      <ConfirmationCheck checked={confirmPayment} disabled={busy} onChange={(event) => setConfirmPayment(event.target.checked)}>{testMode ? '我确认本笔为测试收款，可能真实扣款' : '我确认本笔金额，将向顾客真实收款'}</ConfirmationCheck>
      <button className="submitButton" disabled={!ready || busy || !confirmPayment}><Barcode size={18} /> 发起收款</button>
    </form>}
    {!started && waitingForCode && <form onSubmit={(event) => { event.preventDefault(); submitPaymentCode(inputRef.current?.value || ''); }}>
      <label>顾客付款码<input ref={inputRef} className="sqbCodeInput" type="password" autoComplete="off" autoFocus inputMode="numeric" aria-label="顾客付款码" value={code} onChange={(event) => setCode(event.target.value)} onKeyDown={(event) => {
        if ((event.key === 'Enter' || (event.key === 'Tab' && event.currentTarget.value && !event.shiftKey)) && !event.isComposing && !event.nativeEvent.isComposing) {
          event.preventDefault(); submitPaymentCode(event.currentTarget.value);
        }
      }} disabled={!ready || busy} /></label>
      <div className="sqbScanActions">
        <button className="utilityButton" type="button" onClick={cancelScanning} disabled={busy}><X size={18} /> 取消等待</button>
        <button className="utilityButton" type="submit" disabled={busy || !/^\d{16,32}$/.test(code.trim())}><Check size={18} /> 提交付款码</button>
      </div>
    </form>}
    {message && <p className="dangerText" role="alert">{message}</p>}
    {record?.state === 'paid' && <p className="sqbStatus">收款结果已保留。订单未核对保存前，收银保持暂停；关闭弹窗不会取消付款或清除记录。</p>}
    {!ready && !started && <button className="utilityButton" onClick={onSettings}>配置收钱吧</button>}
    {started && <button className="utilityButton" disabled={busy} onClick={() => execute('query', { id: order.id })}><RefreshCw size={18} /> {busy ? '正在查询' : record?.state === 'paid' ? '重试保存订单' : '重新查询支付结果'}</button>}
    {record?.state === 'paid' && <button className="utilityButton" disabled={busy} onClick={closePayment}><X size={18} /> 关闭弹窗，保留待核对</button>}
    {missingOrder && <section className="sqbSection" aria-label="异常收款处理">
      {!recoveryReady && <p className="sqbStatus">正在多次复核订单，请稍候。已扣款或无法确认时，请勿结束收款。</p>}
      <ConfirmationCheck checked={confirmNotCharged} disabled={busy || !recoveryReady} onChange={(event) => setConfirmNotCharged(event.target.checked)}>我已核对顾客账单，确认本笔未扣款</ConfirmationCheck>
      <button className="submitButton" disabled={busy || !recoveryReady || !confirmNotCharged} onClick={() => execute('resolve-missing-payment', { id: order.id, confirmNotCharged: true })}><X size={18} /> 核实并结束本次收款</button>
    </section>}
    {['failed', 'not-started'].includes(record?.state) && <button className="submitButton" disabled={busy} onClick={closePayment}>返回购物车</button>}
  </div></div>;
}
