import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import config from '../public/campaign.mjs';
import {createApi} from '../public/api.mjs';
import {createEpoch, escapeHtml, safeEntry} from '../public/core.mjs';
import {prizeBoard, probabilityCaption} from '../public/catalog.mjs';

// Execute the actual production functions against small DOM/media boundaries.
// These checks never launch a browser, access a camera or contact a real API.
const app = fs.readFileSync(fileURLToPath(new URL('../public/app.mjs', import.meta.url)), 'utf8');
function productionFunction(name) {
  const declaration = new RegExp(`(?:^|\\n)(?:async )?function ${name}\\(`).exec(app);
  if (!declaration) throw new Error(`Missing production function: ${name}`);
  const start = declaration.index + (app[declaration.index] === '\n' ? 1 : 0);
  const remaining = app.slice(start);
  const next = /\n(?:async )?function [A-Za-z_$][\w$]*\(/.exec(remaining);
  if (!next) throw new Error(`Cannot isolate production function: ${name}`);
  return remaining.slice(0, next.index);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function mediaStream() {
  const stream = {stops: 0, getTracks: () => [{stop() { stream.stops++; }}]};
  return stream;
}

function cameraHarness() {
  const permissions = [], detections = [], alerts = [], events = [];
  const modal = {
    open: false, video: null,
    querySelector() { return this.video; },
    contains(video) { return this.video === video; }
  };
  const context = {
    modal, document: {hidden: false},
    navigator: {mediaDevices: {getUserMedia() { const task = deferred(); permissions.push(task); return task.promise; }}},
    window: {BarcodeDetector: class {
      static async getSupportedFormats() { return ['qr_code', 'code_128']; }
      detect() { const task = deferred(); detections.push(task); return task.promise; }
    }},
    setTimeout() { events.push('timer'); return 1; }, clearTimeout() {},
    button: () => '', render() { events.push('render'); },
    async lookup() { events.push('lookup'); },
    async alertUser(...args) { alerts.push(args); }
  };
  vm.createContext(context);
  vm.runInContext(`
    let scanGeneration=0,scanTimer,scanStream;
    let S={busy:false,staffCode:''};
    ${productionFunction('stopCamera')}
    ${productionFunction('scan')}
    function closeModal(){stopCamera();modal.open=false;modal.video=null;}
    function showModal(){closeModal();modal.open=true;modal.video={srcObject:null,async play(){}};}
    globalThis.driver={scan,stopCamera,closeModal,getStream:()=>scanStream,getCode:()=>S.staffCode};
  `, context, {filename: 'production-camera-functions.mjs'});
  return {context, modal, permissions, detections, alerts, events, ...context.driver};
}

test('cancelled camera permission stops its late stream without closing a newer dialog', async () => {
  const h = cameraHarness(), pending = h.scan(), stream = mediaStream();
  h.closeModal();
  const replacement = {differentDialog: true};
  h.modal.open = true; h.modal.video = replacement;
  h.permissions[0].resolve(stream);
  await pending;
  assert.ok(stream.stops > 0);
  assert.equal(h.modal.open, true);
  assert.equal(h.modal.video, replacement);
  assert.equal(h.alerts.length, 0);
  assert.equal(h.getStream(), null);
});

test('permission resolving while the page is hidden never starts detection', async () => {
  const h = cameraHarness(), pending = h.scan(), stream = mediaStream();
  h.context.document.hidden = true;
  h.permissions[0].resolve(stream);
  await pending;
  assert.ok(stream.stops > 0);
  assert.equal(h.detections.length, 0);
  assert.equal(h.alerts.length, 0);
  assert.equal(h.getStream(), null);
});

test('a decoded result arriving after cancellation cannot fill or query a stale token', async () => {
  const h = cameraHarness(), pending = h.scan(), stream = mediaStream();
  h.permissions[0].resolve(stream);
  await pending; await flush();
  assert.equal(h.detections.length, 1);
  h.closeModal();
  const replacement = {differentDialog: true};
  h.modal.open = true; h.modal.video = replacement;
  h.detections[0].resolve([{rawValue: 'LJC1_0123456789ABCDEF0123456789ABCDEF'}]);
  await flush();
  assert.equal(h.getCode(), '');
  assert.ok(!h.events.includes('lookup'));
  assert.equal(h.modal.open, true);
  assert.equal(h.modal.video, replacement);
});

test('an older permission result does not stop a newer active scanning stream', async () => {
  const h = cameraHarness(), first = h.scan(), oldStream = mediaStream();
  h.closeModal();
  const second = h.scan(), newStream = mediaStream();
  h.permissions[1].resolve(newStream);
  await second;
  h.permissions[0].resolve(oldStream);
  await first;
  assert.ok(oldStream.stops > 0);
  assert.equal(newStream.stops, 0);
  assert.equal(h.getStream(), newStream);
  h.closeModal();
  assert.ok(newStream.stops > 0);
});

test('a successful scan preserves the literal token and stops the camera before lookup', async () => {
  const h = cameraHarness(), pending = h.scan(), stream = mediaStream();
  h.permissions[0].resolve(stream);
  await pending; await flush();
  const raw = 'ljc1_0123456789abcdef0123456789abcdef';
  h.detections[0].resolve([{rawValue: raw}]);
  await flush();
  assert.equal(h.getCode(), raw);
  assert.ok(h.events.includes('lookup'));
  assert.ok(stream.stops > 0);
  assert.equal(h.modal.open, false);
  assert.equal(h.getStream(), null);
});

function appHarness(api) {
  const epoch = createEpoch(), alerts = [], modals = [], events = [];
  const main = {className: '', innerHTML: '', querySelectorAll: () => [], querySelector: () => null};
  const elements = {'#preview-banner': {hidden: true}, '#offline-banner': {hidden: true}};
  const state = {
    route: 'home', loading: false, error: '', drawing: false, busy: false, codeMode: 'qr',
    identity: {openId: 'test-user'}, staffEntry: null, staffCode: '',
    state: {campaign: config.campaign, prizes: config.prizes, inventory: {total: 500, remaining: 500}, drawError: '', entry: null}
  };
  const context = {
    api, config, epoch, main, S: state, safeEntry, prizeBoard, probabilityCaption, e: escapeHtml,
    document: {hidden: false, querySelector: selector => elements[selector], querySelectorAll: () => []},
    expiredAuth: error => ['AUTH_REQUIRED', 'INVALID_TOKEN', 'TOKEN_EXPIRED'].includes(error.code),
    isOffline: () => !!context.offline, offline: false,
    matchMedia: () => ({matches: true}), setTimeout, clearTimeout,
    art: () => '', previewTools: () => '',
    heading: (_en, title, subtitle) => `<h1>${title}</h1><p>${subtitle}</p>`,
    button: (label, action) => `<button data-action="${action}">${label}</button>`,
    closeModal(value) { events.push(['close', value]); }, stopRefresh() {}, schedule() {},
    showModal(...args) { modals.push(args); return Promise.resolve(false); },
    async alertUser(...args) { alerts.push(args); },
    async load() { epoch.next(); events.push(['load']); },
    navigate(page) { events.push(['navigate', page]); }, toast(message) { events.push(['toast', message]); },
    prize: () => 'Prize screen', rules: () => 'Rules screen', staff: () => 'Staff screen'
  };
  vm.createContext(context);
  vm.runInContext(['home', 'render', 'unavailable', 'authFailure', 'draw'].map(productionFunction).join('\n') + '\nglobalThis.driver={draw,render,unavailable,authFailure};', context, {filename: 'production-app-functions.mjs'});
  return {context, state, epoch, main, alerts, modals, events, ...context.driver};
}

test('draw with an expired production session renders a recoverable login error', async () => {
  let now = 0, requests = 0;
  const api = createApi({apiBase: 'https://api.example.invalid/bubble'}, {
    now: () => now,
    fetchImpl: async () => {
      requests++;
      return {ok: true, status: 200, json: async () => ({ok: true, data: {token: 'test-only-session', expiresAt: 1000}})};
    }
  });
  await api.login('one-time-test-code');
  now = 1001;
  const h = appHarness(api);
  await assert.doesNotReject(h.draw());
  assert.equal(requests, 1, 'an expired session must not submit a draw');
  assert.equal(api.hasSession(), false);
  assert.equal(h.state.state, null);
  assert.equal(h.state.identity, null);
  assert.equal(h.state.drawing, false);
  assert.match(h.state.error, /登录已失效/);
  assert.match(h.main.innerHTML, /登录已失效/);
  assert.match(h.main.innerHTML, /返回小程序重新登录/);
  assert.match(h.main.innerHTML, /返回小程序重新进入/);
  assert.equal(h.alerts.length, 1);
  assert.equal(h.modals.length, 0);
});

test('a missing state renders a retry screen on each visitor route', () => {
  for (const route of ['home', 'prize', 'rules']) {
    const h = appHarness({isPreview: false, hasSession: () => true});
    h.state.route = route; h.state.state = null;
    assert.doesNotThrow(h.render);
    assert.match(h.main.innerHTML, /活动信息暂不可用/);
    assert.match(h.main.innerHTML, /重新加载/);
  }
});

test('a draw response arriving after connectivity invalidation cannot restore an award', async () => {
  const response = deferred();
  const h = appHarness({isPreview: false, hasSession: () => true, call: () => response.promise});
  const work = h.draw();
  h.context.offline = true;
  h.unavailable();
  response.resolve({prize: config.prizes[0], status: 'pending', code: 'LJC1_0123456789ABCDEF0123456789ABCDEF', checkoutCoupon: true});
  await work;
  assert.equal(h.state.state.entry, null);
  assert.equal(h.state.drawing, false);
  assert.equal(h.modals.length, 0);
  assert.ok(!h.events.some(([event]) => event === 'load'));
});

test('an older successful draw cannot overwrite state from a newer navigation or identity', async () => {
  const response = deferred();
  const h = appHarness({isPreview: false, hasSession: () => true, call: () => response.promise});
  const work = h.draw();
  h.epoch.next();
  const replacement = {...h.state.state, owner: 'newer-session', entry: null};
  h.state.state = replacement;
  response.resolve({prize: config.prizes[0], status: 'pending', code: 'LJC1_0123456789ABCDEF0123456789ABCDEF', checkoutCoupon: true});
  await work;
  assert.equal(h.state.state, replacement);
  assert.equal(h.state.state.entry, null);
  assert.equal(h.modals.length, 0);
  assert.ok(!h.events.some(([event]) => event === 'load'));
});

test('an old draw rejection cannot log out or replace a newer identity', async () => {
  const response = deferred();
  let logouts = 0;
  const h = appHarness({isPreview: false, hasSession: () => true, call: () => response.promise, logout() { logouts++; }});
  const work = h.draw();
  h.epoch.next();
  const identity = {openId: 'newer-user'};
  h.state.identity = identity;
  response.reject(Object.assign(new Error('Old expired session'), {code: 'AUTH_REQUIRED'}));
  await work;
  assert.equal(logouts, 0);
  assert.equal(h.state.identity, identity);
  assert.equal(h.state.error, '');
  assert.equal(h.alerts.length, 0);
});

test('production failure screens hide cached/default prize controls and never display preview content',()=>{
  for(const route of ['home','prize','rules']){
    const h=appHarness({isPreview:false,hasSession:()=>true});h.state.route=route;
    h.state.error='服务尚未开放';h.render();
    assert.match(h.main.innerHTML,/服务尚未开放/);
    assert.doesNotMatch(h.main.innerHTML,/prize-grid|data-action="draw"|code-display|演示奖品/);
    assert.equal(h.context.document.querySelector('#preview-banner').hidden,true);
  }
});