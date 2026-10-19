const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const User = require('../api/models/User');
const Establishment = require('../api/models/Establishment');
const PromocionComprada = require('../api/models/PromocionComprada');
const MapPromotionPurchase = require('../api/models/MapPromotionPurchase');
const Payment = require('../api/models/Payment');
const appleAppStore = require('../api/services/appleAppStore');
const googlePlayBilling = require('../api/services/googlePlayBilling');
const mapPurchaseService = require('../api/services/mapStorePurchaseService');
const {
  entitlementPeriod,
  mapStoreProduct,
} = require('../api/services/mapStoreProducts');
const commercialRouter = require('../api/routes/commercial');

function query(value) {
  return {
    select() { return this; },
    lean: async () => value,
  };
}

test('fixed map products extend from the active expiration', () => {
  const monthly = mapStoreProduct('promo_local_monthly');
  const yearly = mapStoreProduct('promo_local_yearly');
  assert.equal(monthly.durationDays, 30);
  assert.equal(monthly.priceEuros, 9.99);
  assert.equal(yearly.durationMonths, 12);
  assert.equal(yearly.priceEuros, 65);

  const now = new Date('2026-10-20T00:00:00.000Z');
  const activeEnd = new Date('2026-11-01T00:00:00.000Z');
  const extension = entitlementPeriod(monthly, activeEnd, now);
  assert.equal(extension.start.toISOString(), activeEnd.toISOString());
  assert.equal(extension.end.toISOString(), '2026-12-01T00:00:00.000Z');
});

test('verified purchases extend an active promotion and retries are idempotent', async (t) => {
  const originals = {
    startSession: mongoose.startSession,
    purchaseFindOne: MapPromotionPurchase.findOne,
    purchaseCreate: MapPromotionPurchase.create,
    paymentCreate: Payment.create,
    paymentUpdateOne: Payment.updateOne,
    promotionFindOne: PromocionComprada.findOne,
    promotionFindOneAndUpdate: PromocionComprada.findOneAndUpdate,
    promotionFindById: PromocionComprada.findById,
  };
  t.after(() => {
    mongoose.startSession = originals.startSession;
    MapPromotionPurchase.findOne = originals.purchaseFindOne;
    MapPromotionPurchase.create = originals.purchaseCreate;
    Payment.create = originals.paymentCreate;
    Payment.updateOne = originals.paymentUpdateOne;
    PromocionComprada.findOne = originals.promotionFindOne;
    PromocionComprada.findOneAndUpdate = originals.promotionFindOneAndUpdate;
    PromocionComprada.findById = originals.promotionFindById;
  });

  const ownerId = new mongoose.Types.ObjectId();
  const locationId = new mongoose.Types.ObjectId();
  const subscriptionId = new mongoose.Types.ObjectId();
  const currentEnd = new Date(Date.now() + 10 * 86400000);
  let savedPurchase = null;
  let savedSubscription = null;
  let paymentCreates = 0;
  mongoose.startSession = async () => ({
    async withTransaction(callback) { await callback(); },
    async endSession() {},
  });
  MapPromotionPurchase.findOne = () => ({
    session: async () => savedPurchase,
  });
  PromocionComprada.findOne = () => ({
    session: async () => ({
      _id: subscriptionId,
      activo: true,
      fechaInicio: new Date('2026-01-01T00:00:00.000Z'),
      fechaFin: currentEnd,
    }),
  });
  Payment.create = async ([value]) => {
    paymentCreates += 1;
    return [{ _id: new mongoose.Types.ObjectId(), ...value }];
  };
  PromocionComprada.findOneAndUpdate = async (_filter, update) => {
    savedSubscription = { _id: subscriptionId, ...update.$set };
    return savedSubscription;
  };
  MapPromotionPurchase.create = async ([value]) => {
    savedPurchase = { _id: new mongoose.Types.ObjectId(), ...value };
    return [savedPurchase];
  };
  Payment.updateOne = async () => ({ acknowledged: true });
  PromocionComprada.findById = () => ({
    session: async () => savedSubscription,
  });

  const input = {
    owner: { _id: ownerId, email: 'owner@example.test' },
    location: {
      _id: locationId,
      publicName: 'Local idempotente',
      address: 'Calle Test',
      logoUrl: '/logo.png',
      lat: 41.65,
      lng: -0.88,
    },
    product: mapStoreProduct('promo_local_monthly'),
    provider: 'google_play',
    providerReference: 'google-play:idempotent-token',
    purchaseToken: 'idempotent-token',
  };
  const first = await mapPurchaseService.applyVerifiedMapPurchase(input);
  const retry = await mapPurchaseService.applyVerifiedMapPurchase(input);

  assert.equal(first.duplicate, false);
  assert.equal(retry.duplicate, true);
  assert.equal(paymentCreates, 1);
  assert.equal(
    new Date(first.subscription.fechaFin).getTime(),
    currentEnd.getTime() + 30 * 86400000,
  );
});

