const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Payment = require('../api/models/Payment');
const StepcoinTransaction = require('../api/models/StepcoinTransaction');
const User = require('../api/models/User');
const stripeMap = require('../api/services/stripeMapSubscriptions');
const stripeStepcoins = require('../api/services/stripeStepcoinPurchases');

test('Stripe Stepcoin Checkout uses the authoritative price and idempotency key', async (t) => {
  const previousKey = process.env.STRIPE_SECRET_KEY;
  const previousBase = process.env.APP_BASE_URL;
  process.env.STRIPE_SECRET_KEY = 'sk_test_stepcoins';
  process.env.APP_BASE_URL = 'https://able73.com';
  let request;
  let options;
  stripeMap.setStripeClientForTests({
    checkout: {
      sessions: {
        create: async (body, config) => {
          request = body;
          options = config;
          return { id: 'cs_test_stepcoins', url: 'https://checkout.stripe.com/test' };
        },
      },
    },
  });
  t.after(() => {
    if (previousKey == null) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousKey;
    if (previousBase == null) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previousBase;
    stripeMap.setStripeClientForTests(null);
  });

  const result = await stripeStepcoins.createStripeStepcoinCheckout({
    req: {},
    userId: new mongoose.Types.ObjectId(),
    role: 'cliente',
    email: 'buyer@example.test',
    cantidad: 500,
    requestId: 'ios-purchase-001',
  });

  assert.equal(result.sessionId, 'cs_test_stepcoins');
  assert.equal(request.mode, 'payment');
  assert.equal(request.line_items[0].price_data.unit_amount, 400);
  assert.equal(request.line_items[0].price_data.currency, 'eur');
  assert.equal(request.metadata.purchaseType, 'stepcoins');
  assert.equal(request.metadata.stepcoins, '500');
  assert.match(request.success_url, /stripe-stepcoins-return\.html\?result=success$/);
  assert.match(options.idempotencyKey, /^stepcoins:/);
});

test('web Stripe Checkout returns to the dashboard without changing the mobile return flow', async (t) => {
  const previousKey = process.env.STRIPE_SECRET_KEY;
  const previousBase = process.env.APP_BASE_URL;
  process.env.STRIPE_SECRET_KEY = 'sk_test_stepcoins_web';
  process.env.APP_BASE_URL = 'https://able73.com';
  const requests = [];
  stripeMap.setStripeClientForTests({
    checkout: {
      sessions: {
        create: async (body) => {
          requests.push(body);
          return { id: `cs_test_${requests.length}`, url: 'https://checkout.stripe.com/test' };
        },
      },
    },
  });
  t.after(() => {
    if (previousKey == null) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousKey;
    if (previousBase == null) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previousBase;
    stripeMap.setStripeClientForTests(null);
  });

  const base = {
    req: {}, userId: new mongoose.Types.ObjectId(), role: 'cliente',
    email: 'buyer@example.test', cantidad: 500,
  };
  await stripeStepcoins.createStripeStepcoinCheckout({
    ...base, requestId: 'web-purchase-001', channel: 'web',
  });
  await stripeStepcoins.createStripeStepcoinCheckout({
    ...base, requestId: 'mobile-purchase-001', channel: 'mobile',
  });

  assert.match(requests[0].success_url, /dashboard\.html\?stripe_stepcoins=success/);
  assert.match(requests[0].success_url, /session_id=\{CHECKOUT_SESSION_ID\}$/);
  assert.match(requests[0].cancel_url, /dashboard\.html\?stripe_stepcoins=cancelled$/);
  assert.equal(requests[0].metadata.checkoutChannel, 'web');
  assert.match(requests[1].success_url, /stripe-stepcoins-return\.html\?result=success$/);
  assert.match(requests[1].cancel_url, /stripe-stepcoins-return\.html\?result=cancelled$/);
  assert.equal(requests[1].metadata.checkoutChannel, 'mobile');
});

test('a paid Stripe Checkout credits Stepcoins exactly once', async (t) => {
  const originals = {
    startSession: mongoose.startSession,
    userFindById: User.findById,
    userFindOneAndUpdate: User.findOneAndUpdate,
    paymentFindOne: Payment.findOne,
    paymentCreate: Payment.create,
    transactionCreate: StepcoinTransaction.create,
  };
  t.after(() => {
    mongoose.startSession = originals.startSession;
    User.findById = originals.userFindById;
    User.findOneAndUpdate = originals.userFindOneAndUpdate;
    Payment.findOne = originals.paymentFindOne;
    Payment.create = originals.paymentCreate;
    StepcoinTransaction.create = originals.transactionCreate;
  });

  const userId = new mongoose.Types.ObjectId();
  let balance = 1000;
  let increments = 0;
  let storedPayment;
  let storedTransaction;
  mongoose.startSession = async () => ({
    async withTransaction(callback) { return callback(); },
    async endSession() {},
  });
  User.findById = () => ({
    select() { return this; },
    lean: async () => ({
      _id: userId, role: 'cliente', stepcoins: balance,
      nickname: 'Buyer', email: 'buyer@example.test',
    }),
    session: async () => ({ _id: userId, stepcoins: balance }),
  });
  User.findOneAndUpdate = (_filter, update) => ({
    select: async () => {
      increments += 1;
      balance += update.$inc.stepcoins;
      return { _id: userId, stepcoins: balance, nickname: 'Buyer' };
    },
  });
  Payment.findOne = () => ({ session: async () => storedPayment || null });
  Payment.create = async ([value]) => {
    storedPayment = { _id: new mongoose.Types.ObjectId(), ...value };
    return [storedPayment];
  };
  StepcoinTransaction.create = async ([value]) => {
    storedTransaction = value;
    return [{ _id: new mongoose.Types.ObjectId(), ...value }];
  };

  const checkout = {
    id: 'cs_live_stepcoins_001',
    mode: 'payment',
    payment_status: 'paid',
    amount_total: 400,
    currency: 'eur',
    payment_intent: 'pi_live_stepcoins_001',
    metadata: {
      purchaseType: 'stepcoins',
      userId: String(userId),
      stepcoins: '500',
      checkoutChannel: 'web',
    },
  };

  const first = await stripeStepcoins.fulfillStripeStepcoinCheckout(checkout);
  const retry = await stripeStepcoins.fulfillStripeStepcoinCheckout(checkout);
  assert.equal(first.paid, true);
  assert.equal(first.user.stepcoins, 1500);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.user.stepcoins, 1500);
  assert.equal(increments, 1);
  assert.equal(storedPayment.source, 'payment_provider');
  assert.equal(storedPayment.providerReference, 'stripe:checkout:cs_live_stepcoins_001');
  assert.match(storedPayment.motivo, /Stripe web/);
  assert.equal(storedTransaction.metadata.stripePaymentIntentId, 'pi_live_stepcoins_001');
});

test('Stripe refuses to credit a paid session with a manipulated amount', async (t) => {
  const originalFindById = User.findById;
  const userId = new mongoose.Types.ObjectId();
  User.findById = () => ({
    select() { return this; },
    lean: async () => ({ _id: userId, role: 'cliente', stepcoins: 0 }),
  });
  t.after(() => { User.findById = originalFindById; });

  await assert.rejects(
    stripeStepcoins.fulfillStripeStepcoinCheckout({
      id: 'cs_live_tampered',
      mode: 'payment',
      payment_status: 'paid',
      amount_total: 1,
      currency: 'eur',
      metadata: {
        purchaseType: 'stepcoins', userId: String(userId), stepcoins: '500',
      },
    }),
    /importe.*no coincide/i,
  );
});
