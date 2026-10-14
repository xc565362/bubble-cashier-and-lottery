// Staff recovery must not depend on admin-only campaign or credential endpoints.
export async function loadCouponWorkspace(request, { staff = false, filter = {}, canRecover = true } = {}) {
  const config = await request('config');
  const campaigns = staff ? [] : await request('campaigns');
  const coupons = staff ? { items: [], total: 0, page: 1, pageSize: 30 } : await request('coupons', filter);
  const keys = staff ? [] : await request('keys');
  const pending = await request(canRecover ? 'sync' : 'pending');
  const bindings = await request('physical-bindings');
  return { config, campaigns, coupons, keys, pending, bindings };
}
