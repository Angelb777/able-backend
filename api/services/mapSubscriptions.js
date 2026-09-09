const mongoose = require('mongoose');
const MapPlan = require('../models/MapPlan');
const StepcoinTransaction = require('../models/StepcoinTransaction');
const PromocionComprada = require('../models/PromocionComprada');
const User = require('../models/User');
const Establishment = require('../models/Establishment');

const DEFAULT_MAP_PLANS = [
  {
    code: 'MAP_MONTHLY', title: '1 mes',
    description: 'Tu local visible en el mapa durante un mes.',
    durationMonths: 1, priceStepcoins: 1500, referencePriceEuros: 10,
    sortOrder: 10,
  },
  {
    code: 'MAP_YEARLY', title: '1 año',
    description: 'Tu local visible en el mapa durante un año.',
    durationMonths: 12, priceStepcoins: 15000, referencePriceEuros: 65,
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
      $unset: { priceEuros: '' },
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

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const fresh = await PromocionComprada.findOne({
          _id: current._id, status: 'published', activo: true, fechaFin: current.fechaFin,
        }).session(session);
        if (!fresh) return;

        const start = new Date(fresh.fechaFin);
        const operationKey = `merchant_local_promotion_renewal:${fresh._id}:${start.getTime()}`;
        const alreadyCharged = await StepcoinTransaction.findOne({ operationKey }).session(session);
        if (alreadyCharged) return;

        const price = Math.max(0, Math.round(Number(
          fresh.originalPriceStepcoins ?? fresh.precioStepcoins
            ?? fresh.originalPriceEuros ?? fresh.precioEuros ?? 0,
        )));
        const owner = await User.findOneAndUpdate(
          { _id: fresh.comercioId, role: 'comercio', stepcoins: { $gte: price } },
          { $inc: { stepcoins: -price } },
          { new: true, session },
        );
        if (!owner) {
          fresh.activo = false;
          fresh.status = 'expired';
          await fresh.save({ session });
          return;
        }

        const end = addMonths(start, fresh.duracionMeses || 1);
        const [transaction] = await StepcoinTransaction.create([{
          userId: fresh.comercioId,
          cantidad: -price,
          tipo: 'promocion_local_comercio',
          descripcion: `Renovación del local ${fresh.publicName || fresh.titulo || ''}`.trim(),
          fecha: start,
          operationKey,
          metadata: {
            source: 'merchant_local_promotion', action: 'renewal',
            establishmentId: fresh.establishmentId, mapSubscriptionId: fresh._id,
          },
        }], { session });

        fresh.fechaInicio = start;
        fresh.fechaFin = end;
        fresh.cancelAtPeriodEnd = false;
        fresh.precioStepcoins = price;
        fresh.originalPriceStepcoins = price;
        fresh.stepcoinTransactionId = transaction._id;
        fresh.paymentId = undefined;
        fresh.precioEuros = undefined;
        fresh.originalPriceEuros = undefined;
        fresh.promotionCode = '';
        await fresh.save({ session });
      });
    } finally {
      await session.endSession();
    }
  }
}

module.exports = {
  addMonths, ensureDefaultMapPlans, ensureEstablishmentLocationIndexes,
  renewExpiredMapSubscriptions,
};