test('a store refund removes its exact period only once', async (t) => {
  const originals = {
    startSession: mongoose.startSession,
    purchaseFindOne: MapPromotionPurchase.findOne,
    paymentUpdateOne: Payment.updateOne,
    promotionFindById: PromocionComprada.findById,
  };
  t.after(() => {
    mongoose.startSession = originals.startSession;
    MapPromotionPurchase.findOne = originals.purchaseFindOne;
    Payment.updateOne = originals.paymentUpdateOne;
    PromocionComprada.findById = originals.promotionFindById;
  });

  const originalEnd = new Date('2027-12-31T00:00:00.000Z');
  const subscription = {
    fechaFin: originalEnd,
    activo: true,
    status: 'published',
    async save() {},
  };
  const purchase = {
    status: 'confirmed',
    durationDays: 30,
    paymentId: new mongoose.Types.ObjectId(),
    mapSubscriptionId: new mongoose.Types.ObjectId(),
    async save() {},
  };
  const paymentUpdates = [];
  mongoose.startSession = async () => ({
    async withTransaction(callback) { await callback(); },
    async endSession() {},
  });
  MapPromotionPurchase.findOne = () => ({ session: async () => purchase });
  Payment.updateOne = async (...args) => paymentUpdates.push(args);
  PromocionComprada.findById = () => ({
    session: async () => subscription,
  });

  const first = await mapPurchaseService.revokeMapPurchase(
    'google-play:refunded-token',
    'refunded',
  );
  const retry = await mapPurchaseService.revokeMapPurchase(
    'google-play:refunded-token',
    'refunded',
  );

  assert.equal(first.changed, true);
  assert.equal(retry.changed, false);
  assert.equal(purchase.status, 'refunded');
  assert.equal(
    new Date(subscription.fechaFin).getTime(),
    originalEnd.getTime() - 30 * 86400000,
  );
  assert.equal(paymentUpdates.length, 1);
  assert.equal(paymentUpdates[0][1].$set.status, 'refunded');
});

