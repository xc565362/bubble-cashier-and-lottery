const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {safePrizeId, physicalSnapshot} = require('./catalog-contract.cjs');

function problem(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function text(value, name, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw problem('INVALID_INPUT', `${name}不能为空且不能超过 ${max} 个字符`);
  return value.trim();
}
function integer(value, name, min = 0, max = 100000000) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw problem('INVALID_INPUT', `${name}不正确`);
  return value;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const uid = () => crypto.randomUUID();

function createCouponStore({ file, now = () => Date.now(), environment = 'development' }) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file, { timeout: 5000 });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS meta (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS coupons (id TEXT PRIMARY KEY, campaign TEXT NOT NULL, owner TEXT NOT NULL, issuer TEXT NOT NULL, award TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(issuer,award));
    CREATE INDEX IF NOT EXISTS coupons_owner ON coupons(issuer,owner);
    CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operations (scope TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope,id));
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL);
  `);
  db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('identity', JSON.stringify({ id: uid(), secret: crypto.randomBytes(32).toString('hex'), environment }));
  const identity = JSON.parse(db.prepare('SELECT data FROM meta WHERE id=?').get('identity').data);
  if (identity.environment !== environment) throw problem('ENVIRONMENT_MISMATCH', '测试券数据库不能切换为正式环境');
  const get = (table, id) => { const row = db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id); return row ? JSON.parse(row.data) : null; };
  const put = (table, entry) => db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(entry), entry.id);
  const timestamp = () => new Date(now()).toISOString();
  const sign = id => crypto.createHmac('sha256', identity.secret).update(id).digest('base64url');
  const legacyCode = id => `LJC1_${id.replaceAll('-', '')}_${sign(id).slice(0, 24)}`;
  // Bearer tokens live outside public coupon JSON. Only authorized issue/detail
  // paths call this inside BEGIN IMMEDIATE, including lazy historical migration.
  function code(id) {
    const old = db.prepare('SELECT token FROM coupon_tokens WHERE coupon_id=?').get(id);
    if (old) return old.token;
    const token = `LJC1_${crypto.randomBytes(16).toString('hex').toUpperCase()}`;
    db.prepare('INSERT INTO coupon_tokens(coupon_id,token) VALUES (?,?)').run(id, token);
    return token;
  }
  const deadline = coupon => {
    const cutoff = get('campaigns', coupon.campaignId)?.redemptionEndsAt;
    return cutoff && cutoff < coupon.expiresAt ? cutoff : coupon.expiresAt;
  };
  const view = (coupon, showCode = false) => ({ ...coupon, redemptionEndsAt: deadline(coupon), ...(showCode && coupon.state === 'AVAILABLE' ? { code: code(coupon.id) } : {}) });
  const issuerFor = actor => actor.role === 'lottery' ? `campaign:${actor.campaignId}` : actor.id;
  const event = (actor, action, target) => db.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run(uid(), timestamp(), actor.id, action, target);
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  // Constraints protect all connections, not only this process's request checks.
  // Existing conflicting history fails closed and is never silently rewritten.
  try {
    transaction(() => db.exec(`
      CREATE TABLE IF NOT EXISTS coupon_tokens (
        coupon_id TEXT PRIMARY KEY REFERENCES coupons(id), token TEXT NOT NULL UNIQUE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS coupons_checkout_unique
        ON coupons(json_extract(data,'$.reservation.checkoutId'))
        WHERE json_extract(data,'$.state') IN ('RESERVED','PAYMENT_PENDING','REDEEMED');
      CREATE UNIQUE INDEX IF NOT EXISTS coupons_order_unique
        ON coupons(json_extract(data,'$.reservation.orderId'))
        WHERE json_extract(data,'$.state') IN ('PAYMENT_PENDING','REDEEMED');
      CREATE UNIQUE INDEX IF NOT EXISTS coupons_payment_unique
        ON coupons(json_extract(data,'$.paymentReference'))
        WHERE json_extract(data,'$.state')='REDEEMED';
      CREATE UNIQUE INDEX IF NOT EXISTS campaigns_lottery_prize_unique
        ON campaigns(json_extract(data,'$.lotteryCatalog.campaignId'),json_extract(data,'$.lotteryCatalog.prizeId'))
        WHERE json_extract(data,'$.lotteryCatalog.campaignId') IS NOT NULL;
    `));
  } catch (error) { db.close(); throw error; }
  function ensureUnclaimed(field, value, id, errorCode, message) {
    const collision = db.prepare(`SELECT id FROM coupons WHERE id<>? AND
      json_extract(data,'$.state') IN ('RESERVED','PAYMENT_PENDING','REDEEMED') AND
      json_extract(data,?)=? LIMIT 1`).get(id, `$.${field}`, value);
    if (collision) throw problem(errorCode, message, 409);
  }
  function expire() {
    const time = timestamp();
    db.prepare(`UPDATE coupons SET data=json_set(data,'$.state','AVAILABLE','$.reservation',NULL)
      WHERE json_extract(data,'$.state')='RESERVED' AND json_extract(data,'$.reservation.expiresAt')<=?`).run(time);
    db.prepare(`UPDATE coupons SET data=json_set(data,'$.state','EXPIRED')
      WHERE json_extract(data,'$.state')='AVAILABLE' AND (json_extract(data,'$.expiresAt')<=? OR
        EXISTS (SELECT 1 FROM campaigns WHERE campaigns.id=coupons.campaign AND json_extract(campaigns.data,'$.redemptionEndsAt')<=?))`).run(time, time);
  }
  function requireRole(actor, roles) {
    if (!actor || !roles.includes(actor.role)) throw problem('FORBIDDEN', '接口权限不足', 403);
  }
  function campaignFor(actor, id) {
    const c = get('campaigns', id);
    if (!c) throw problem('NOT_FOUND', '券活动不存在', 404);
    if (actor.role === 'lottery' && actor.campaignId !== id) throw problem('FORBIDDEN', '此密钥不能访问该券活动', 403);
    return c;
  }
  function buildCampaign(input) {
    const kind=input.kind??'cash';
    if(!['cash','physical'].includes(kind))throw problem('INVALID_INPUT','奖品类型不正确');
    if(input.redemptionEnabled!==undefined&&(kind!=='physical'||typeof input.redemptionEnabled!=='boolean'))throw problem('INVALID_INPUT','实物领取开关不正确');
    let physical;
    if(kind==='physical') {
      physical=physicalSnapshot(input.physical);
      if(input.amountCents!==0||input.minimumCents!==0)throw problem('INVALID_INPUT','实物奖品的金额及门槛必须为零');
    } else if(input.physical!=null)throw problem('INVALID_INPUT','抵扣券不能包含实物奖品');
    if (![input.startsAt,input.expiresAt].every(value=>typeof value==='string'&&Number.isFinite(Date.parse(value))))throw problem('INVALID_TIME','请输入有效的活动时间');
    const startsAt=new Date(input.startsAt).toISOString(),expiresAt=new Date(input.expiresAt).toISOString();
    if(startsAt>=expiresAt||expiresAt<=timestamp())throw problem('INVALID_TIME','活动结束时间须晚于开始时间和当前时间');
    let redemptionEndsAt;
    if(input.redemptionEndsAt!=null) {
      if(typeof input.redemptionEndsAt!=='string'||!Number.isFinite(Date.parse(input.redemptionEndsAt)))throw problem('INVALID_TIME','兑奖截止时间不正确');
      redemptionEndsAt=new Date(input.redemptionEndsAt).toISOString();
      if(redemptionEndsAt<=startsAt||redemptionEndsAt>expiresAt||redemptionEndsAt<=timestamp())throw problem('INVALID_TIME','兑奖截止须晚于开始和当前时间且不晚于原有效期');
    }
    return {id:uid(),name:text(input.name,'券名称',60),kind,...(physical?{physical}:{}),amountCents:integer(input.amountCents,'券面额',physical?0:1,1000000),minimumCents:integer(input.minimumCents,'消费门槛'),
      quota:integer(input.quota,'发放上限',1,1000000),issued:0,startsAt,expiresAt,...(redemptionEndsAt?{redemptionEndsAt}:{}),enabled:true,...(physical?{redemptionEnabled:input.redemptionEnabled??true}:{}),createdAt:timestamp(),environment:identity.environment};
  }
  function eligible(coupon, amount) {
    const physical=coupon.kind==='physical';
    if (physical && get('campaigns',coupon.campaignId)?.redemptionEnabled === false) throw problem('REDEMPTION_PAUSED','实物领取正在准备，请稍后再试');
    integer(amount, '商品应收金额', physical ? 0 : 1);
    if (amount < coupon.minimumCents) throw problem('MINIMUM_NOT_MET', '未达到优惠券使用门槛');
    if (coupon.startsAt > timestamp() || deadline(coupon) <= timestamp()) throw problem('EXPIRED', '该奖品已超过兑奖或抵扣截止时间');
    return physical ? 0 : Math.min(coupon.amountCents, amount);
  }
  function reservationFor(actor, id) {
    const row = db.prepare("SELECT data FROM coupons WHERE json_extract(data,'$.reservation.id')=?").get(id);
    if (!row) throw problem('RESERVATION_NOT_FOUND', '锁券记录不存在或已释放', 404);
    const c = JSON.parse(row.data);
    if (c.reservation.actorId !== actor.id) throw problem('FORBIDDEN', '不能操作其他收银终端的券', 403);
    return c;
  }
  function mutate(actor, action, input, fn) {
    const requestId = text(input.requestId, '请求编号');
    const hash = digest(input);
    const scope = `${actor.id}:${action}`;
    return transaction(() => {
      const old = db.prepare('SELECT hash,data FROM operations WHERE scope=? AND id=?').get(scope, requestId);
      if (old) {
        if (old.hash !== hash) throw problem('IDEMPOTENCY_CONFLICT', '请求编号已用于不同内容', 409);
        const cached = JSON.parse(old.data);
        if (action === 'issue') { expire(); return view(get('coupons', cached.id), true); }
        if (action === 'create-key') return { ...cached, token: `ck_${cached.id}_${sign(`key:${cached.id}`)}` };
        return cached;
      }
      expire();
      const result = fn();
      const { code: unusedCode, token: unusedToken, ...cached } = result;
      db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(scope, requestId, hash, JSON.stringify(cached));
      return result;
    });
  }
  function dispatch(actor, action, input = {}) {
    requireRole(actor, ['admin', 'lottery', 'cashier']);
    if (action === 'info') return { service: 'stall-coupon-center', version: 1, centerId: identity.id, environment: identity.environment, role: actor.role, capabilities:['physical-prize-v1','quota-increase-v1','redemption-deadline-v1','lottery-catalog-v1','lottery-record-status-v1'] };
    if (action === 'lottery-record-status') {
      requireRole(actor, ['admin']);
      const plain = value => value && typeof value === 'object' && !Array.isArray(value);
      const keys = (value, allowed) => plain(value) && Object.keys(value).every(k => allowed.includes(k));
      const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value);
      if (!keys(input, ['centerId','environment','refs']) || input.centerId !== identity.id || input.environment !== identity.environment) throw problem('CENTER_MISMATCH', '券中心身份不一致', 409);
      if (!Array.isArray(input.refs) || input.refs.length < 1 || input.refs.length > 50 || input.refs.some(ref => !keys(ref,['recordId','campaignId','owner','awardId','couponId']) || ![ref.recordId,ref.campaignId,ref.owner,ref.awardId].every(identifier) || ref.couponId != null && !identifier(ref.couponId)) || new Set(input.refs.map(r=>r.recordId)).size !== input.refs.length) throw problem('INVALID_INPUT','请提供1至50条不重复的完整中奖引用');
      // Unlike interactive coupon detail/list, this audit query never calls expire(), code(),
      // an issuance endpoint or a write transaction. Calculate the current state in memory.
      const checkedAt = now(), timestampAt = new Date(checkedAt).toISOString();
      db.exec('BEGIN');
      try {
        const items = input.refs.map(ref => {
          const row = ref.couponId ? db.prepare('SELECT data FROM coupons WHERE id=?').get(ref.couponId) : db.prepare('SELECT data FROM coupons WHERE campaign=? AND owner=? AND award=? AND issuer=?').get(ref.campaignId,ref.owner,ref.awardId,'campaign:'+ref.campaignId);
          if (!row) return {recordId:ref.recordId,result:'not_found'};
          const coupon = JSON.parse(row.data);
          if(coupon.campaignId!==ref.campaignId||coupon.owner!==ref.owner||coupon.awardId!==ref.awardId||coupon.issuer!=='campaign:'+ref.campaignId||coupon.environment!==identity.environment) return {recordId:ref.recordId,result:'mismatch'};
          let state=coupon.state;
          if(state==='RESERVED'&&coupon.reservation?.expiresAt<=timestampAt)state='AVAILABLE';
          if(state==='AVAILABLE'&&deadline(coupon)<=timestampAt)state='EXPIRED';
          if(!['AVAILABLE','RESERVED','PAYMENT_PENDING','REDEEMED','VOID','EXPIRED'].includes(state))return {recordId:ref.recordId,result:'mismatch'};
          const redeemedAt=coupon.redeemedAt?Date.parse(coupon.redeemedAt):null;
          if(state==='REDEEMED'&&(!Number.isSafeInteger(redeemedAt)||redeemedAt<=0))return {recordId:ref.recordId,result:'mismatch'};
          return {recordId:ref.recordId,result:'verified',couponId:coupon.id,state,redeemedAt:Number.isSafeInteger(redeemedAt)?redeemedAt:null};
        });
        db.exec('COMMIT');
        return {centerId:identity.id,environment:identity.environment,checkedAt,items};
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    if (action === 'lottery-issue' || action === 'lottery-coupon') {
      requireRole(actor,['admin']);
      const campaign=campaignFor(actor,text(input.campaignId,'券活动编号'));
      if(!campaign.lotteryCatalog)throw problem('INVALID_INPUT','此接口仅供动态抽奖目录中的券活动使用');
      const delegated={id:'lottery-admin:'+actor.id,role:'lottery',campaignId:campaign.id};
      // Delegate into the original transaction/idempotency checks with a campaign-scoped
      // issuer, so owner/campaign validation and existing coupon lifecycle remain intact.
      if(action==='lottery-coupon')return dispatch(delegated,'coupon',{id:input.id,owner:input.owner});
      if(input.trustedCode!=null)throw problem('INVALID_INPUT','请使用 code 字段传递已确认的实物中奖码');
      return dispatch(delegated,'issue',{requestId:input.requestId,campaignId:campaign.id,owner:input.owner,awardId:input.awardId,...(input.code!=null?{trustedCode:input.code}:{})});
    }
    if (['campaigns', 'coupons', 'keys', 'coupon', 'reservation', 'events'].includes(action)) {
      return transaction(() => {
        expire();
        if (action === 'campaigns') {
          requireRole(actor, ['admin', 'lottery']);
          return db.prepare('SELECT data FROM campaigns ORDER BY rowid DESC').all().map(row => JSON.parse(row.data)).filter(c => actor.role === 'admin' || c.id === actor.campaignId);
        }
        if (action === 'keys') {
          requireRole(actor, ['admin']);
          return db.prepare('SELECT data FROM api_keys ORDER BY rowid DESC').all().map(row => JSON.parse(row.data));
        }
        if (action === 'events') {
          requireRole(actor, ['admin']);
          return db.prepare('SELECT * FROM events ORDER BY rowid DESC LIMIT 100').all();
        }
        if (action === 'reservation') {
          requireRole(actor, ['cashier', 'admin']);
          return view(reservationFor(actor, text(input.id, '锁券编号')));
        }
        if (action === 'coupon') {
          const c = get('coupons', text(input.id, '券编号'));
          if (!c) throw problem('NOT_FOUND', '券不存在', 404);
          if (actor.role !== 'admin') {
            requireRole(actor, ['lottery']);
            if (c.issuer !== issuerFor(actor) || c.owner !== text(input.owner, '领取人标识') || c.campaignId !== actor.campaignId) throw problem('FORBIDDEN', '无权查看此券', 403);
          }
          return view(c, true);
        }
        requireRole(actor, ['admin', 'lottery']);
        const page = integer(input.page ?? 1, '页码', 1, 100000);
        const owner = actor.role === 'lottery' ? text(input.owner, '领取人标识') : String(input.owner || '');
        const params = [];
        const conditions = [];
        if (actor.role === 'lottery') { conditions.push('issuer=?'); params.push(issuerFor(actor)); }
        if (owner) { conditions.push('owner=?'); params.push(owner); }
        if (input.campaignId) { conditions.push('campaign=?'); params.push(String(input.campaignId)); }
        if (input.state) { conditions.push("json_extract(data,'$.state')=?"); params.push(String(input.state)); }
        const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
        const total = db.prepare(`SELECT count(*) AS count FROM coupons${where}`).get(...params).count;
        const items = db.prepare(`SELECT data FROM coupons${where} ORDER BY rowid DESC LIMIT 30 OFFSET ?`).all(...params, (page - 1) * 30).map(row => view(JSON.parse(row.data)));
        return { items, page, total, pageSize: 30 };
      });
    }
    return mutate(actor, action, input, () => {
      if(action==='lottery-provision') {
        requireRole(actor,['admin']);
        const campaignId=text(input.campaignId,'抽奖总活动编号',120),prize=input.prize;
        if(!prize||typeof prize!=='object'||Array.isArray(prize))throw problem('INVALID_INPUT','奖项信息不完整');
        const prizeId=safePrizeId(prize.id),kind=prize.kind;
        if(!['cash','physical'].includes(kind))throw problem('INVALID_INPUT','奖项类型不正确');
        let amountCents=0;
        if(kind==='cash') {
          if(typeof prize.amount!=='number'||!Number.isFinite(prize.amount)||Math.abs(prize.amount*100-Math.round(prize.amount*100))>0.000001)throw problem('INVALID_INPUT','购物券金额须为最多两位小数');
          amountCents=integer(Math.round(prize.amount*100),'购物券金额',1,1000000);
        } else if(prize.amount!=null&&prize.amount!==0)throw problem('INVALID_INPUT','实物奖项金额必须为零');
        const quota=Math.max(1,integer(input.quota,'发放上限',0,1000000));
        const c=buildCampaign({name:prize.name,kind,amountCents,minimumCents:prize.minimumCents??0,
          ...(kind==='physical'?{physical:{prizeId,quantity:1,product:prize.product}}:{}),quota,startsAt:input.startsAt,expiresAt:input.expiresAt,redemptionEndsAt:input.redemptionEndsAt});
        if(kind==='physical'&&!c.physical.product)throw problem('INVALID_INPUT','新目录中的实物奖项必须绑定商品编码');
        const entitlement={kind,amountCents:c.amountCents,minimumCents:c.minimumCents,startsAt:c.startsAt,expiresAt:c.expiresAt,redemptionEndsAt:c.redemptionEndsAt||c.expiresAt,
          ...(c.physical?{physical:{prizeId,quantity:1,sku:c.physical.product.sku,barcode:c.physical.product.barcode}}:{})};
        const fingerprint=digest(entitlement);
        const existing=db.prepare("SELECT data FROM campaigns WHERE json_extract(data,'$.lotteryCatalog.campaignId')=? AND json_extract(data,'$.lotteryCatalog.prizeId')=?").get(campaignId,prizeId);
        if(existing) {
          const previous=JSON.parse(existing.data);
          if(previous.lotteryCatalog.entitlementFingerprint!==fingerprint)throw problem('AWARD_CONFLICT','已有奖项的商品、类型、券额或期限不能换绑，请使用新的奖项编号',409);
          // Display edits belong to the lottery catalog. Existing center campaigns and
          // issued coupons stay immutable; quota expansion is its separately audited API.
          return {campaign:previous};
        }
        c.lotteryCatalog={campaignId,prizeId,entitlementFingerprint:fingerprint};
        db.prepare('INSERT INTO campaigns VALUES (?,?)').run(c.id,JSON.stringify(c));event(actor,action,c.id);
        return {campaign:c};
      }
      if (action === 'create-campaign') {
        requireRole(actor, ['admin']);
        const c=buildCampaign(input);
        db.prepare('INSERT INTO campaigns VALUES (?,?)').run(c.id, JSON.stringify(c)); event(actor, action, c.id); return c;
      }
      if (action === 'increase-quota') {
        requireRole(actor, ['admin']);
        const c = campaignFor(actor, input.id);
        const quota = integer(input.quota, '发放上限', 1, 1000000);
        const reason = text(input.reason, '调整原因', 200);
        if (quota < c.quota || quota < c.issued) throw problem('INVALID_INPUT', '券发放上限仅允许增加，不能减少已经承诺的奖品');
        const before = c.quota;
        c.quota = quota;
        c.lastQuotaAdjustment = { before, quota, reason, at: timestamp(), actor: actor.id, requestId: input.requestId };
        put('campaigns', c); event(actor, action, c.id); return c;
      }
      if (action === 'set-deadline') {
        requireRole(actor, ['admin']);
        if (!Array.isArray(input.campaignIds) || input.campaignIds.length < 1 || input.campaignIds.length > 30 ||
          new Set(input.campaignIds).size !== input.campaignIds.length || input.campaignIds.some(id => typeof id !== 'string' || !id)) throw problem('INVALID_INPUT', '请选择不重复的券活动');
        if (typeof input.redemptionEndsAt !== 'string' || !Number.isFinite(Date.parse(input.redemptionEndsAt))) throw problem('INVALID_TIME', '兑奖截止时间不正确');
        const cutoff = new Date(input.redemptionEndsAt).toISOString();
        const reason = text(input.reason, '调整原因', 200);
        const campaigns = input.campaignIds.map(id => campaignFor(actor, id));
        if (cutoff <= timestamp() || campaigns.some(c => cutoff <= c.startsAt || cutoff > (c.redemptionEndsAt || c.expiresAt))) throw problem('INVALID_TIME', '截止须晚于当前时间与开始时间，且不能延长原有效期');
        for (const c of campaigns) {
          c.lastDeadlineAdjustment = { before: c.redemptionEndsAt || c.expiresAt, redemptionEndsAt: cutoff, reason, at: timestamp(), actor: actor.id, requestId: input.requestId };
          c.redemptionEndsAt = cutoff;
          put('campaigns', c); event(actor, action, c.id);
        }
        return { campaigns };
      }
      if (action === 'set-campaign') {
        requireRole(actor, ['admin']); const c = campaignFor(actor, input.id);
        if (typeof input.enabled !== 'boolean') throw problem('INVALID_INPUT', '活动开关不正确');
        if(input.redemptionEnabled!==undefined){
          if(c.kind!=='physical'||typeof input.redemptionEnabled!=='boolean')throw problem('INVALID_INPUT','实物领取开关不正确');
          c.redemptionEnabled=input.redemptionEnabled;
        }
        c.enabled = input.enabled; put('campaigns', c); event(actor, action, c.id); return c;
      }
      if (action === 'create-key') {
        requireRole(actor, ['admin']);
        if (!['lottery', 'cashier'].includes(input.role)) throw problem('INVALID_ROLE', '仅能创建抽奖或收银凭证');
        if (input.role === 'lottery') campaignFor(actor, input.campaignId);
        const k = { id: uid(), name: text(input.name, '凭证名称', 60), role: input.role, campaignId: input.role === 'lottery' ? input.campaignId : null, enabled: true, createdAt: timestamp() };
        const token = `ck_${k.id}_${sign(`key:${k.id}`)}`;
        db.prepare('INSERT INTO api_keys VALUES (?,?,?)').run(k.id, digest(token), JSON.stringify(k)); event(actor, action, k.id);
        return { ...k, token };
      }
      if (action === 'revoke-key') {
        requireRole(actor, ['admin']); const k = get('api_keys', input.id);
        if (!k) throw problem('NOT_FOUND', '凭证不存在', 404);
        if (db.prepare("SELECT id FROM coupons WHERE json_extract(data,'$.state') IN ('RESERVED','PAYMENT_PENDING') AND json_extract(data,'$.reservation.actorId')=? LIMIT 1").get(k.id)) throw problem('BUSY', '此收银凭证还有占用中的券，请先核对', 409);
        k.enabled = false; put('api_keys', k); event(actor, action, k.id); return k;
      }
      if (action === 'issue') {
        requireRole(actor, ['admin', 'lottery']);
        const campaign = campaignFor(actor, text(input.campaignId, '活动编号'));
        if(campaign.lotteryCatalog&&actor.role==='admin')throw problem('FORBIDDEN','动态抽奖奖项须通过专用服务端发放接口核对活动与领取人',403);
        const owner = text(input.owner, '领取人标识'); const awardId = text(input.awardId, '中奖/发放记录编号');
        const physical=campaign.kind==='physical';
        if(physical&&!/^[0-9A-F]{16}$/.test(input.trustedCode||''))throw problem('INVALID_CODE','实物中奖条码不正确');
        if(!physical&&input.trustedCode!=null)throw problem('INVALID_CODE','金额券不接受外部指定条码');
        const previous = db.prepare('SELECT data FROM coupons WHERE issuer=? AND award=?').get(issuerFor(actor), awardId);
        if (previous) {
          const c = JSON.parse(previous.data);
          if (c.owner !== owner || c.campaignId !== campaign.id) throw problem('AWARD_CONFLICT', '中奖记录已绑定其他领取人或活动', 409);
          if(physical&&(c.kind!=='physical'||c.physical?.prizeId!==campaign.physical.prizeId||code(c.id)!==input.trustedCode))throw problem('AWARD_CONFLICT','原中奖记录的奖品或条码不一致',409);
          return view(c, true);
        }
        if (!campaign.enabled || (campaign.redemptionEndsAt || campaign.expiresAt) <= timestamp()) throw problem('INACTIVE', '券活动已暂停或结束');
        if (campaign.issued >= campaign.quota) throw problem('SOLD_OUT', '券发放数量已达到上限', 409);
        if(physical&&db.prepare('SELECT coupon_id FROM coupon_tokens WHERE token=?').get(input.trustedCode))throw problem('CODE_CONFLICT','该实物条码已绑定其他中奖记录',409);
        const c = { id: uid(), campaignId: campaign.id, name: campaign.name, kind:campaign.kind||'cash', ...(physical?{physical:structuredClone(campaign.physical)}:{}), amountCents: campaign.amountCents, minimumCents: campaign.minimumCents, startsAt: campaign.startsAt,
          expiresAt: campaign.expiresAt, owner, issuer: issuerFor(actor), awardId, state: 'AVAILABLE', issuedAt: timestamp(), environment: identity.environment, reservation: null };
        db.prepare('INSERT INTO coupons VALUES (?,?,?,?,?,?)').run(c.id, c.campaignId, owner, c.issuer, awardId, JSON.stringify(c));
        if(physical)db.prepare('INSERT INTO coupon_tokens(coupon_id,token) VALUES (?,?)').run(c.id,input.trustedCode);
        campaign.issued++; put('campaigns', campaign); event(actor, action, c.id); return view(c, true);
      }
      if (action === 'void') {
        requireRole(actor, ['admin']); const c = get('coupons', input.id);
        if (!c) throw problem('NOT_FOUND', '券不存在', 404);
        if (c.state !== 'AVAILABLE') throw problem('INVALID_STATE', '只能作废尚未占用的可用券', 409);
        c.state = 'VOID'; c.voidReason = text(input.reason, '作废原因', 200); put('coupons', c); event(actor, action, c.id); return view(c);
      }
      if (action === 'reserve') {
        requireRole(actor, ['admin', 'cashier']);
        const scanned = text(input.code, '券码', 200);
        let id;
        if (/^LJC1_[0-9A-F]{32}$/.test(scanned)||/^[0-9A-F]{16}$/.test(scanned)) {
          id = db.prepare('SELECT coupon_id FROM coupon_tokens WHERE token=?').get(scanned)?.coupon_id;
          if (!id) throw problem('INVALID_CODE', '券码无效');
        } else {
          const match = /^LJC1_([a-f0-9]{32})_([A-Za-z0-9_-]{24})$/.exec(scanned);
          if (!match) throw problem('INVALID_CODE', '不是有效的中奖券码');
          id = match[1].replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
          if (!crypto.timingSafeEqual(Buffer.from(scanned), Buffer.from(legacyCode(id)))) throw problem('INVALID_CODE', '券码无效');
        }
        const c = get('coupons', id);
        if (!c) throw problem('NOT_FOUND', '券不存在', 404);
        if(/^[0-9A-F]{16}$/.test(scanned)&&c.kind!=='physical')throw problem('INVALID_CODE','不是实物中奖条码');
        const checkoutId = text(input.checkoutId, '结算编号');
        if (c.state === 'RESERVED' && c.reservation.actorId === actor.id && c.reservation.checkoutId === checkoutId) return view(c);
        if (c.state !== 'AVAILABLE') throw problem('NOT_AVAILABLE', '券已使用、已过期或被其他订单占用', 409);
        ensureUnclaimed('reservation.checkoutId', checkoutId, c.id, 'CHECKOUT_CONFLICT', '此结算已关联其他优惠券');
        const discountCents = eligible(c, input.eligibleCents);
        c.state = 'RESERVED'; c.reservation = { id: uid(), actorId: actor.id, checkoutId, eligibleCents: input.eligibleCents, discountCents, expiresAt: new Date(now() + 15 * 60 * 1000).toISOString() };
        put('coupons', c); event(actor, action, c.id); return view(c);
      }
      if (['prepare', 'commit', 'release'].includes(action)) {
        requireRole(actor, ['admin', 'cashier']); const c = reservationFor(actor, text(input.id, '锁券编号')); const r = c.reservation;
        if (action === 'prepare') {
          if (c.state === 'PAYMENT_PENDING' && r.orderId === input.orderId && r.paidCents === input.paidCents && r.eligibleCents === input.eligibleCents) return view(c);
          if (c.state !== 'RESERVED') throw problem('INVALID_STATE', '券状态不能进入收款', 409);
          r.discountCents = eligible(c, input.eligibleCents);
          r.eligibleCents = input.eligibleCents;
          if (integer(input.paidCents, '支付金额') !== input.eligibleCents - r.discountCents) throw problem('AMOUNT_MISMATCH', '优惠与支付金额不一致');
          r.paidCents = input.paidCents; r.orderId = text(input.orderId, '订单编号'); r.orderNo = text(input.orderNo, '收银订单号');
          ensureUnclaimed('reservation.orderId', r.orderId, c.id, 'ORDER_CONFLICT', '此订单已关联其他优惠券');
          c.state = 'PAYMENT_PENDING'; put('coupons', c); event(actor, action, c.id); return view(c);
        }
        if (action === 'commit') {
          if (r.orderId !== input.orderId || r.paidCents !== input.paidCents) throw problem('ORDER_MISMATCH', '订单或金额与占用记录不一致', 409);
          const paymentReference = text(input.paymentReference, '支付或零元结算编号');
          if (c.state === 'REDEEMED') {
            if (c.paymentReference !== paymentReference) throw problem('ORDER_MISMATCH', '核销回执不一致', 409);
            return view(c);
          }
          if (c.state !== 'PAYMENT_PENDING') throw problem('INVALID_STATE', '券尚未关联支付订单', 409);
          ensureUnclaimed('paymentReference', paymentReference, c.id, 'PAYMENT_CONFLICT', '此支付编号已核销其他优惠券');
          c.state = 'REDEEMED'; c.paymentReference = paymentReference; c.redeemedAt = timestamp(); put('coupons', c); event(actor, action, c.id); return view(c);
        }
        if (c.state === 'PAYMENT_PENDING' && (input.orderId !== r.orderId || !['failed', 'not-started'].includes(input.outcome))) throw problem('PAYMENT_UNKNOWN', '支付结果未知，不能释放优惠券', 409);
        if (!['RESERVED', 'PAYMENT_PENDING'].includes(c.state)) throw problem('INVALID_STATE', '不能释放已核销的券', 409);
        c.state = deadline(c) <= timestamp() ? 'EXPIRED' : 'AVAILABLE'; c.reservation = null; put('coupons', c); event(actor, action, c.id); return view(c);
      }
      throw problem('NOT_FOUND', '接口不存在', 404);
    });
  }
  return {
    dispatch,
    authenticate(token) {
      const row = db.prepare('SELECT data FROM api_keys WHERE hash=?').get(digest(token));
      const key = row ? JSON.parse(row.data) : null;
      if (!key?.enabled) throw problem('UNAUTHORIZED', '凭证无效或已停用', 401);
      return key;
    },
    close: () => db.close(),
    identity: { id: identity.id, environment: identity.environment },
  };
}
module.exports = { createCouponStore, problem, digest };
