const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../api/models/User');

const commercialRouter = require('../api/routes/commercial');
const legacyPositioningRouter = require('../api/routes/promoContratada');
const positioningPackagesRouter = require('../api/routes/promocionesNegocio');
const rewardsRouter = require('../api/routes/rewards');
const CommercialRequest = require('../api/models/CommercialRequest');
const {
  fixedPrice, pendingStatus, assertCanApprove, addOneYear, recordTransition,
} = require('../api/services/commercialWorkflow');

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
});
