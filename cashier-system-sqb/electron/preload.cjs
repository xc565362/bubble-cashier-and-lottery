const { contextBridge, ipcRenderer } = require('electron');
const actions = new Set(['config', 'generate-key', 'save-config', 'import-credentials', 'export-credentials', 'check-connection', 'diagnostics', 'pending', 'start', 'query', 'acknowledge', 'claim-payment-notification',
  'preview-adjustment', 'start-adjustment', 'export-backup', 'prepare-restore', 'commit-restore', 'abort-restore', 'restore-status',
  'lottery-config', 'lottery-connect', 'lottery-snapshot', 'lottery-records', 'lottery-update', 'lottery-increase-capacity', 'lottery-export-connection', 'lottery-import-connection',
  'scarf-config', 'scarf-connect', 'scarf-snapshot', 'scarf-records', 'scarf-update', 'scarf-export-connection', 'scarf-import-connection',
  'coupon-config', 'coupon-connect', 'coupon-campaigns', 'coupon-create-campaign', 'coupon-set-campaign', 'coupon-coupons', 'coupon-coupon', 'coupon-issue',
  'coupon-keys', 'coupon-create-key', 'coupon-revoke-key', 'coupon-void', 'coupon-events', 'coupon-reserve', 'coupon-release', 'coupon-sync', 'coupon-pending', 'coupon-zero', 'coupon-zero-ack', 'coupon-physical-bindings', 'coupon-bind-physical-products', 'coupon-fulfilment']);
contextBridge.exposeInMainWorld('sqb', {
  call: (action, payload = {}) => {
    if (!actions.has(action)) return Promise.reject(new Error('不支持的支付操作'));
    return ipcRenderer.invoke('sqb:call', action, payload);
  },
});
