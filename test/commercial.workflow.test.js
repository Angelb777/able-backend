const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../api/models/User');

const commercialRouter = require('../api/routes/commercial');
const legacyPositioningRouter = require('../api/routes/promoContratada');
const positioningPackagesRouter = require('../api/routes/promocionesNegocio');
const rewardsRouter = require('../api/routes/rewards');
const CommercialRequest = require('../api/models/CommercialRequest');
const Establishment = require('../api/models/Establishment');
const PromocionComprada = require('../api/models/PromocionComprada');
const Payment = require('../api/models/Payment');
const StepcoinTransaction = require('../api/models/StepcoinTransaction');
const MapPlan = require('../api/models/MapPlan');
const MapPromoCode = require('../api/models/MapPromoCode');
const {
  fixedPrice, pendingStatus, assertCanApprove, addOneYear, recordTransition,
} = require('../api/services/commercialWorkflow');
const {
  MIN_COMMERCIAL_REWARD_STEPCOINS,
  assertCommercialRewardStepcoins,
} = require('../api/services/rewardPolicy');

test('commercial rewards require at least 5,000 Stepcoins', () => {
  assert.equal(MIN_COMMERCIAL_REWARD_STEPCOINS, 5000);
  assert.equal(assertCommercialRewardStepcoins('5000'), 5000);
  assert.throws(() => assertCommercialRewardStepcoins(4999), /5000/);
  assert.throws(() => assertCommercialRewardStepcoins('invalid'), /mínimo/i);
});

