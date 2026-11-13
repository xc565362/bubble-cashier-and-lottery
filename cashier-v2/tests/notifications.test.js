import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { showPaymentNotification } = require('../electron/notifications.cjs');
const { paymentNotice } = require('../payments/receipt.cjs');

test('desktop notification reports delivery and supports focusing the cashier', async () => {
  let created;
  let clicked = 0;
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; created = this; }
    show() { this.emit('show'); }
  }
  const notice = paymentNotice({ id: 'TEST', state: 'paid', orderSn: 'ORDER', amount: 5, tenders: [] });
  assert.equal(await showPaymentNotification(Notification, notice, () => clicked++), true);
  assert.equal(created.options.body, '收款成功，收款 0.05 元');
  assert.equal(created.options.silent, false);
  created.emit('click'); assert.equal(clicked, 1);
});

test('unsupported or denied system notifications do not reject the completed payment', async () => {
  class Unsupported { static isSupported() { return false; } }
  class Failed extends EventEmitter {
    static isSupported() { return true; }
    show() { this.emit('failed', new Error('denied')); }
  }
  class Throws extends Failed { show() { throw new Error('denied'); } }
  for (const Notification of [Unsupported, Failed, Throws]) assert.equal(await showPaymentNotification(Notification, { id: 'TEST' }, () => {}), false);
  for (const amount of [0, -1, 0.1, NaN]) assert.throws(() => paymentNotice({ state: 'paid', orderSn: 'ORDER', amount }), /未确认/);
});
