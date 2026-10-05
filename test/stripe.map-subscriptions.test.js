const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Stripe = require('stripe');
const express = require('express');
const http = require('node:http');

const Establishment = require('../api/models/Establishment');
const MapPlan = require('../api/models/MapPlan');
const PromocionComprada = require('../api/models/PromocionComprada');
const stripeService = require('../api/services/stripeMapSubscriptions');
const stripeWebhook = require('../api/routes/stripeWebhook');

test('an active Stripe subscription publishes its associated location', async (t) => {
  const originals = {
    establishmentFindOne: Establishment.findOne,
    planFindOne: MapPlan.findOne,
    subscriptionFindOne: PromocionComprada.findOne,
    subscriptionUpsert: PromocionComprada.findOneAndUpdate,
  };
  t.after(() => {
    Establishment.findOne = originals.establishmentFindOne;
    MapPlan.findOne = originals.planFindOne;
    PromocionComprada.findOne = originals.subscriptionFindOne;
    PromocionComprada.findOneAndUpdate = originals.subscriptionUpsert;
  });

  const ownerId = new mongoose.Types.ObjectId();
  const establishmentId = new mongoose.Types.ObjectId();
  const planId = new mongoose.Types.ObjectId();
  const location = {
    _id: establishmentId, ownerId, publicName: 'Local Stripe', address: 'Calle Uno',
    description: 'Tienda', logoUrl: '/logo.png', lat: 41.65, lng: -0.88,
    proximityMessage: '',
  };
  const plan = {
    _id: planId, code: 'MAP_MONTHLY', durationMonths: 1, priceEuros: 10,
  };
  Establishment.findOne = () => ({ lean: async () => location });
  MapPlan.findOne = () => ({ lean: async () => plan });
  PromocionComprada.findOne = async () => null;
  let written;
  PromocionComprada.findOneAndUpdate = async (filter, update, options) => {
    written = { filter, update, options };
    return { _id: new mongoose.Types.ObjectId(), ...update.$set };
  };

  const start = Math.floor(Date.now() / 1000);
  const result = await stripeService.syncStripeSubscription({
    id: 'sub_test_able73', status: 'active', customer: 'cus_test_able73',
    cancel_at_period_end: false, latest_invoice: 'in_test_able73',
    metadata: {
      ownerId: String(ownerId), establishmentId: String(establishmentId),
      planCode: 'MAP_MONTHLY',
    },
    items: { data: [{ current_period_start: start, current_period_end: start + 2592000 }] },
  }, 'cs_test_able73');

  assert.equal(result.activo, true);
  assert.equal(written.update.$set.status, 'published');
  assert.equal(written.update.$set.paymentStatus, 'confirmed');
  assert.equal(written.update.$set.autoRenew, true);
  assert.equal(written.update.$set.precioEuros, 10);
  assert.equal(written.update.$set.stripeCheckoutSessionId, 'cs_test_able73');
  assert.equal(written.options.upsert, true);
});

test('a terminated Stripe subscription removes its location from the map', async (t) => {
  const originals = {
    establishmentFindOne: Establishment.findOne,
    planFindOne: MapPlan.findOne,
    subscriptionFindOne: PromocionComprada.findOne,
    subscriptionUpsert: PromocionComprada.findOneAndUpdate,
  };
  t.after(() => {
    Establishment.findOne = originals.establishmentFindOne;
    MapPlan.findOne = originals.planFindOne;
    PromocionComprada.findOne = originals.subscriptionFindOne;
    PromocionComprada.findOneAndUpdate = originals.subscriptionUpsert;
  });

  const ownerId = new mongoose.Types.ObjectId();
  const establishmentId = new mongoose.Types.ObjectId();
  const planId = new mongoose.Types.ObjectId();
  Establishment.findOne = () => ({ lean: async () => ({
    _id: establishmentId, ownerId, publicName: 'Local finalizado',
    address: 'Calle Dos', description: '', logoUrl: '/logo.png',
    lat: 41.65, lng: -0.88, proximityMessage: '',
  }) });
  MapPlan.findOne = () => ({ lean: async () => ({
    _id: planId, code: 'MAP_MONTHLY', durationMonths: 1, priceEuros: 10,
  }) });
  PromocionComprada.findOne = async () => null;
  let written;
  PromocionComprada.findOneAndUpdate = async (_filter, update) => {
    written = update.$set;
    return { _id: new mongoose.Types.ObjectId(), ...written };
  };

  const now = Math.floor(Date.now() / 1000);
  const result = await stripeService.syncStripeSubscription({
    id: 'sub_canceled_able73', status: 'canceled', customer: 'cus_test_able73',
    cancel_at_period_end: true,
    metadata: {
      ownerId: String(ownerId), establishmentId: String(establishmentId),
      planCode: 'MAP_MONTHLY',
    },
    items: { data: [{ current_period_start: now - 2592000, current_period_end: now }] },
  });

  assert.equal(result.activo, false);
  assert.equal(written.status, 'expired');
  assert.equal(written.paymentStatus, 'canceled');
  assert.equal(written.autoRenew, false);
  assert.ok(written.retiredAt instanceof Date);
});

test('the Stripe webhook rejects bad signatures and accepts the exact raw payload', async (t) => {
  const previousKey = process.env.STRIPE_SECRET_KEY;
  const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_SECRET_KEY = 'sk_test_webhook';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_able73';
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  stripeService.setStripeClientForTests(stripe);
  t.after(() => {
    if (previousKey == null) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousKey;
    if (previousSecret == null) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
    stripeService.setStripeClientForTests(null);
  });

  const app = express();
  app.use('/webhook', stripeWebhook);
  app.use(express.json());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/webhook`;
  const payload = JSON.stringify({
    id: 'evt_test_able73', object: 'event', type: 'ping', data: { object: {} },
  });
  const signature = stripe.webhooks.generateTestHeaderString({
    payload, secret: process.env.STRIPE_WEBHOOK_SECRET,
  });

  const invalid = await fetch(base, {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 'bad' },
    body: payload,
  });
  assert.equal(invalid.status, 400);

  const valid = await fetch(base, {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body: payload,
  });
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { received: true });
});
