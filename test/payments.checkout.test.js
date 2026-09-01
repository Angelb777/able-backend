const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const User = require('../api/models/User');
const Payment = require('../api/models/Payment');
const StepcoinTransaction = require('../api/models/StepcoinTransaction');
const paymentsRouter = require('../api/routes/payments');

test('web and Flutter Stepcoin stores use the same checkout route', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dashboard = fs.readFileSync(path.join(__dirname, '../public/js/dashboard.js'), 'utf8');
  const flutterStore = fs.readFileSync(
    path.join(__dirname, '../../ablee/lib/roles/client/store_screen.dart'),
    'utf8',
  );
  assert.match(dashboard, /fetch\("\/api\/payments\/stepcoins\/checkout"/);
  assert.match(flutterStore, /payments\/stepcoins\/checkout/);
  assert.doesNotMatch(
    dashboard,
    /classList\.contains\("boton-compra"\)[\s\S]{0,800}\/api\/stepcoins\/adjust/,
  );
});

test('client dashboard bootstrap does not depend on Google Maps being ready', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../public/js/dashboard.js'),
    'utf8',
  );
  assert.doesNotMatch(source, /^class\s+\w+\s+extends\s+google\.maps\.OverlayView/m);
  assert.match(source, /function getNegocioOverlayClass\(\)/);
  assert.match(source, /function getArrowOverlayClass\(\)/);
  assert.match(source, /user\._id = commercialId\(user\) \|\| userId/);
});

test('Stepcoin checkout credits once and records the server-side EUR price', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'stepcoin-checkout-test-secret';
  const originals = {
    startSession: mongoose.startSession,
    userFindById: User.findById,
    userFindOneAndUpdate: User.findOneAndUpdate,
    paymentFindOne: Payment.findOne,
    paymentCreate: Payment.create,
    transactionCreate: StepcoinTransaction.create,
  };
  t.after(() => {
    if (previousSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
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
  let storedPayment = null;
  let storedTransaction = null;
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
  StepcoinTransaction.create = async ([value]) => {
    storedTransaction = { _id: new mongoose.Types.ObjectId(), ...value };
    return [storedTransaction];
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
  assert.equal(storedPayment.stepcoinsDelta, 500);
  assert.match(storedPayment.motivo, /500 Stepcoins/);
  assert.equal(storedTransaction.cantidad, 500);
  assert.equal(storedTransaction.metadata.paymentId, storedPayment._id);

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

test('payment history contains only monetary Payment records', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'combined-payment-history-test-secret';
  const userId = new mongoose.Types.ObjectId();
  const originals = {
    userFindById: User.findById,
    paymentFind: Payment.find,
  };
  User.findById = () => ({
    select() { return this; },
    lean: async () => ({
      _id: userId, role: 'cliente', email: 'buyer@example.test', firebaseUid: null,
    }),
  });
  Payment.find = () => ({
    lean: async () => [{
      _id: 'payment-1', userId, nombre: 'Buyer', cantidad: 4,
      currency: 'EUR', motivo: 'Compra de 500 Stepcoins', stepcoinsDelta: 500,
      fecha: new Date('2026-09-01T10:00:00Z'),
    }],
  });
  t.after(() => {
    if (previousSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    User.findById = originals.userFindById;
    Payment.find = originals.paymentFind;
  });

  const app = express();
  app.use('/api/payments', paymentsRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const token = jwt.sign({ id: String(userId), legacy: true }, process.env.JWT_SECRET);
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/payments/${userId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assert.equal(response.status, 200);
  const history = await response.json();
  assert.equal(history.length, 1);
  assert.equal(history[0].entryType, 'money');
  assert.equal(history[0].cantidad, 4);
  assert.equal(history[0].stepcoinsDelta, 500);
});
