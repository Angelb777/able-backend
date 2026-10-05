const MapPlan = require('../models/MapPlan');
const PromocionComprada = require('../models/PromocionComprada');
const Establishment = require('../models/Establishment');

const DEFAULT_MAP_PLANS = [
  {
    code: 'MAP_MONTHLY', title: '1 mes',
    description: 'Suscripción mensual. Renueva automáticamente hasta que la canceles.',
    durationMonths: 1, priceEuros: 10, priceCents: 1000,
    currency: 'EUR', recurringInterval: 'month', recurringIntervalCount: 1,
    sortOrder: 10,
  },
  {
    code: 'MAP_YEARLY', title: '1 año',
    description: 'Suscripción anual. Renueva automáticamente hasta que la canceles.',
    durationMonths: 12, priceEuros: 65, priceCents: 6500,
    currency: 'EUR', recurringInterval: 'year', recurringIntervalCount: 1,
    sortOrder: 20,
  },
];

function addMonths(date, months) {
  const result = new Date(date);
  result.setUTCMonth(result.getUTCMonth() + Number(months));
  return result;
}

async function ensureDefaultMapPlans() {
  await Promise.all(DEFAULT_MAP_PLANS.map((plan) => MapPlan.updateOne(
    { code: plan.code },
    {
      $set: plan,
      $setOnInsert: { active: true },
      $unset: { priceStepcoins: '', referencePriceEuros: '' },
    },
    { upsert: true, setDefaultsOnInsert: true },
  )));
  return MapPlan.find({ active: true }).sort({ sortOrder: 1, durationMonths: 1 }).lean();
}

async function ensureEstablishmentLocationIndexes() {
  const collection = Establishment.collection;
  let indexes = [];
  try { indexes = await collection.indexes(); } catch (error) {
    if (error?.code !== 26) throw error;
  }
  const legacyUnique = indexes.find((index) => index.unique
    && index.key?.ownerId === 1 && Object.keys(index.key).length === 1);
  if (legacyUnique) await collection.dropIndex(legacyUnique.name);
  await collection.createIndex(
    { ownerId: 1, archived: 1, updatedAt: -1 },
    { background: true },
  );
}

async function renewExpiredMapSubscriptions() {
  const now = new Date();
  // Stripe renueva y cobra las suscripciones reales mediante webhooks. Esta
  // limpieza solo caduca publicaciones legacy/gratuitas; nunca intenta cobrar SC.
  const expired = await PromocionComprada.find({
    status: 'published', activo: true, fechaFin: { $lt: now },
    stripeSubscriptionId: { $exists: false },
  }).lean();
  if (!expired.length) return;
  await PromocionComprada.updateMany(
    { _id: { $in: expired.map((item) => item._id) }, status: 'published' },
    { $set: { activo: false, status: 'expired', autoRenew: false } },
  );
}

module.exports = {
  addMonths, ensureDefaultMapPlans, ensureEstablishmentLocationIndexes,
  renewExpiredMapSubscriptions,
};