test('App Store and Google Play purchases are verified before map activation', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'map-store-purchase-test-secret';
  const originals = {
    userFindById: User.findById,
    establishmentFindOne: Establishment.findOne,
    promotionFindOne: PromocionComprada.findOne,
    appleAvailable: appleAppStore.appStoreVerificationAvailable,
    appleVerify: appleAppStore.verifyAppStoreTransaction,
    appleValidate: appleAppStore.validateAppStoreTransaction,
    playAvailable: googlePlayBilling.playBillingAvailable,
    playGet: googlePlayBilling.getProductPurchase,
    playConsume: googlePlayBilling.consumeProductPurchase,
    apply: mapPurchaseService.applyVerifiedMapPurchase,
  };
  t.after(() => {
    if (previousSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    User.findById = originals.userFindById;
    Establishment.findOne = originals.establishmentFindOne;
    PromocionComprada.findOne = originals.promotionFindOne;
    appleAppStore.appStoreVerificationAvailable = originals.appleAvailable;
    appleAppStore.verifyAppStoreTransaction = originals.appleVerify;
    appleAppStore.validateAppStoreTransaction = originals.appleValidate;
    googlePlayBilling.playBillingAvailable = originals.playAvailable;
    googlePlayBilling.getProductPurchase = originals.playGet;
    googlePlayBilling.consumeProductPurchase = originals.playConsume;
    mapPurchaseService.applyVerifiedMapPurchase = originals.apply;
  });

  const ownerId = new mongoose.Types.ObjectId();
  const locationId = new mongoose.Types.ObjectId();
  const owner = {
    _id: ownerId, role: 'comercio', email: 'store@example.test', nickname: 'Store',
    firebaseUid: null,
  };
  const location = {
    _id: locationId, ownerId, status: 'approved', publicName: 'Local Store',
    address: 'Calle Store', logoUrl: '/logo.png', lat: 41.65, lng: -0.88,
  };
  User.findById = () => query(owner);
  Establishment.findOne = async () => location;
  let legacySubscription = null;
  PromocionComprada.findOne = () => ({
    select: async () => legacySubscription,
  });
  appleAppStore.appStoreVerificationAvailable = () => true;
  appleAppStore.verifyAppStoreTransaction = async () => ({
    environment: 'Sandbox',
    transaction: { transactionId: '200000123', productId: 'promo_local_monthly' },
  });
  appleAppStore.validateAppStoreTransaction = () => '200000123';
  googlePlayBilling.playBillingAvailable = () => true;
  googlePlayBilling.getProductPurchase = async () => ({
    purchaseState: 0, orderId: 'GPA.1234', consumptionState: 0,
  });
  const consumed = [];
  googlePlayBilling.consumeProductPurchase = async (...args) => consumed.push(args);
  const applied = [];
  mapPurchaseService.applyVerifiedMapPurchase = async (value) => {
    applied.push(value);
    return {
      duplicate: false,
      subscription: { activo: true, fechaFin: new Date('2026-11-19T00:00:00Z') },
    };
  };

  const app = express();
  app.use(express.json());
  app.use('/api/commercial', commercialRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/commercial/locations/${locationId}`;
  const token = jwt.sign({ id: String(ownerId), legacy: true }, process.env.JWT_SECRET);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const ios = await fetch(`${base}/verify-store-purchase`, {
    method: 'POST', headers,
    body: JSON.stringify({
      platform: 'ios', productId: 'promo_local_monthly',
      purchaseId: '200000123', verificationData: 'signed-ios-transaction',
    }),
  });
  assert.equal(ios.status, 201, (await ios.clone().json()).error);
  assert.equal(applied[0].provider, 'app_store');
  assert.equal(applied[0].providerReference, 'app-store:200000123');

  const android = await fetch(`${base}/verify-store-purchase`, {
    method: 'POST', headers,
    body: JSON.stringify({
      platform: 'android', productId: 'promo_local_yearly',
      purchaseId: 'GPA.1234', verificationData: 'play-purchase-token',
    }),
  });
  assert.equal(android.status, 201, (await android.clone().json()).error);
  assert.equal(applied[1].provider, 'google_play');
  assert.equal(applied[1].providerReference, 'google-play:play-purchase-token');
  assert.deepEqual(consumed, [['promo_local_yearly', 'play-purchase-token']]);

  legacySubscription = {
    stripeSubscriptionId: 'sub_legacy_active',
    stripeSubscriptionStatus: 'active',
  };
  const blocked = await fetch(`${base}/verify-store-purchase`, {
    method: 'POST', headers,
    body: JSON.stringify({
      platform: 'ios', productId: 'promo_local_monthly',
      purchaseId: '200000124', verificationData: 'another-signed-transaction',
    }),
  });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).code, 'LEGACY_SUBSCRIPTION_ACTIVE');
  assert.equal(applied.length, 2);
});

test('store refund notifications revoke the matching fixed promotion once', async (t) => {
  const previousToken = process.env.GOOGLE_PLAY_RTDN_TOKEN;
  process.env.GOOGLE_PLAY_RTDN_TOKEN = 'rtdn-test-token';
  const originals = {
    appleNotification: appleAppStore.verifyAppStoreNotification,
    appleTransaction: appleAppStore.verifyAppStoreTransaction,
    revoke: mapPurchaseService.revokeMapPurchase,
  };
  t.after(() => {
    if (previousToken == null) delete process.env.GOOGLE_PLAY_RTDN_TOKEN;
    else process.env.GOOGLE_PLAY_RTDN_TOKEN = previousToken;
    appleAppStore.verifyAppStoreNotification = originals.appleNotification;
    appleAppStore.verifyAppStoreTransaction = originals.appleTransaction;
    mapPurchaseService.revokeMapPurchase = originals.revoke;
  });
  appleAppStore.verifyAppStoreNotification = async () => ({
    notificationType: 'REFUND',
    data: { signedTransactionInfo: 'signed-refunded-transaction' },
  });
  appleAppStore.verifyAppStoreTransaction = async () => ({
    transaction: { transactionId: '200000999', revocationDate: Date.now() },
  });
  const revoked = [];
  mapPurchaseService.revokeMapPurchase = async (...args) => revoked.push(args);

  const app = express();
  app.use(express.json());
  app.use('/api/commercial', commercialRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/commercial/store-notifications`;

  const apple = await fetch(`${base}/apple`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signedPayload: 'signed-notification' }),
  });
  assert.equal(apple.status, 200);

  const data = Buffer.from(JSON.stringify({
    packageName: googlePlayBilling.packageName,
    voidedPurchaseNotification: {
      purchaseToken: 'refunded-play-token',
      productType: 2,
      refundType: 1,
    },
  })).toString('base64');
  const google = await fetch(`${base}/google?token=rtdn-test-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: { data } }),
  });
  assert.equal(google.status, 200);
  assert.deepEqual(revoked, [
    ['app-store:200000999', 'refunded'],
    ['google-play:refunded-play-token', 'refunded'],
  ]);
});
