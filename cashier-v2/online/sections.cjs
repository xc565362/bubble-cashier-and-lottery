'use strict';
// Shared module-grant model for the online cashier. The UI renders navigation
// from the same fixed section keys; the backend enforces them for non-admin
// roles. Admins always bypass grant checks so they can never lock themselves out.
const SECTION_KEYS = Object.freeze(['pos', 'products', 'orders', 'coupons', 'gifts', 'events', 'settings', 'maintenance']);

// Per-role template grants, used when a user row stores no explicit grants.
const ROLE_GRANTS = Object.freeze({
  admin: Object.freeze([...SECTION_KEYS]),
  cashier: Object.freeze(['pos', 'orders', 'gifts', 'events', 'settings']),
  redeemer: Object.freeze(['events', 'coupons', 'orders']),
});

const ROLES = Object.freeze(Object.keys(ROLE_GRANTS));

// Effective grants: a stored non-empty array of known keys wins, otherwise the
// role template applies. Admin is always the full set regardless of storage.
function effectiveGrants(role, stored) {
  if (role === 'admin') return [...SECTION_KEYS];
  if (Array.isArray(stored) && stored.length && stored.every(key => SECTION_KEYS.includes(key))) return [...new Set(stored)];
  return [...(ROLE_GRANTS[role] || [])];
}

// Validates an admin-supplied grants array for storage. Returns the de-duplicated
// array, or null when the user should fall back to the role template.
function storedGrants(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some(key => !SECTION_KEYS.includes(key))) {
    throw Object.assign(new Error('模块权限包含未知项'), { code: 'INVALID_GRANTS', status: 400 });
  }
  const keys = [...new Set(value)];
  return keys.length ? keys : null;
}

// Action/command → module section maps for non-admin grant enforcement.
// Unmapped authenticated staff actions stay allowed (fail-open) so legacy
// flows keep working; admin-only actions are gated before these maps apply.
const SQB_SECTION = Object.freeze({
  // Payment pipe (FINANCIAL) actions run at the till.
  'start': 'pos', 'query': 'pos', 'acknowledge': 'pos', 'pending': 'pos',
  'resolve-missing-payment': 'pos', 'preview-adjustment': 'pos', 'start-adjustment': 'pos',
  'claim-payment-notification': 'pos', 'coupon-reserve': 'pos', 'coupon-release': 'pos',
  'coupon-zero': 'pos', 'coupon-zero-ack': 'pos', 'activity-prize-check': 'pos',
  // Coupon-center sync/fulfilment belong to the coupons module.
  'coupon-sync': 'coupons', 'coupon-fulfilment': 'coupons',
  // Event (campaign) redemption.
  'event-redeem': 'events',
  // In-process activity management (folded-in lottery).
  'activity-list': 'events', 'activity-records': 'events', 'activity-lookup': 'events', 'activity-redeem': 'events',
  'activity-create': 'events', 'activity-update': 'events', 'activity-set-status': 'events', 'activity-export': 'events',
  'activity-reset': 'events', 'activity-record-delete': 'events',
  // Orphan observatory: inspect and clear stale orders/payments/reservations.
  'maintenance-scan': 'maintenance', 'maintenance-remove-order': 'maintenance', 'maintenance-release-award': 'maintenance',
});

const COMMAND_SECTION = Object.freeze({
  // Money-moving ledger commands occupy the till pipe.
  'payment-prepare': 'pos', 'payment-sync': 'pos', 'payment-clear': 'pos', 'payment-review': 'pos',
  'adjustment-prepare': 'pos', 'adjustment-sync': 'pos', 'adjustment-clear': 'pos',
  'zero-complete': 'pos', 'manual-complete': 'pos', 'physical-sync': 'pos', 'recovery': 'pos',
  // Held carts are part of the checkout flow.
  'hold': 'pos', 'retrieve': 'pos', 'held-delete': 'pos',
  // Order history maintenance.
  'order-revise': 'orders',
  // Catalog and shop settings.
  'product-save': 'products', 'product-delete': 'products', 'products-import': 'products',
  'settings-save': 'settings',
});

module.exports = { SECTION_KEYS, ROLE_GRANTS, ROLES, effectiveGrants, storedGrants, SQB_SECTION, COMMAND_SECTION };
