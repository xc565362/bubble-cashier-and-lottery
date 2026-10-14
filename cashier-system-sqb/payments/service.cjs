const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { paymentNotice } = require('./receipt.cjs');
const { normalizePrivateKey, publicFingerprint, sealCredentials, openCredentials } = require('./credentials.cjs');
const { createPublicIpResolver, isPublicIPv4 } = require('./network.cjs');
const { signedEnvelope, verifyEnvelope, validateConfig, purchaseBody, resultState, requestApi, refundBody, refundResultState, validateIdentity } = require('./litepos.cjs');
const { buildPlan, allocateRefund, successful } = require('./adjustments.cjs');
const { safeMessage } = require('./diagnostics.cjs');
const { createBackup, verifyBackup } = require('./backup.cjs');
const { createCouponBridge } = require('../coupons/bridge.cjs');
const { createLotteryBridge } = require('./lottery.cjs');
const { createScarfBridge } = require('./scarf.cjs');
const { canResolveMissingPayment } = require('./recovery.cjs');

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, value, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('支付记录文件损坏，请保留文件并联系维护人员，勿重新收款'); }
}

function lockDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'service.lock');
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(file, 'utf8'));
    let running = true;
    try { if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, 0); }
    catch (issue) { if (issue.code === 'ESRCH') running = false; }
    if (running) throw new Error('另一支付服务正在使用此配置目录，请关闭它后再启动');
    fs.unlinkSync(file);
    return lockDirectory(directory);
  }
  const release = () => {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file);
    process.removeListener('exit', release);
  };
  process.once('exit', release);
  return release;
}

