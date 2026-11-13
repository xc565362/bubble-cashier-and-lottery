const activeNotifications = new Map();

function showPaymentNotification(Notification, notice, focus) {
  if (!Notification.isSupported()) return Promise.resolve(false);
  return new Promise((resolve) => {
    let notification;
    let timer;
    let settled = false;
    const finish = (shown) => { if (!settled) { settled = true; clearTimeout(timer); resolve(shown); } };
    try {
      notification = new Notification({ id: notice.id, title: notice.title, body: notice.body, silent: false });
      // Native notification objects need a live reference for delivery and clicks.
      activeNotifications.set(notice.id, notification);
      if (activeNotifications.size > 100) activeNotifications.delete(activeNotifications.keys().next().value);
      notification.once('show', () => finish(true));
      notification.once('failed', () => { activeNotifications.delete(notice.id); finish(false); });
      notification.once('close', () => activeNotifications.delete(notice.id));
      notification.on('click', focus);
      timer = setTimeout(() => finish(false), 5000);
      notification.show();
    } catch { activeNotifications.delete(notice.id); finish(false); }
  });
}

module.exports = { showPaymentNotification };
