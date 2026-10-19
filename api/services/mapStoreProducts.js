const MAP_STORE_PRODUCTS = Object.freeze({
  promo_local_monthly: Object.freeze({
    productId: 'promo_local_monthly',
    planCode: 'MAP_MONTHLY',
    title: 'Promoción mensual',
    durationLabel: '30 días',
    durationDays: 30,
    priceEuros: 9.99,
  }),
  promo_local_yearly: Object.freeze({
    productId: 'promo_local_yearly',
    planCode: 'MAP_YEARLY',
    title: 'Promoción anual',
    durationLabel: '12 meses',
    durationMonths: 12,
    priceEuros: 65,
  }),
});

function mapStoreProduct(productId) {
  return MAP_STORE_PRODUCTS[String(productId || '').trim()] || null;
}

function addMonths(date, months) {
  const result = new Date(date);
  result.setUTCMonth(result.getUTCMonth() + Number(months));
  return result;
}

function entitlementPeriod(product, currentEnd, now = new Date()) {
  if (!product) throw new Error('Producto de promoción no válido');
  const activeEnd = currentEnd ? new Date(currentEnd) : null;
  const start = activeEnd && activeEnd > now ? activeEnd : new Date(now);
  const end = product.durationMonths
    ? addMonths(start, product.durationMonths)
    : new Date(start.getTime() + product.durationDays * 24 * 60 * 60 * 1000);
  return {
    start,
    end,
    durationDays: Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000)),
  };
}

function storeProviderReference(platform, value) {
  const provider = platform === 'ios' ? 'app-store' : 'google-play';
  return `${provider}:${String(value || '').trim()}`;
}

module.exports = {
  MAP_STORE_PRODUCTS,
  entitlementPeriod,
  mapStoreProduct,
  storeProviderReference,
};