function createService({ directory, protect = (value) => value, unprotect = (value) => value, fetchFn = fetch, resolveTerminalIp = createPublicIpResolver(fetchFn), exclusive = false }) {
  const releaseDirectory = exclusive ? lockDirectory(directory) : null;
  const configFile = path.join(directory, 'config.json');
  const keyFile = path.join(directory, 'merchant-key.json');
  const journalFile = path.join(directory, 'payments.json');
  const credentialFile = path.join(directory, 'credentials.json');
  const diagnosticFile = path.join(directory, 'connection-check.json');
  const auditFile = path.join(directory, 'audit.json');
  const restoreFile = path.join(directory, 'restore-stage.json');
  let credentials = readJson(credentialFile, null);
  let config = credentials?.config || readJson(configFile, {});
  let records = readJson(journalFile, {});
  const coupons = createCouponBridge({ directory, protect, unprotect, fetchFn, getPayment: id => records[id] });
  const lottery = createLotteryBridge({ directory, protect, unprotect, fetchFn });
  const scarf = createScarfBridge({ directory, protect, unprotect, fetchFn });
  let restoreStage = readJson(restoreFile, null);
  const inFlight = new Map();
  let preparing = false;
  const activeKeys = () => credentials?.key || readJson(keyFile, {});
  const credentialId = () => crypto.createHash('sha256').update(JSON.stringify({ config, publicKey: activeKeys().publicKey })).digest('hex');
  function settings(input) {
    const next = {};
    for (const field of ['appid', 'brand_code', 'store_sn', 'workstation_sn', 'operator', 'gateway', 'notify_url', 'platformPublicKey', 'mode']) next[field] = String(input?.[field] || '').trim();
    return validateConfig(next);
  }
  function audit(action, record, extra = {}) {
    try {
      const previous = readJson(auditFile, []);
      const entry = { at: new Date().toISOString(), action, id: record?.id, orderNo: record?.identity?.check_sn, state: record?.state, amount: record?.amount, ...extra };
      atomicWrite(auditFile, JSON.stringify([...previous.slice(-999), entry]));
    } catch { /* Payment journal persistence remains authoritative when diagnostics cannot be written. */ }
  }
  function saveCredentials(next) {
    const old = credentials || { version: 1, config, key: activeKeys() };
    if (old.key.privateKey || Object.keys(old.config).length) {
      atomicWrite(path.join(directory, 'credential-backups', `${Date.now()}-${crypto.randomUUID()}.json`), JSON.stringify(old));
    }
    atomicWrite(credentialFile, JSON.stringify(next));
    credentials = next; config = next.config;
  }
  function publicConfig() {
    const keys = activeKeys();
    let ready = false;
    try { validateConfig(config); ready = Boolean(keys.privateKey); } catch {}
    const check = readJson(diagnosticFile, null);
    return { ...config, mode: config.mode || 'test', ready, merchantPublicKey: keys.publicKey || '', directory,
      keyFingerprint: keys.publicKey ? publicFingerprint(keys.publicKey) : '',
      connectionCheck: check?.credentialId === credentialId() ? check : null };
  }
  function privateKey() {
    const keys = activeKeys();
    if (!keys.privateKey) throw new Error('请先生成商户公钥并交收钱吧配置');
    return unprotect(keys.privateKey);
  }
  function saveRecord(record) {
    const next = { ...records, [record.id]: record };
    atomicWrite(journalFile, JSON.stringify(next));
    records = next;
    return record;
  }
  function applyResult(record, data) {
    const state = record.kind === 'refund' ? refundResultState(data, record) : resultState(data, record);
    const previous = records[record.id];
    if (successful(previous)) return previous;
    const now = new Date().toISOString();
    const reason = (data.tenders || []).map((item) => safeMessage(item.reason)).filter(Boolean).join('；');
    return saveRecord({ ...previous, state, missingOrder: null, remoteOrderSeenAt: now,
      ...(previous.resolution && state !== 'failed' ? { acknowledged: false } : {}),
      message: reason || (state === 'review' ? '部分资金结果需要核实，请勿重复发起，继续查单或联系收钱吧' : ''), updatedAt: now,
      ...(['paid', 'refunded'].includes(state) ? { completedAt: now } : {}),
      orderSn: data.order_sn || '',
      tenders: (data.tenders || []).map((entry) => ({
        tenderSn: entry.tender_sn || '', amount: Number(entry.amount), payStatus: Number(entry.pay_status),
        channel: entry.sub_tender_desc || '', tenderType: entry.tender_type, subTenderType: entry.sub_tender_type,
        internalTransactionSn: entry.internal_transaction_sn || '', channelSn: entry.channel_sn || '', transactionSn: entry.transaction_sn || '',
        originalTenderSn: entry.original_tender_sn || '',
        collectedAmount: entry.collected_amount == null ? null : Number(entry.collected_amount),
        paidAmount: entry.paid_amount == null ? null : Number(entry.paid_amount), payTime: entry.pay_time || '',
      })),
    });
  }
  async function perform(record, endpoint, body) {
    let submitted = false;
    try {
      const moving = endpoint.endsWith('/purchase') || endpoint.endsWith('/refund');
      const ip = await resolveTerminalIp({ fresh: moving });
      if (!isPublicIPv4(ip)) throw new Error('终端公网 IP 无效，未提交请求');
      const key = privateKey();
      submitted = true;
      const data = await requestApi(config, key, endpoint, body, fetchFn, ip, (event) => audit('protocol', record, event));
      let result;
      if (endpoint.endsWith('/refund')) {
        validateIdentity(data, record);
        if (data.request_id !== record.requestId) throw new Error('退款请求编号与本次提交不一致，请继续查单');
        // A refund POST only creates the order. Only query/callback can settle it.
        result = saveRecord({ ...records[record.id], orderSn: data.order_sn, message: '退款申请已提交，正在核实退款结果', updatedAt: new Date().toISOString() });
      } else result = applyResult(record, data);
      audit(endpoint.endsWith('/query') ? 'query-result' : 'submitted-result', result);
      await coupons.settle(result).catch(() => null);
      return result;
    } catch (error) {
      const previous = records[record.id];
      if (successful(previous)) return previous;
      const message = error.name === 'TimeoutError' || error.name === 'AbortError' || error instanceof TypeError
        ? '网络超时或断开，资金结果未确定，请继续查单，勿重复收退款' : safeMessage(error.message);
      const now = new Date().toISOString();
      const missing = endpoint.endsWith('/query') && error.verifiedResponse === true && error.gatewayCode === 'ACQ.ORDER_NOT_FOUND';
      const priorEvidence = previous.missingOrder?.credentialId === credentialId() ? previous.missingOrder : null;
      const missingOrder = missing ? { credentialId: credentialId(), queryId: crypto.randomUUID(),
        firstCheckedAt: priorEvidence?.firstCheckedAt || now, lastCheckedAt: now, count: (priorEvidence?.count || 0) + 1 } : null;
      const result = saveRecord({ ...previous, missingOrder, ...(!submitted && (endpoint.endsWith('/purchase') || endpoint.endsWith('/refund')) ? { state: 'failed', notSubmitted: true } : {}), message, updatedAt: now });
      audit('request-error', result, { code: error.gatewayCode || error.code || 'LOCAL_OR_NETWORK',
        ...(error.code === 'PUBLIC_IP_UNAVAILABLE' ? { ipChecks: error.ipChecks } : {}) });
      await coupons.settle(result).catch(() => null);
      return result;
    }
  }
  function serialized(id, work) {
    if (inFlight.has(id)) return inFlight.get(id);
    const running = work().finally(() => inFlight.delete(id));
    inFlight.set(id, running);
    return running;
  }
  function unresolved() { return Boolean(restoreStage) || preparing || Object.values(records).some((record) => !record.acknowledged && record.state !== 'failed'); }

  return {
    async dispatch(action, payload = {}) {
      if (action.startsWith('scarf-')) {
        if (!['scarf-config', 'scarf-snapshot', 'scarf-records'].includes(action) && (unresolved() || coupons.hasPending())) throw new Error('请先完成当前收退款和券占用，再修改头巾活动配置');
        return scarf.dispatch(action.slice(6), payload);
      }
      if (action.startsWith('lottery-')) {
        if (!['lottery-config', 'lottery-snapshot', 'lottery-records'].includes(action) && (unresolved() || coupons.hasPending())) throw new Error('请先完成当前收退款和券占用，再修改抽奖配置');
        return lottery.dispatch(action.slice(8), payload);
      }
      if (action.startsWith('coupon-')) {
        if (['coupon-connect', 'coupon-release', 'coupon-zero', 'coupon-reserve', 'coupon-bind-physical-products'].includes(action) && unresolved()) throw new Error('请先核对当前收退款，再操作优惠券');
        return coupons.dispatch(action.slice(7), payload);
      }
      if (action === 'config') return publicConfig();
      if (action === 'restore-status') return restoreStage ? { token: restoreStage.token } : null;
      if (action === 'export-backup') {
        if (coupons.hasPending()) throw new Error('还有占用或待同步的中奖券，请先完成结算或释放');
        if (unresolved()) throw new Error('请先完成收退款及恢复对账，再导出完整备份');
        if (!Object.values(records).some((item) => item.state !== 'failed') && !payload.business?.orders?.some((order) => order.payment?.provider === 'sqb')) return payload.business;
        return createBackup(payload.business, records, config, activeKeys().publicKey, privateKey());
      }
      if (action === 'prepare-restore') {
        if (coupons.hasPending()) throw new Error('还有占用或待同步的中奖券，不能覆盖数据');
        if (unresolved()) throw new Error('存在未处理交易或恢复任务，不能覆盖数据');
        let data;
        if (payload.bundle?.type === 'stall-cashier-signed-backup') data = verifyBackup(payload.bundle, records, config, activeKeys().publicKey);
        else {
          if (Object.values(records).some((item) => item.state !== 'failed') || payload.bundle?.orders?.some((order) => order.payment?.provider === 'sqb')) throw new Error('包含收钱吧交易时，必须使用新版完整签名备份；旧版文件不能覆盖支付账');
          const { validateBusiness } = require('./backup.cjs');
          data = { business: { ...payload.bundle, heldCarts: payload.bundle?.heldCarts || [] }, records };
          validateBusiness(data.business, records);
        }
        const stage = { ...data, token: crypto.randomUUID() };
        atomicWrite(restoreFile, JSON.stringify(stage)); restoreStage = stage;
        audit('restore-prepared', null);
        return { token: stage.token, business: stage.business };
      }
      if (action === 'commit-restore' || action === 'abort-restore') {
        if (!restoreStage) return { ok: true };
        if (payload.token !== restoreStage.token) throw new Error('恢复任务编号不匹配');
        if (action === 'commit-restore') {
          atomicWrite(journalFile, JSON.stringify(restoreStage.records)); records = restoreStage.records;
        }
        atomicWrite(restoreFile, 'null'); restoreStage = null;
        audit(action, null);
        return { ok: true };
      }
      if (action === 'import-credentials') {
        if (unresolved()) throw new Error('还有未完成的支付对账，不能替换配置或密钥');
        if (activeKeys().privateKey && payload.confirmReplace !== true) throw new Error('请确认替换当前支付配置，原配置会在本机备份');
        const input = payload.bundle ? openCredentials(payload.bundle, payload.password) : payload;
        const nextConfig = settings(input.config);
        const pair = normalizePrivateKey(input.privateKey);
        saveCredentials({ version: 1, config: nextConfig, key: { publicKey: pair.publicKey, privateKey: protect(pair.privateKey) }, importedAt: new Date().toISOString() });
        audit('credentials-imported', null);
        return publicConfig();
      }
      if (action === 'export-credentials') {
        if (unresolved()) throw new Error('请先完成支付对账再导出配置');
        const valid = validateConfig(config);
        const bundle = sealCredentials({ config: valid, privateKey: privateKey() }, payload.password);
        audit('credentials-exported', null);
        return bundle;
      }
      if (action === 'check-connection') {
        if (unresolved()) throw new Error('请先处理未完成支付，再运行配置检测');
        const valid = validateConfig(config);
        const pair = normalizePrivateKey(privateKey());
        const checkedId = credentialId();
        const checkSn = `CHK${Date.now()}${crypto.randomBytes(6).toString('hex')}`;
        let verified = false;
        let code = '';
        let ip = '';
        let message = '';
        try {
          ip = await resolveTerminalIp({ fresh: true });
          if (!isPublicIPv4(ip)) throw new Error('未检测到有效的终端公网 IP');
          await requestApi(valid, pair.privateKey, '/api/lite-pos/v1/sales/query', { brand_code: valid.brand_code, store_sn: valid.store_sn, workstation_sn: valid.workstation_sn, check_sn: checkSn }, fetchFn, ip);
          message = '检测订单号意外存在，请重新检测；未发起收款';
        } catch (error) {
          verified = error.verifiedResponse === true && error.gatewayCode === 'ACQ.ORDER_NOT_FOUND';
          code = error.gatewayCode || '';
          message = verified ? '签名查单及响应验签通过，未发起收款；支付权限仍需实测' : error.message;
        }
        const check = { credentialId: checkedId, checkedAt: new Date().toISOString(), verified, code, terminalIp: ip, checkSn, message };
        atomicWrite(diagnosticFile, JSON.stringify(check));
        audit('connection-check', null, { verified, code });
        return publicConfig();
      }
      if (action === 'diagnostics') {
        return { connectionCheck: publicConfig().connectionCheck, events: readJson(auditFile, []).slice(-100),
          transactions: Object.values(records).slice(-30).map((record) => ({ id: record.id, orderNo: record.identity.check_sn, amount: record.amount, state: record.state, orderSn: record.orderSn || '', acknowledged: record.acknowledged, updatedAt: record.updatedAt })) };
      }
      if (action === 'generate-key') {
        if (!activeKeys().privateKey) {
          const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
          atomicWrite(keyFile, JSON.stringify({ publicKey: pair.publicKey, privateKey: protect(pair.privateKey) }));
        }
        return publicConfig();
      }
      if (action === 'save-config') {
        if (unresolved()) throw new Error('还有未完成的支付对账，请先处理后再修改配置');
        const validated = settings(payload);
        if (credentials) saveCredentials({ ...credentials, config: validated });
        else { atomicWrite(configFile, JSON.stringify(validated)); config = validated; }
        return publicConfig();
      }
      if (action === 'pending') return Object.values(records).filter((record) => !record.acknowledged);
      if (action === 'resolve-missing-payment') {
        if (payload.confirmNotCharged !== true) throw new Error('请先核对顾客账单，确认本笔未扣款');
        // Wait for any active query, then take the same lock for a fresh query and resolution.
        if (inFlight.has(payload.id)) await inFlight.get(payload.id);
        return serialized(payload.id, async () => {
          const record = records[payload.id];
          if (record?.resolution && record.state === 'failed') return record;
          if (record?.state === 'paid') return record;
          if (!canResolveMissingPayment(record, credentialId())) throw new Error('暂不能结束：需要持续查单确认订单不存在，且从未查到支付流水。请继续查询或联系收钱吧');
          const previousQuery = record.missingOrder.queryId;
          await perform(record, '/api/lite-pos/v1/sales/query', { ...record.identity });
          const latest = records[record.id];
          if (latest.state === 'paid' || latest.state === 'failed') return latest;
          if (!canResolveMissingPayment(latest, credentialId()) || latest.missingOrder.queryId === previousQuery) {
            throw new Error('本次查单未确认订单不存在，不能结束收款。请继续核实，勿重复收款');
          }
          const now = new Date().toISOString();
          const result = saveRecord({ ...latest, state: 'failed', updatedAt: now,
            message: '已核对顾客未扣款，并再次查单确认订单不存在；本次收款已结束，异常记录已保留',
            resolution: { type: 'confirmed-unpaid-order-not-found', confirmedAt: now, operator: config.operator,
              firstCheckedAt: latest.missingOrder.firstCheckedAt, lastCheckedAt: latest.missingOrder.lastCheckedAt,
              queryCount: latest.missingOrder.count } });
          audit('missing-payment-resolved', result, { resolution: result.resolution });
          await coupons.settle(result).catch(() => null);
          return result;
        });
      }
      if (action === 'preview-adjustment') {
        if (unresolved()) throw new Error('请先处理未完成的收退款');
        const { plan, digest } = await buildPlan(records, config, payload.parentId, payload.request);
        return { plan, digest, mode: config.mode || 'test' };
      }
      if (action === 'start-adjustment') {
        if (records[payload.request?.id]) {
          const previous = records[payload.request.id];
          if (previous.parentId !== payload.parentId || previous.fingerprint !== payload.digest) throw new Error('该退换货编号已用于其他内容');
          return previous;
        }
        if (unresolved()) throw new Error('请先处理未完成的收退款');
        preparing = true;
        try {
          const { root, plan, digest } = await buildPlan(records, config, payload.parentId, payload.request);
          if (digest !== payload.digest) throw new Error('退换货内容已变化，请重新确认');
          if (payload.confirm !== true) throw new Error('请确认本笔退换货');
          if (root.mode === 'test' && payload.confirmTestPayment !== true) throw new Error('请确认当前为测试商户，仍可能发生真实资金变动');
          validateConfig(config); privateKey();
          const refund = plan.deltaCents < 0;
          const { allocations, funding } = allocateRefund(records, root.id, plan.refundCents);
          // External refunds must not silently become local stock returns.
          {
            const ip = await resolveTerminalIp({ fresh: true });
            if (!isPublicIPv4(ip)) throw new Error('终端公网 IP 无效，未发起退换货');
            for (const source of funding) {
              const data = await requestApi(config, privateKey(), '/api/lite-pos/v1/sales/refunds-query', { ...source.identity, order_sn: source.orderSn }, fetchFn, ip,
                (event) => audit('protocol', source, event));
              const refundOrders = data.refund_orders ?? [];
              if (!Array.isArray(refundOrders)) throw new Error('无法核实历史退款，未发起退换货');
              for (const entry of refundOrders) {
                const known = Object.values(records).find((item) => item.parentId === root.id && item.kind === 'refund' && item.state === 'refunded' && item.orderSn === entry.order_sn);
                if (!known || Number(entry.amount) !== -known.amount) throw new Error('发现本机未登记的退款，请联系维护人员核对资金和库存，不能再次退款或换货');
              }
            }
          }
          const now = new Date().toISOString();
          const identity = { ...root.identity, check_sn: `${refund ? 'R' : 'E'}${crypto.randomUUID().replaceAll('-', '').slice(0, 30)}` };
          const record = { id: plan.id, parentId: root.id, plan, fingerprint: digest, kind: refund ? 'refund' : plan.deltaCents > 0 ? 'exchange-charge' : 'exchange-zero',
            amount: Math.abs(plan.deltaCents), state: plan.deltaCents ? 'pending' : 'completed', acknowledged: false,
            identity, allocations, requestId: crypto.randomUUID(), salesSn: root.draft.orderNo, mode: root.mode, createdAt: now, updatedAt: now,
            ...(plan.deltaCents === 0 ? { completedAt: now } : {}) };
          const body = refund ? refundBody(config, record) : plan.deltaCents > 0 ? purchaseBody(config, { orderNo: identity.check_sn, total: record.amount / 100 }, String(payload.code || '').trim()) : null;
          saveRecord(record);
          audit('adjustment-prepared', record);
          if (!body) return record;
          return await serialized(record.id, () => perform(record, `/api/lite-pos/v1/sales/${refund ? 'refund' : 'purchase'}`, body));
        } finally { preparing = false; }
      }
      if (action === 'claim-payment-notification') {
        const record = records[payload.id];
        const notice = paymentNotice(record);
        if (record.notificationClaimedAt) return null;
        saveRecord({ ...record, notificationClaimedAt: new Date().toISOString() });
        return notice;
      }
      if (action === 'acknowledge') {
        const record = records[payload.id];
        if (!record || !['paid', 'refunded', 'completed', 'failed'].includes(record.state)) throw new Error('资金结果未确定，不能结束处理');
        await coupons.settle(record).catch(() => null);
        const latest = records[payload.id];
        if (latest.state !== record.state || latest.orderSn !== record.orderSn) throw new Error('资金状态已更新，请重新查询后再结束处理');
        saveRecord({ ...latest, acknowledged: true });
        return { ok: true };
      }
      if (action === 'start') {
        if (coupons.hasZeroPending()) throw new Error('请先完成中奖券零元结算的订单恢复');
        const { draft, code } = payload;
        if (!draft || !/^[a-zA-Z0-9-]{1,64}$/.test(draft.id)) throw new Error('无效订单');
        const { priceOrder } = await import('../src/orderLogic.js');
        coupons.validatePhysicalItems(draft.items);
        const priced = priceOrder(draft.items);
        if (priced.total !== Number(draft.total)) throw new Error('商品明细与收款金额不一致');
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ orderNo: draft.orderNo, total: priced.total, items: priced.items.map(({ id, qty, price, discount, productType, couponAmount, externalCoupon, minimumCents, lineKey }) => ({ id, qty, price, discount, ...(productType === 'coupon' ? { productType, couponAmount, ...(externalCoupon ? { externalCoupon, minimumCents } : {}) } : externalCoupon?.kind === 'physical' ? {productType,lineKey,externalCoupon} : {}) })) })).digest('hex');
        if (priced.items.every((item) => item.productType === 'coupon')) throw new Error('优惠券不能单独结账');
        if (records[draft.id]) {
          if (records[draft.id].fingerprint !== fingerprint) throw new Error('该订单已发起支付，不能修改金额或商品');
          return records[draft.id];
        }
        if (unresolved()) throw new Error('还有未处理的收钱吧交易，请先查单');
        if ((config.mode || 'test') === 'test' && payload.confirmTestPayment !== true) throw new Error('当前为测试商户参数，请先确认本笔测试可能真实扣款');
        validateConfig(config);
        privateKey();
        const body = purchaseBody(config, draft, String(code || '').trim());
        const snapshot = { ...draft, ...priced, method: '收钱吧', items: priced.items.map(({ imageUrl, ...item }) => item) };
        if (priced.items.some(item => item.externalCoupon)) {
          preparing = true;
          try { await coupons.prepareDraft(snapshot, config.mode || 'test'); }
          finally { preparing = false; }
        }
        const record = {
          id: draft.id, draft: snapshot, fingerprint, amount: Number(body.amount), state: 'pending', acknowledged: false,
          identity: { brand_code: body.brand_code, store_sn: body.store_sn, workstation_sn: body.workstation_sn, check_sn: body.check_sn },
          mode: config.mode || 'test',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), message: '',
        };
        // Persist before sending money-moving traffic. The customer's code is never saved.
        saveRecord(record);
        audit('purchase-prepared', record);
        return serialized(record.id, () => perform(record, '/api/lite-pos/v1/sales/purchase', body));
      }
      if (action === 'query') {
        const record = records[payload.id];
        if (!record) return { state: preparing ? 'pending' : 'not-started', id: payload.id };
        if (successful(record) || record.state === 'failed') { await coupons.settle(record).catch(() => null); return record; }
        return serialized(record.id, () => perform(record, '/api/lite-pos/v1/sales/query', { ...record.identity, ...(record.orderSn ? { order_sn: record.orderSn } : {}) }));
      }
      throw new Error('不支持的支付操作');
    },
    async notification(raw) {
      validateConfig(config);
      const body = verifyEnvelope(raw, 'request', config.platformPublicKey, config.appid);
      const record = Object.values(records).find((entry) => entry.identity.check_sn === body.check_sn);
      if (!record) throw new Error('通知对应的订单不存在');
      const result = applyResult(record, body);
      await coupons.settle(result).catch(() => null);
      return signedEnvelope('response', { head: { version: '1.0.0', sign_type: 'SHA256', appid: config.appid, response_time: new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00') }, body: { result_code: '200', biz_response: { result_code: '200' } } }, privateKey());
    },
    // Server-internal recovery access. Never expose journal/staged backups as a dispatch action.
    readOnlineState: () => structuredClone({ records: Object.values(records), restoreStage, couponRecords: coupons.readOnlineState() }),
    close: () => { coupons.close(); releaseDirectory?.(); },
  };
}

module.exports = { createService, atomicWrite };