test('commercial request endpoint rejects rewards below 5,000 Stepcoins', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  const originalUserFindById = User.findById;
  const originalEstablishmentFindOne = Establishment.findOne;
  process.env.JWT_SECRET = 'commercial-reward-minimum-secret';

  User.findById = () => ({
    select() { return this; },
    lean: async () => ({ _id: 'commerce', role: 'comercio', firebaseUid: null }),
  });
  Establishment.findOne = async () => ({
    _id: new mongoose.Types.ObjectId(),
    ownerId: 'commerce',
    address: 'Calle Able 73',
  });

  const app = express();
  app.use(express.json());
  app.use('/api/commercial', commercialRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (previousSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    User.findById = originalUserFindById;
    Establishment.findOne = originalEstablishmentFindOne;
    await new Promise((resolve) => server.close(resolve));
  });

  const token = jwt.sign({ id: 'commerce' }, process.env.JWT_SECRET);
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/commercial/requests`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'reward',
        subtype: 'discount',
        title: 'Descuento demasiado barato',
        formData: { stepcoins: 4999, percentage: 10 },
      }),
    },
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.match(body.error, /5000/);
});

test('commercial prices are fixed by Able73 and payment is never inferred', () => {
  assert.equal(fixedPrice('commercial_skin'), 500);
  assert.equal(fixedPrice('commercial_weapon', 'short'), 250);
  assert.equal(fixedPrice('commercial_weapon', 'medium'), 350);
  assert.equal(fixedPrice('commercial_weapon', 'long'), 450);
  assert.equal(fixedPrice('reward', 'discount'), 0);
  assert.throws(() => fixedPrice('commercial_weapon', 'ultra'));

  const request = {
    type: 'commercial_skin', paymentStatus: 'pending', materials: [{ url: '/material.png' }],
  };
  assert.equal(pendingStatus(request), 'pending_payment');
  assert.throws(() => assertCanApprove(request), /pago/i);
  request.paymentStatus = 'confirmed';
  assert.equal(pendingStatus(request), 'pending_review');
  assert.doesNotThrow(() => assertCanApprove(request));
});

test('material, state revision and annual review are deterministic', () => {
  const withoutMaterial = {
    type: 'commercial_weapon', paymentStatus: 'confirmed', materials: [], status: 'pending_payment',
    history: [], revision: 1,
  };
  assert.equal(pendingStatus(withoutMaterial), 'pending_material');
  assert.throws(() => assertCanApprove(withoutMaterial), /material/i);
  recordTransition(withoutMaterial, {
    action: 'material_uploaded', status: 'pending_review', actorRole: 'comercio',
  });
  assert.equal(withoutMaterial.status, 'pending_review');
  assert.equal(withoutMaterial.revision, 2);
  assert.equal(withoutMaterial.history.length, 1);

  const publishedAt = new Date('2026-08-10T12:00:00.000Z');
  assert.equal(addOneYear(publishedAt).toISOString(), '2027-08-10T12:00:00.000Z');
});

test('CommercialRequest validates workflow enums and normalizes id', async () => {
  const request = new CommercialRequest({
    ownerId: '507f1f77bcf86cd799439011',
    type: 'commercial_weapon', subtype: 'short', title: 'Arma comercio',
    price: 250, paymentStatus: 'pending', status: 'pending_payment',
  });
  assert.equal(request.validateSync(), undefined);
  assert.equal(request.toJSON().id, String(request._id));

  request.paymentStatus = 'paid-by-client';
  assert.match(request.validateSync().message, /paymentStatus/);
  request.paymentStatus = 'pending';
  request.status = 'expired';
  assert.equal(request.validateSync(), undefined);
});

test('commercial and legacy positioning endpoints enforce role boundaries', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  const originalFindById = User.findById;
  process.env.JWT_SECRET = 'commercial-route-test-secret';
  const token = (role) => jwt.sign({
    id: role, role: 'manipulated-client-claim',
  }, process.env.JWT_SECRET);
  User.findById = (id) => ({
    select() { return this; },
    lean: async () => ({ _id: id, role: String(id), email: `${id}@test`, firebaseUid: null }),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/commercial', commercialRouter);
  app.use('/api/promo-contratada', legacyPositioningRouter);
  app.use('/api/promociones-negocio', positioningPackagesRouter);
  app.use('/api/rewards', rewardsRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    if (previousSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    User.findById = originalFindById;
    await new Promise((resolve) => server.close(resolve));
  });

  const call = (path, role, method = 'GET') => fetch(`${base}${path}`, {
    method,
    headers: role ? { Authorization: `Bearer ${token(role)}` } : {},
  });

  assert.equal((await call('/api/commercial/specifications')).status, 401);
  assert.equal((await call('/api/commercial/specifications', 'cliente')).status, 403);
  const specifications = await call('/api/commercial/specifications', 'comercio');
  assert.equal(specifications.status, 200);
  const body = await specifications.json();
  assert.equal(body.commercial_skin.price, 500);
  assert.deepEqual(body.commercial_weapon.tiers.map((item) => item.price), [250, 350, 450]);

  assert.equal((await call('/api/commercial/admin/requests', 'comercio')).status, 403);
  assert.equal((await call('/api/commercial/establishment', 'admin')).status, 403);
  assert.equal((await call('/api/promo-contratada', null, 'POST')).status, 401);
  assert.equal((await call('/api/promo-contratada', 'cliente', 'POST')).status, 403);
  assert.equal((await call('/api/promociones-negocio', 'comercio', 'POST')).status, 403);
  assert.equal((await call('/api/rewards', null, 'POST')).status, 401);
  assert.equal((await call('/api/rewards', 'cliente', 'POST')).status, 403);
  assert.equal((await call('/api/rewards/orden-catalogo', 'comercio', 'PATCH')).status, 403);
  assert.equal((await call('/api/rewards/orden-catalogo', 'admin', 'PATCH')).status, 400);
});

test('the legacy monetary positioning checkout is disabled', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'commercial-platform-payment-secret';
  const originals = {
    userFindById: User.findById,
    requestFindOne: CommercialRequest.findOne,
    establishmentFindOne: Establishment.findOne,
    positioningUpsert: PromocionComprada.findOneAndUpdate,
    paymentUpsert: Payment.findOneAndUpdate,
  };
  t.after(() => {
    if (previousSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    User.findById = originals.userFindById;
    CommercialRequest.findOne = originals.requestFindOne;
    Establishment.findOne = originals.establishmentFindOne;
    PromocionComprada.findOneAndUpdate = originals.positioningUpsert;
    Payment.findOneAndUpdate = originals.paymentUpsert;
  });

  const ownerId = new mongoose.Types.ObjectId();
  const requestId = new mongoose.Types.ObjectId();
  const establishmentId = new mongoose.Types.ObjectId();
  const packageId = new mongoose.Types.ObjectId();
  const publishedId = new mongoose.Types.ObjectId();
  const request = {
    _id: requestId,
    ownerId,
    establishmentId,
    type: 'positioning',
    title: 'Mapa local · 3 meses',
    price: 30,
    currency: 'EUR',
    status: 'pending_payment',
    paymentStatus: 'pending',
    paymentProvider: '',
    paymentReference: '',
    formData: {
      packageId, packageTitle: 'Mapa local', baseImageUrl: '/api/media/base',
      durationMonths: 3,
    },
    history: [],
    revision: 1,
    async save() {},
    toJSON() { return { ...this, id: String(this._id) }; },
  };
  const establishment = {
    _id: establishmentId, ownerId, status: 'approved', publicName: 'Local Able',
    logoUrl: '/api/media/logo', lat: 41.65, lng: -0.88,
  };
  let positioningUpdate;
  let paymentUpdate;
  let positioningWrites = 0;
  let paymentWrites = 0;
  User.findById = () => ({
    select() { return this; },
    lean: async () => ({
      _id: ownerId, role: 'comercio', firebaseUid: null,
      email: 'commerce@example.test', nickname: 'Commerce',
    }),
  });
  CommercialRequest.findOne = async () => request;
  Establishment.findOne = async () => establishment;
  PromocionComprada.findOneAndUpdate = async (_filter, update) => {
    positioningWrites += 1;
    positioningUpdate = update.$set;
    return { _id: publishedId, ...update.$set };
  };
  Payment.findOneAndUpdate = async (_filter, update) => {
    paymentWrites += 1;
    paymentUpdate = update.$setOnInsert;
    return paymentUpdate;
  };

  const app = express();
  app.use(express.json());
  app.use('/api/commercial', commercialRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const token = jwt.sign({ id: String(ownerId), legacy: true }, process.env.JWT_SECRET);
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/commercial/requests/${requestId}/pay`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  );
  const body = await response.json();

  assert.equal(response.status, 410);
  assert.equal(body.code, 'USE_MERCHANT_LOCAL_PROMOTION');
  assert.match(body.error, /Stepcoins/);
  assert.equal(request.status, 'pending_payment');
  assert.equal(request.paymentStatus, 'pending');
  assert.equal(positioningWrites, 0);
  assert.equal(paymentWrites, 0);

  const retry = await fetch(
    `http://127.0.0.1:${server.address().port}/api/commercial/requests/${requestId}/pay`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  );
  assert.equal(retry.status, 410);
  assert.equal(positioningWrites, 0);
  assert.equal(paymentWrites, 0);
});

