const MapPlan = require('../models/MapPlan');
const Payment = require('../models/Payment');
const PromocionComprada = require('../models/PromocionComprada');
const User = require('../models/User');
const Establishment = require('../models/Establishment');

const DEFAULT_MAP_PLANS = [
  {
    code: 'MAP_MONTHLY', title: '1 mes',
    description: 'Tu local visible en el mapa durante un mes.',
    durationMonths: 1, priceEuros: 20, sortOrder: 10,
  },
  {
    code: 'MAP_YEARLY', title: '1 año',
    description: 'Tu local visible en el mapa durante un año. Ahorras 40 €.',
    durationMonths: 12, priceEuros: 200, sortOrder: 20,
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
    { $setOnInsert: { ...plan, active: true } },
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
  const expired = await PromocionComprada.find({
    status: 'published', activo: true, fechaFin: { $lt: now },
  }).lean();

  for (const current of expired) {
    if (!current.autoRenew || current.cancelAtPeriodEnd) {
      await PromocionComprada.updateOne(
        { _id: current._id, status: 'published', fechaFin: current.fechaFin },
        { $set: { activo: false, status: 'expired' } },
      );
      continue;
    }

    const start = new Date(current.fechaFin);
    const end = addMonths(start, current.duracionMeses || 1);
    const reference = `MAP-RENEW-${current._id}-${start.getTime()}`;
    const updated = await PromocionComprada.findOneAndUpdate(
      { _id: current._id, status: 'published', activo: true, fechaFin: current.fechaFin },
      { $set: { fechaInicio: start, fechaFin: end, cancelAtPeriodEnd: false } },
      { new: true },
    );
    if (!updated) continue;

    const owner = await User.findById(current.comercioId).select('nombre nickname email').lean();
    const payment = await Payment.findOneAndUpdate(
      { providerReference: reference },
      { $setOnInsert: {
        userId: current.comercioId,
        nombre: owner?.nombre || owner?.nickname || owner?.email || 'Comercio',
        cantidad: current.originalPriceEuros ?? current.precioEuros,
        motivo: `Renovación del local ${current.publicName || current.titulo || ''}`.trim(),
        currency: 'EUR', fecha: start, verified: true, verifiedAt: start,
        source: 'platform_checkout', providerReference: reference,
        establishmentId: current.establishmentId, mapSubscriptionId: current._id,
      } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    await PromocionComprada.updateOne({ _id: current._id }, {
      $set: {
        paymentId: payment._id,
        precioEuros: current.originalPriceEuros ?? current.precioEuros,
        promotionCode: '',
      },
    });
  }
}

module.exports = {
  addMonths, ensureDefaultMapPlans, ensureEstablishmentLocationIndexes,
  renewExpiredMapSubscriptions,
};
