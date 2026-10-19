const mongoose = require('mongoose');
const MapPromotionPurchase = require('../models/MapPromotionPurchase');
const Payment = require('../models/Payment');
const PromocionComprada = require('../models/PromocionComprada');
const { entitlementPeriod } = require('./mapStoreProducts');

function publicationFields(location) {
  return {
    titulo: location.publicName,
    publicName: location.publicName,
    description: location.description || '',
    address: location.address,
    logoComercio: location.logoUrl,
    lat: location.lat,
    lng: location.lng,
    proximityMessage: location.proximityMessage || '',
    proximityRadiusMeters: 250,
  };
}

async function applyVerifiedMapPurchase({
  owner,
  location,
  product,
  provider,
  providerReference,
  transactionId = '',
  purchaseToken = '',
  environment = '',
  promotionCode = '',
}) {
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const previous = await MapPromotionPurchase.findOne({ providerReference }).session(session);
      if (previous) {
        if (String(previous.ownerId) !== String(owner._id)
            || String(previous.establishmentId) !== String(location._id)) {
          throw Object.assign(
            new Error('La compra ya pertenece a otra cuenta o establecimiento'),
            { status: 409, code: 'PURCHASE_ALREADY_OWNED' },
          );
        }
        const subscription = await PromocionComprada.findById(
          previous.mapSubscriptionId,
        ).session(session);
        result = { duplicate: true, purchase: previous, subscription };
        return;
      }

      const current = await PromocionComprada.findOne({
        comercioId: owner._id,
        establishmentId: location._id,
      }).session(session);
      const now = new Date();
      const period = entitlementPeriod(product, current?.fechaFin, now);
      const [payment] = await Payment.create([{
        userId: owner._id,
        nombre: owner.nombre || owner.nickname || owner.email || location.publicName,
        cantidad: product.priceEuros,
        stepcoinsDelta: 0,
        motivo: `${product.title} para ${location.publicName}`,
        currency: 'EUR',
        fecha: now,
        verified: true,
        verifiedAt: now,
        status: 'confirmed',
        source: 'payment_provider',
        providerReference,
        establishmentId: location._id,
      }], { session });

      const subscription = await PromocionComprada.findOneAndUpdate(
        { comercioId: owner._id, establishmentId: location._id },
        {
          $set: {
            comercioId: owner._id,
            establishmentId: location._id,
            planCode: product.planCode,
            duracionMeses: product.durationMonths || 1,
            precioEuros: product.priceEuros,
            originalPriceEuros: product.priceEuros,
            fechaInicio: current?.activo && current?.fechaFin > now
              ? current.fechaInicio
              : now,
            fechaFin: period.end,
            activo: true,
            status: 'published',
            paymentStatus: 'confirmed',
            paymentId: payment._id,
            autoRenew: false,
            cancelAtPeriodEnd: false,
            checkoutReference: providerReference,
            publishedAt: current?.publishedAt || now,
            ...(promotionCode ? { promotionCode } : {}),
            ...publicationFields(location),
          },
        },
        { upsert: true, new: true, runValidators: true, session, setDefaultsOnInsert: true },
      );

      const [purchase] = await MapPromotionPurchase.create([{
        ownerId: owner._id,
        establishmentId: location._id,
        mapSubscriptionId: subscription._id,
        paymentId: payment._id,
        provider,
        providerReference,
        productId: product.productId,
        transactionId,
        purchaseToken,
        environment,
        planCode: product.planCode,
        durationDays: period.durationDays,
        entitlementStart: period.start,
        entitlementEnd: period.end,
        promotionCode,
        status: 'confirmed',
      }], { session });
      await Payment.updateOne(
        { _id: payment._id },
        { $set: { mapSubscriptionId: subscription._id } },
        { session },
      );
      result = { duplicate: false, purchase, subscription };
    });
    return result;
  } catch (error) {
    // Dos reintentos simultÃ¡neos pueden superar el find inicial. Los Ã­ndices
    // Ãºnicos siguen siendo la Ãºltima barrera y el segundo intento se responde
    // como idempotente una vez que la primera transacciÃ³n ha terminado.
    if (error?.code === 11000) {
      const previous = await MapPromotionPurchase.findOne({ providerReference });
      if (previous) {
        if (String(previous.ownerId) !== String(owner._id)
            || String(previous.establishmentId) !== String(location._id)) {
          throw Object.assign(
            new Error('La compra ya pertenece a otra cuenta o establecimiento'),
            { status: 409, code: 'PURCHASE_ALREADY_OWNED' },
          );
        }
        const subscription = await PromocionComprada.findById(previous.mapSubscriptionId);
        return { duplicate: true, purchase: previous, subscription };
      }
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

async function revokeMapPurchase(providerReference, reason = 'refunded') {
  const session = await mongoose.startSession();
  let result = null;
  try {
    await session.withTransaction(async () => {
      const purchase = await MapPromotionPurchase.findOne({ providerReference }).session(session);
      if (!purchase || purchase.status !== 'confirmed') {
        result = { changed: false, purchase };
        return;
      }
      const now = new Date();
      purchase.status = reason === 'refunded' ? 'refunded' : 'revoked';
      purchase.revokedAt = now;
      purchase.revocationReason = reason;
      await purchase.save({ session });
      await Payment.updateOne(
        { _id: purchase.paymentId },
        {
          $set: {
            verified: false,
            status: purchase.status,
            refundedAt: now,
          },
        },
        { session },
      );
      const subscription = await PromocionComprada.findById(
        purchase.mapSubscriptionId,
      ).session(session);
      // Si despuÃ©s de esta compra se activÃ³ una suscripciÃ³n Stripe, esa
      // suscripciÃ³n mantiene por sÃ­ sola el derecho de publicaciÃ³n. El
      // reembolso del periodo fijo no debe recortar el periodo de Stripe.
      const stripeStillBacksPublication = subscription?.stripeSubscriptionId
        && !['canceled', 'unpaid', 'incomplete_expired'].includes(
          subscription.stripeSubscriptionStatus,
        );
      if (subscription && !stripeStillBacksPublication) {
        const currentEnd = new Date(subscription.fechaFin);
        const shortened = new Date(
          currentEnd.getTime() - Number(purchase.durationDays) * 86400000,
        );
        const end = shortened > now ? shortened : now;
        subscription.fechaFin = end;
        subscription.activo = end > now;
        if (!subscription.activo) subscription.status = 'expired';
        await subscription.save({ session });
      }
      result = { changed: true, purchase, subscription };
    });
    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = {
  applyVerifiedMapPurchase,
  publicationFields,
  revokeMapPurchase,
};