test('a commerce can simulate payment for a product and it enters the ledger', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'commercial-product-payment-secret';
  const originals = {
    userFindById: User.findById,
    requestFindOne: CommercialRequest.findOne,
    paymentUpsert: Payment.findOneAndUpdate,
  };
  t.after(() => {
    if (previousSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    User.findById = originals.userFindById;
    CommercialRequest.findOne = originals.requestFindOne;
    Payment.findOneAndUpdate = originals.paymentUpsert;
  });

  const ownerId = new mongoose.Types.ObjectId();
  const requestId = new mongoose.Types.ObjectId();
  const request = {
    _id: requestId,
    ownerId,
    establishmentId: new mongoose.Types.ObjectId(),
    type: 'commercial_skin',
    title: 'Skin de comercio',
    price: 500,
    currency: 'EUR',
    status: 'pending_payment',
    paymentStatus: 'pending',
    paymentProvider: '',
    paymentReference: '',
    materials: [],
    history: [],
    revision: 1,
    async save() {},
    toJSON() { return { ...this, id: String(this._id) }; },
  };
  let ledger;
  User.findById = () => ({
    select() { return this; },
    lean: async () => ({
      _id: ownerId, role: 'comercio', firebaseUid: null,
      email: 'commerce@example.test', nombre: 'Comercio',
    }),
  });
  CommercialRequest.findOne = async () => request;
  Payment.findOneAndUpdate = async (_filter, update) => {
    ledger = update.$setOnInsert;
    return { _id: new mongoose.Types.ObjectId(), ...ledger };
  };

  const app = express();
  app.use(express.json());
  app.use('/api/commercial', commercialRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const token = jwt.sign({ id: String(ownerId), legacy: true }, process.env.JWT_SECRET);
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/commercial/requests/${requestId}/pay`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  );
  const body = await response.json();

  assert.equal(response.status, 200, body.error);
  assert.equal(body.status, 'pending_material');
  assert.equal(request.paymentStatus, 'confirmed');
  assert.equal(request.paymentProvider, 'platform');
  assert.equal(request.status, 'pending_material');
  assert.equal(ledger.cantidad, 500);
  assert.equal(ledger.source, 'platform_checkout');
  assert.equal(ledger.commercialRequestId, requestId);
  assert.match(ledger.motivo, /Compra simulada/);
});

test('a commerce pays a location promotion atomically with Stepcoins', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'direct-map-subscription-secret';
  const originals = {
    userFindById: User.findById,
    establishmentFindOne: Establishment.findOne,
    planUpdateOne: MapPlan.updateOne,
    planFind: MapPlan.find,
    planFindOne: MapPlan.findOne,
    promoFindOne: MapPromoCode.findOne,
    subscriptionFindOne: PromocionComprada.findOne,
    subscriptionUpsert: PromocionComprada.findOneAndUpdate,
    paymentFindOne: Payment.findOne,
    paymentCreate: Payment.create,
    stepcoinFindOne: StepcoinTransaction.findOne,
    stepcoinCreate: StepcoinTransaction.create,
    userFindOneAndUpdate: User.findOneAndUpdate,
    startSession: mongoose.startSession,
  };
  t.after(() => {
    if (previousSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    User.findById = originals.userFindById;
    Establishment.findOne = originals.establishmentFindOne;
    MapPlan.updateOne = originals.planUpdateOne;
    MapPlan.find = originals.planFind;
    MapPlan.findOne = originals.planFindOne;
    MapPromoCode.findOne = originals.promoFindOne;
    PromocionComprada.findOne = originals.subscriptionFindOne;
    PromocionComprada.findOneAndUpdate = originals.subscriptionUpsert;
    Payment.findOne = originals.paymentFindOne;
    Payment.create = originals.paymentCreate;
    StepcoinTransaction.findOne = originals.stepcoinFindOne;
    StepcoinTransaction.create = originals.stepcoinCreate;
    User.findOneAndUpdate = originals.userFindOneAndUpdate;
    mongoose.startSession = originals.startSession;
  });

  const ownerId = new mongoose.Types.ObjectId();
  const locationId = new mongoose.Types.ObjectId();
  const planId = new mongoose.Types.ObjectId();
  const subscriptionId = new mongoose.Types.ObjectId();
  const location = {
    _id: locationId, ownerId, publicName: 'CoffeeMax', description: 'Café',
    address: 'Calle Uno', logoUrl: '/api/media/coffee', lat: 41.65, lng: -0.88,
    proximityMessage: '¿Te apetece tomar un café en CoffeeMax?', proximityRadiusMeters: 200,
  };
  const plan = {
    _id: planId, code: 'MAP_MONTHLY', title: '1 mes',
    durationMonths: 1, priceStepcoins: 20,
  };
  let published;
  let ledger;
  let debit;
  let debitCount = 0;
  let balance = 100;
  User.findById = () => ({
    session() { return this; },
    select() { return this; },
    lean: async () => ({
      _id: ownerId, id: String(ownerId), role: 'comercio', firebaseUid: null,
      email: 'coffee@example.test', nombre: 'CoffeeMax', stepcoins: balance,
    }),
  });
  User.findOneAndUpdate = async (filter, update) => {
    if (balance < filter.stepcoins.$gte) return null;
    debit = { filter, update };
    debitCount += 1;
    balance += update.$inc.stepcoins;
    return { _id: ownerId, stepcoins: balance };
  };
  Establishment.findOne = async () => location;
  MapPlan.updateOne = async () => ({});
  MapPlan.find = () => ({ sort() { return this; }, lean: async () => [plan] });
  MapPlan.findOne = async () => plan;
  MapPromoCode.findOne = async () => null;
  let subscriptionLookup = 0;
  PromocionComprada.findOne = () => {
    subscriptionLookup += 1;
    const result = ledger ? { _id: subscriptionId, ...published } : null;
    return {
      session() { return this; },
      lean: async () => result,
      then: (resolve) => resolve(result),
    };
  };
  PromocionComprada.findOneAndUpdate = async (_filter, update) => {
    published = update.$set;
    return { _id: subscriptionId, ...published, async save() {} };
  };
  StepcoinTransaction.findOne = (filter) => ({
    session() { return this; },
    lean: async () => (ledger?.operationKey === filter.operationKey ? ledger : null),
  });
  StepcoinTransaction.create = async ([value]) => {
    ledger = value;
    return [{ _id: new mongoose.Types.ObjectId(), ...value }];
  };
  mongoose.startSession = async () => ({
    async withTransaction(callback) { await callback(); },
    async endSession() {},
  });

  const app = express();
  app.use(express.json());
  app.use('/api/commercial', commercialRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const token = jwt.sign({ id: String(ownerId), legacy: true }, process.env.JWT_SECRET);
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/commercial/locations/${locationId}/subscribe`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planId: String(planId), requestId: 'checkout_test_123', autoRenew: true,
      }),
    },
  );
  const body = await response.json();

  assert.equal(response.status, 201, body.error);
  assert.equal(published.status, 'published');
  assert.equal(published.activo, true);
  assert.equal(published.establishmentId, locationId);
  assert.equal(published.publicName, 'CoffeeMax');
  assert.equal(published.imagenBase, '/img/local.png');
  assert.equal(published.proximityRadiusMeters, 250);
  assert.equal(published.autoRenew, true);
  assert.equal(published.precioStepcoins, 20);
  assert.equal(published.originalPriceStepcoins, 20);
  assert.equal(debit.filter.stepcoins.$gte, 20);
  assert.equal(debit.update.$inc.stepcoins, -20);
  assert.equal(ledger.cantidad, -20);
  assert.equal(ledger.tipo, 'promocion_local_comercio');
  assert.equal(ledger.metadata.source, 'merchant_local_promotion');
  assert.equal(ledger.metadata.establishmentId, locationId);
  assert.equal(String(ledger.metadata.mapSubscriptionId), String(subscriptionId));
  assert.equal(body.spentStepcoins, 20);
  assert.equal(body.balance, 80);

  const repeatedResponse = await fetch(
    `http://127.0.0.1:${server.address().port}/api/commercial/locations/${locationId}/subscribe`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planId: String(planId), requestId: 'checkout_test_123', autoRenew: true,
      }),
    },
  );
  const repeatedBody = await repeatedResponse.json();
  assert.equal(repeatedResponse.status, 200, repeatedBody.error);
  assert.equal(repeatedBody.repeated, true);
  assert.equal(repeatedBody.balance, 80);
  assert.equal(debitCount, 1);

  balance = 5;
  const insufficientResponse = await fetch(
    `http://127.0.0.1:${server.address().port}/api/commercial/locations/${locationId}/subscribe`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planId: String(planId), requestId: 'checkout_test_456', autoRenew: true,
      }),
    },
  );
  const insufficientBody = await insufficientResponse.json();
  assert.equal(insufficientResponse.status, 402);
  assert.equal(insufficientBody.code, 'INSUFFICIENT_STEPCOINS');
  assert.equal(insufficientBody.requiredStepcoins, 20);
  assert.equal(insufficientBody.balance, 5);
  assert.equal(debitCount, 1);
});

