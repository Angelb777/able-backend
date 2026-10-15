const mongoose = require('mongoose');
const Payment = require('../models/Payment');
const StepcoinTransaction = require('../models/StepcoinTransaction');
const User = require('../models/User');
const { configuredBaseUrl, stripeClient } = require('./stripeMapSubscriptions');
const { stepcoinPackagesFor } = require('./stepcoinPackages');

const PURCHASE_TYPE = 'stepcoins';

async function createStripeStepcoinCheckout({ req, userId, role, email, cantidad, requestId }) {
  const price = stepcoinPackagesFor(role).get(cantidad);
  if (price == null) {
    const error = new Error('Paquete de Stepcoins no valido');
    error.status = 400;
    throw error;
  }

  const baseUrl = configuredBaseUrl(req);
  const metadata = {
    purchaseType: PURCHASE_TYPE,
    userId: String(userId),
    role: String(role),
    stepcoins: String(cantidad),
    requestId: String(requestId),
  };
  const checkout = await stripeClient().checkout.sessions.create({
    mode: 'payment',
    locale: 'es',
    ...(email ? { customer_email: email } : {}),
    client_reference_id: String(userId),
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'eur',
        unit_amount: Math.round(price * 100),
        product_data: {
          name: `Able73 - ${cantidad} Stepcoins`,
          description: `${cantidad} Stepcoins para tu cuenta Able73`,
        },
      },
    }],
    metadata,
    payment_intent_data: { metadata },
    success_url: `${baseUrl}/stripe-stepcoins-return.html?result=success`,
    cancel_url: `${baseUrl}/stripe-stepcoins-return.html?result=cancelled`,
  }, {
    idempotencyKey: `stepcoins:${userId}:${requestId}`,
  });

  return { url: checkout.url, sessionId: checkout.id };
}

function stripeStepcoinMetadata(checkout) {
  const metadata = checkout?.metadata || {};
  if (metadata.purchaseType !== PURCHASE_TYPE) return null;
  const userId = String(metadata.userId || '');
  const cantidad = Number(metadata.stepcoins);
  if (!mongoose.Types.ObjectId.isValid(userId) || !Number.isInteger(cantidad)) return null;
  return { userId, cantidad };
}

async function fulfillStripeStepcoinCheckout(checkout) {
  const parsed = stripeStepcoinMetadata(checkout);
  if (!parsed) return { handled: false };
  if (checkout.mode !== 'payment' || checkout.payment_status !== 'paid') {
    return { handled: true, paid: false };
  }

  const { userId, cantidad } = parsed;
  const userForValidation = await User.findById(userId)
    .select('role stepcoins nombre nickname email').lean();
  if (!userForValidation) throw new Error('Usuario de la compra Stripe no encontrado');
  const price = stepcoinPackagesFor(userForValidation.role).get(cantidad);
  const expectedCents = price == null ? null : Math.round(price * 100);
  const currency = String(checkout.currency || '').toUpperCase();
  if (expectedCents == null
      || Number(checkout.amount_total) !== expectedCents
      || currency !== 'EUR') {
    throw new Error('El importe de la compra Stripe no coincide con el catalogo');
  }

  const providerReference = `stripe:checkout:${checkout.id}`;
  const session = await mongoose.startSession();
  let user;
  let payment;
  let duplicate = false;
  try {
    await session.withTransaction(async () => {
      payment = await Payment.findOne({ providerReference }).session(session);
      if (payment) {
        if (String(payment.userId) !== userId) {
          throw new Error('La compra Stripe pertenece a otro usuario');
        }
        duplicate = true;
        user = await User.findById(userId).select('stepcoins').session(session);
        return;
      }

      user = await User.findOneAndUpdate(
        { _id: userId, role: userForValidation.role },
        { $inc: { stepcoins: cantidad } },
        { new: true, session },
      ).select('stepcoins nombre nickname email');
      if (!user) throw new Error('Usuario de la compra Stripe no encontrado');

      [payment] = await Payment.create([{
        userId,
        nombre: user.nombre || user.nickname || user.email || 'Usuario',
        cantidad: price,
        stepcoinsDelta: cantidad,
        motivo: `Compra de ${cantidad} Stepcoins (Stripe iOS)`,
        currency: 'EUR',
        fecha: new Date(),
        verified: true,
        verifiedAt: new Date(),
        source: 'payment_provider',
        providerReference,
      }], { session });
      await StepcoinTransaction.create([{
        userId,
        cantidad,
        tipo: 'compra',
        descripcion: `Compra de ${cantidad} Stepcoins (Stripe iOS)`,
        operationKey: `stepcoin-pack:${providerReference}`,
        metadata: {
          paymentId: payment._id,
          providerReference,
          price,
          currency: 'EUR',
          stripeCheckoutSessionId: checkout.id,
          stripePaymentIntentId: typeof checkout.payment_intent === 'string'
            ? checkout.payment_intent : checkout.payment_intent?.id,
        },
      }], { session });
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    duplicate = true;
    payment = await Payment.findOne({ providerReference });
    if (payment && String(payment.userId) !== userId) {
      throw new Error('La compra Stripe pertenece a otro usuario');
    }
    user = await User.findById(userId).select('stepcoins');
  } finally {
    await session.endSession();
  }

  return {
    handled: true,
    paid: true,
    duplicate,
    payment,
    user: { stepcoins: Number(user?.stepcoins || 0) },
  };
}

module.exports = {
  createStripeStepcoinCheckout,
  fulfillStripeStepcoinCheckout,
  stripeStepcoinMetadata,
};
