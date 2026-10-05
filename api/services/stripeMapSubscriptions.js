const Stripe = require('stripe');
const mongoose = require('mongoose');
const Establishment = require('../models/Establishment');
const MapPlan = require('../models/MapPlan');
const Payment = require('../models/Payment');
const PromocionComprada = require('../models/PromocionComprada');
const User = require('../models/User');
const { addMonths } = require('./mapSubscriptions');

let client;

function setStripeClientForTests(value) {
  client = value;
  if (client) client._ableKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
}

function stripeClient() {
  const key = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key) {
    const error = new Error('Stripe no está configurado en el servidor');
    error.status = 503;
    error.code = 'STRIPE_NOT_CONFIGURED';
    throw error;
  }
  if (!client || client._ableKey !== key) {
    client = new Stripe(key, { maxNetworkRetries: 2, timeout: 15000 });
    client._ableKey = key;
  }
  return client;
}

function configuredBaseUrl(req) {
  const configured = String(process.env.APP_BASE_URL || '').trim();
  if (configured) {
    const parsed = new URL(configured);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('APP_BASE_URL no es válida');
    return parsed.origin;
  }
  if (process.env.NODE_ENV === 'production') {
    const error = new Error('Falta APP_BASE_URL en el servidor');
    error.status = 503;
    error.code = 'APP_BASE_URL_NOT_CONFIGURED';
    throw error;
  }
  return `${req.protocol}://${req.get('host')}`;
}

function subscriptionPeriod(subscription, fallbackMonths = 1) {
  const items = subscription?.items?.data || [];
  const starts = [subscription?.current_period_start, ...items.map((item) => item.current_period_start)]
    .map(Number).filter(Number.isFinite);
  const ends = [subscription?.current_period_end, ...items.map((item) => item.current_period_end)]
    .map(Number).filter(Number.isFinite);
  const start = starts.length ? new Date(Math.min(...starts) * 1000) : new Date();
  const end = ends.length ? new Date(Math.max(...ends) * 1000) : addMonths(start, fallbackMonths);
  return { start, end };
}

function subscriptionIdFromInvoice(invoice) {
  const value = invoice?.subscription
    || invoice?.parent?.subscription_details?.subscription
    || invoice?.subscription_details?.subscription;
  return typeof value === 'string' ? value : value?.id;
}