test('the public Flutter map endpoint exposes active location and proximity data', async (t) => {
  const originalFind = PromocionComprada.find;
  let calls = 0;
  PromocionComprada.find = () => {
    calls += 1;
    if (calls === 1) return { lean: async () => [] };
    return {
      select() { return this; },
      lean: async () => [{
        _id: new mongoose.Types.ObjectId(), establishmentId: new mongoose.Types.ObjectId(),
        titulo: 'CoffeeMax', publicName: 'CoffeeMax', address: 'Calle Uno',
        description: 'Café', logoComercio: '/api/media/coffee', imagenBase: '',
        lat: 41.65, lng: -0.88, activo: true, status: 'published',
        proximityMessage: '¿Te apetece tomar un café en CoffeeMax? Hoy tenemos una promoción especial.',
        proximityRadiusMeters: 200, fechaFin: new Date(Date.now() + 86400000),
      }],
    };
  };
  t.after(() => { PromocionComprada.find = originalFind; });

  const app = express();
  app.use('/api/promo-contratada', legacyPositioningRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/promo-contratada/activas`,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.length, 1);
  assert.equal(body[0].publicName, 'CoffeeMax');
  assert.equal(body[0].imagenBase, '/img/local.png');
  assert.equal(body[0].proximityRadiusMeters, 250);
  assert.equal(body[0].proximityMessage.length, 50);
  assert.match(body[0].proximityMessage, /CoffeeMax/);
  assert.equal(body[0].lat, 41.65);
  assert.equal(body[0].lng, -0.88);
});

test('location loading survives renewal maintenance errors and reads legacy subscriptions without writing', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'location-loading-secret';
  const originals = {
    userFindById: User.findById,
    establishmentFind: Establishment.find,
    subscriptionFind: PromocionComprada.find,
  };
  const originalConsoleError = console.error;
  t.after(() => {
    if (previousSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    User.findById = originals.userFindById;
    Establishment.find = originals.establishmentFind;
    PromocionComprada.find = originals.subscriptionFind;
    console.error = originalConsoleError;
  });

  const ownerId = new mongoose.Types.ObjectId();
  const locationId = new mongoose.Types.ObjectId();
  User.findById = () => ({
    select() { return this; },
    lean: async () => ({ _id: ownerId, id: String(ownerId), role: 'comercio', firebaseUid: null }),
  });
  Establishment.find = () => ({
    sort() { return this; },
    lean: async () => [{
      _id: locationId, ownerId, publicName: 'Local legacy', address: 'Calle Uno',
      lat: 41.65, lng: -0.88, archived: false,
    }],
  });
  let findCalls = 0;
  PromocionComprada.find = () => {
    findCalls += 1;
    if (findCalls === 1) return { lean: async () => { throw new Error('maintenance failed'); } };
    return {
      sort() { return this; },
      lean: async () => [{
        _id: new mongoose.Types.ObjectId(), comercioId: ownerId,
        titulo: 'Promoción antigua', activo: true, status: 'published',
        fechaFin: new Date(Date.now() + 86400000),
      }],
    };
  };
  console.error = () => {};

  const app = express();
  app.use(express.json());
  app.use('/api/commercial', commercialRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const token = jwt.sign({ id: String(ownerId), legacy: true }, process.env.JWT_SECRET);
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/commercial/locations`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.length, 1);
  assert.equal(body[0].publicName, 'Local legacy');
  assert.equal(body[0].subscription.titulo, 'Promoción antigua');
});
