const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const User = require('../api/models/User');
const Payment = require('../api/models/Payment');
const paymentsRouter = require('../api/routes/payments');

test('Stepcoin checkout credits once and records the server-side EUR price', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'stepcoin-checkout-test-secret';
  const originals = {
    startSession: mongoose.startSession,
    userFindById: User.findById,
    userFindOneAndUpdate: User.findOneAndUpdate,
    paymentFindOne: Payment.findOne,
    paymentCreate: Payment.create,
  };
  t.after(() => {
    if (previousSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    mongoose.startSession = originals.startSession;
    User.findById = originals.userFindById;
    User.findOneAndUpdate = originals.userFindOneAndUpdate;
    Payment.findOne = originals.paymentFindOne;
    Payment.create = originals.paymentCreate;
  });

  const userId = new mongoose.Types.ObjectId();
  let balance = 1000;
  let increments = 0;
  let storedPayment = null;
  mongoose.startSession = async () => ({
    async withTransaction(callback) { return callback(); },
    async endSession() {},
  });
  User.findById = () => {
    const query = {
      select() { return this; },
      session: async () => ({ stepcoins: balance }),
      lean: async () => ({
        _id: userId, role: 'cliente', email: 'buyer@example.test', firebaseUid: null,
      }),
    };
    return query;
  };
  User.findOneAndUpdate = (_filter, update) => ({
    select: async () => {
      increments += 1;
      balance += update.$inc.stepcoins;
      return { stepcoins: balance, nickname: 'Buyer', email: 'buyer@example.test' };
    },
  });
  Payment.findOne = () => ({ session: async () => storedPayment });
  Payment.create = async ([value]) => {
    storedPayment = { _id: new mongoose.Types.ObjectId(), ...value };
    return [storedPayment];
  };

  const app = express();
  app.use(express.json());
  app.use('/api/payments', paymentsRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const token = jwt.sign({ id: String(userId), legacy: true }, process.env.JWT_SECRET);
  const call = () => fetch(
    `http://127.0.0.1:${server.address().port}/api/payments/stepcoins/checkout`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cantidad: 500, requestId: 'purchase-test-001' }),
    },
  );

  const first = await call();
  const firstBody = await first.json();
  assert.equal(first.status, 201, firstBody.error);
  assert.equal(firstBody.user.stepcoins, 1500);
  assert.equal(storedPayment.cantidad, 4);
  assert.equal(storedPayment.currency, 'EUR');
  assert.equal(storedPayment.verified, true);
  assert.equal(storedPayment.source, 'platform_checkout');
  assert.match(storedPayment.motivo, /500 Stepcoins/);

  const retry = await call();
  const retryBody = await retry.json();
  assert.equal(retry.status, 200, retryBody.error);
  assert.equal(retryBody.duplicate, true);
  assert.equal(retryBody.user.stepcoins, 1500);
  assert.equal(increments, 1);
});

test('Stepcoin checkout rejects unauthenticated and non-catalog purchases', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'stepcoin-checkout-auth-test-secret';
  const originalFindById = User.findById;
  const userId = new mongoose.Types.ObjectId();
  User.findById = () => ({
    select() { return this; },
    lean: async () => ({
      _id: userId, role: 'cliente', email: 'buyer@example.test', firebaseUid: null,
    }),
  });
  t.after(() => {
    if (previousSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    User.findById = originalFindById;
  });

  const app = express();
  app.use(express.json());
  app.use('/api/payments', paymentsRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/payments/stepcoins/checkout`;

  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  const token = jwt.sign({ id: String(userId), legacy: true }, process.env.JWT_SECRET);
  const invalid = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ cantidad: 999999, requestId: 'purchase-test-002' }),
  });
  assert.equal(invalid.status, 400);
});