async function syncStripeSubscription(subscription, checkoutSessionId = '') {
  const metadata = subscription?.metadata || {};
  const ownerId = String(metadata.ownerId || '');
  const establishmentId = String(metadata.establishmentId || '');
  const planCode = String(metadata.planCode || '').toUpperCase();
  if (!mongoose.Types.ObjectId.isValid(ownerId)
      || !mongoose.Types.ObjectId.isValid(establishmentId)
      || !planCode) {
    throw new Error('La suscripción de Stripe no contiene metadatos válidos de Able73');
  }

  const stripeStatus = String(subscription.status || '');
  const terminal = ['canceled', 'unpaid', 'incomplete_expired', 'paused'].includes(stripeStatus);
  const [location, plan, existing] = await Promise.all([
    Establishment.findOne({ _id: establishmentId, ownerId, archived: { $ne: true } }).lean(),
    MapPlan.findOne({ code: planCode }).lean(),
    PromocionComprada.findOne({ stripeSubscriptionId: subscription.id }),
  ]);
  if ((!location || !plan) && terminal && existing) {
    existing.activo = false;
    existing.status = 'expired';
    existing.paymentStatus = 'canceled';
    existing.autoRenew = false;
    existing.cancelAtPeriodEnd = Boolean(subscription.cancel_at_period_end);
    existing.stripeSubscriptionStatus = stripeStatus;
    existing.stoppedAt = new Date();
    existing.retiredAt = existing.stoppedAt;
    return existing.save();
  }
  if (!location || !plan) throw new Error('El local o el plan asociado a Stripe ya no existe');

  const paidAndVisible = ['active', 'trialing'].includes(stripeStatus);
  const { start, end } = subscriptionPeriod(subscription, plan.durationMonths);
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer : subscription.customer?.id;
  const latestInvoiceId = typeof subscription.latest_invoice === 'string'
    ? subscription.latest_invoice : subscription.latest_invoice?.id;

  return PromocionComprada.findOneAndUpdate(
    { establishmentId: location._id },
    {
      $set: {
        comercioId: ownerId,
        establishmentId: location._id,
        mapPlanId: plan._id,
        planCode: plan.code,
        titulo: location.publicName,
        publicName: location.publicName,
        description: location.description,
        address: location.address,
        logoComercio: location.logoUrl,
        imagenBase: '/img/local.png',
        lat: location.lat,
        lng: location.lng,
        proximityMessage: String(
          location.proximityMessage || `¿Te apetece visitar ${location.publicName}?`,
        ).trim().slice(0, 50),
        proximityRadiusMeters: 250,
        duracionMeses: plan.durationMonths,
        precioEuros: Number(plan.priceEuros),
        originalPriceEuros: Number(plan.priceEuros),
        fechaInicio: start,
        fechaFin: end,
        activo: paidAndVisible,
        status: paidAndVisible ? 'published' : (terminal ? 'expired' : 'pending'),
        paymentStatus: paidAndVisible ? 'confirmed' : (terminal ? 'canceled' : 'pending'),
        autoRenew: paidAndVisible && !subscription.cancel_at_period_end,
        cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscription.id,
        stripeSubscriptionStatus: stripeStatus,
        stripeLatestInvoiceId: latestInvoiceId,
        ...(checkoutSessionId ? { stripeCheckoutSessionId: checkoutSessionId } : {}),
        stoppedAt: terminal ? new Date() : null,
        retiredAt: terminal ? new Date() : null,
        publishedAt: paidAndVisible ? new Date() : null,
      },
      $unset: {
        paymentId: '', stepcoinTransactionId: '', precioStepcoins: '',
        originalPriceStepcoins: '', promotionCode: '',
      },
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
  );
}

async function recordPaidInvoice(invoice, mapSubscription) {
  const amount = Number(invoice.amount_paid || 0) / 100;
  if (!(amount > 0) || !mapSubscription) return null;
  const owner = await User.findById(mapSubscription.comercioId)
    .select('nombre nickname email').lean();
  return Payment.findOneAndUpdate(
    { providerReference: `stripe:invoice:${invoice.id}` },
    {
      $setOnInsert: {
        userId: mapSubscription.comercioId,
        nombre: owner?.nombre || owner?.nickname || owner?.email || 'Comercio',
        cantidad: amount,
        stepcoinsDelta: 0,
        motivo: `Suscripción del local ${mapSubscription.publicName || mapSubscription.titulo}`,
        currency: String(invoice.currency || 'eur').toUpperCase(),
        fecha: invoice.status_transitions?.paid_at
          ? new Date(invoice.status_transitions.paid_at * 1000) : new Date(),
        verified: true,
        verifiedAt: new Date(),
        source: 'payment_provider',
        providerReference: `stripe:invoice:${invoice.id}`,
        establishmentId: mapSubscription.establishmentId,
        mapSubscriptionId: mapSubscription._id,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function handleStripeEvent(event) {
  const stripe = stripeClient();
  const object = event.data.object;
  if (event.type === 'checkout.session.completed') {
    if (object.mode !== 'subscription' || !object.subscription) return;
    const subscription = await stripe.subscriptions.retrieve(
      typeof object.subscription === 'string' ? object.subscription : object.subscription.id,
      { expand: ['items.data.price'] },
    );
    await syncStripeSubscription(subscription, object.id);
    return;
  }
  if (['customer.subscription.created', 'customer.subscription.updated',
    'customer.subscription.deleted'].includes(event.type)) {
    await syncStripeSubscription(object);
    return;
  }
  if (event.type === 'invoice.paid') {
    const subscriptionId = subscriptionIdFromInvoice(object);
    if (!subscriptionId) return;
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price'],
    });
    const mapSubscription = await syncStripeSubscription(subscription);
    await recordPaidInvoice(object, mapSubscription);
    return;
  }
  if (event.type === 'invoice.payment_failed') {
    const subscriptionId = subscriptionIdFromInvoice(object);
    if (!subscriptionId) return;
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price'],
    });
    await syncStripeSubscription(subscription);
  }
}

module.exports = {
  configuredBaseUrl,
  handleStripeEvent,
  setStripeClientForTests,
  stripeClient,
  syncStripeSubscription,
};
