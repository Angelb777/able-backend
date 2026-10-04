const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const User = require('../api/models/User');
const Payment = require('../api/models/Payment');
const StepcoinTransaction = require('../api/models/StepcoinTransaction');
const appleAppStore = require('../api/services/appleAppStore');
const paymentsRouter = require('../api/routes/payments');

test('App Store transaction validation accepts Sandbox and rejects tampering or revocation', () => {
  const base = {
    transactionId: '2000001234567890',
    bundleId: 'com.able73.app',
    productId: 'stepcoins_100',
    type: 'Consumable',
    quantity: 1,
    environment: 'Sandbox',
  };
  const request = { productId: 'stepcoins_100', purchaseID: base.transactionId };

  assert.equal(
    appleAppStore.validateAppStoreTransaction(base, request),
    base.transactionId,
  );
  assert.equal(
    appleAppStore.validateAppStoreTransaction(
      { ...base, environment: 'Production' },
      request,
    ),
    base.transactionId,
  );
  assert.throws(() => appleAppStore.validateAppStoreTransaction(
    { ...base, productId: 'stepcoins_1000' },
    request,
  ));
  assert.throws(() => appleAppStore.validateAppStoreTransaction(
    { ...base, revocationDate: Date.now() },
    request,
  ));
  assert.throws(() => appleAppStore.validateAppStoreTransaction(base, {
    ...request,
    purchaseID: '2000009999999999',
  }));
});

test('App Store purchase credits an expanded package once and stores Apple idempotency keys', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'app-store-purchase-test-secret';
  const originals = {
    available: appleAppStore.appStoreVerificationAvailable,
    verify: appleAppStore.verifyAppStoreTransaction,
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
    appleAppStore.appStoreVerificationAvailable = originals.available;
    appleAppStore.verifyAppStoreTransaction = originals.verify;
    mongoose.startSession = originals.startSession;
    User.findById = originals.userFindById;
    User.findOneAndUpdate = originals.userFindOneAndUpdate;
    Payment.findOne = originals.paymentFindOne;
    Payment.create = originals.paymentCreate;
    StepcoinTransaction.create = originals.transactionCreate;
  });

  const userId = new mongoose.Types.ObjectId();
  const transactionId = '2000001234567890';
  let balance = 25;
  let increments = 0;
  let storedPayment = null;
  let storedTransaction = null;

  appleAppStore.appStoreVerificationAvailable = () => true;
  appleAppStore.verifyAppStoreTransaction = async () => ({
    environment: 'Sandbox',
    transaction: {
      transactionId,
      bundleId: 'com.able73.app',
      productId: 'stepcoins_100000',
      type: 'Consumable',
      quantity: 1,
      environment: 'Sandbox',
    },
  });
  mongoose.startSession = async () => ({
    async withTransaction(callback) { return callback(); },
    async endSession() {},
  });
  User.findById = () => ({
    select() { return this; },
    session: async () => ({ stepcoins: balance }),
    lean: async () => ({
      _id: userId,
      role: 'cliente',
      email: 'ios-buyer@example.test',
      firebaseUid: null,
    }),
  });
  User.findOneAndUpdate = (_filter, update) => ({
    select: async () => {
      increments += 1;
      balance += update.$inc.stepcoins;
      return { stepcoins: balance, nickname: 'iOS Buyer' };
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
    `http://127.0.0.1:${server.address().port}/api/payments/stepcoins/verify-app-store-purchase`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: 'stepcoins_100000',
        purchaseID: transactionId,
        verificationData: 'signed-jws-for-test',
        cantidad: 999999,
      }),
    },
  );

  const first = await call();
  const firstBody = await first.json();
  assert.equal(first.status, 201, firstBody.error);
  assert.equal(firstBody.user.stepcoins, 100025);
  assert.equal(increments, 1);
  assert.equal(storedPayment.stepcoinsDelta, 100000);
  assert.equal(storedPayment.providerReference, `app-store:${transactionId}`);
  assert.equal(
    storedTransaction.operationKey,
    `stepcoin-pack:app-store:${transactionId}`,
  );

  const retry = await call();
  const retryBody = await retry.json();
  assert.equal(retry.status, 200, retryBody.error);
  assert.equal(retryBody.duplicate, true);
  assert.equal(retryBody.user.stepcoins, 100025);
  assert.equal(increments, 1);
});
