const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../api/models/User');

const stepcoinsRouter = require('../api/routes/stepcoins');
const lifeRouter = require('../api/routes/life');
const cardsRouter = require('../api/routes/cards');
const skinsRouter = require('../api/routes/skins');
const ufoRouter = require('../api/routes/ufo');
const challengesRouter = require('../api/routes/challenges');
const paymentsRouter = require('../api/routes/payments');
const ordersRouter = require('../api/routes/orders');
const profileRouter = require('../api/routes/profile');
const projectilesRouter = require('../api/routes/projectiles');
const locationsRouter = require('../api/routes/ubicaciones');

test('critical economy, life, deck and admin routes enforce JWT ownership', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  const originalFindById = User.findById;
  process.env.JWT_SECRET = 'critical-auth-route-test-secret';
  const ownId = '507f1f77bcf86cd799439011';
  const otherId = '507f191e810c19729de860ea';
  const token = jwt.sign({ id: ownId, role: 'cliente' }, process.env.JWT_SECRET);
  User.findById = (id) => ({
    select() { return this; },
    lean: async () => ({ _id: id, role: 'cliente', email: 'client@test', firebaseUid: null }),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/stepcoins', stepcoinsRouter);
  app.use('/api/life', lifeRouter);
  app.use('/api/cards', cardsRouter);
  app.use('/api/skins', skinsRouter);
  app.use('/api/ufo', ufoRouter);
  app.use('/api/retos', challengesRouter);
  app.use('/api/payments', paymentsRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/profile', profileRouter);
  app.use('/api/projectiles', projectilesRouter);
  app.use('/api/ubicaciones', locationsRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    if (previousSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    User.findById = originalFindById;
    await new Promise((resolve) => server.close(resolve));
  });

  const call = (path, { method = 'GET', body, authenticated = true } = {}) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  assert.equal((await call('/api/stepcoins/adjust', {
    method: 'POST', authenticated: false, body: { userId: ownId, cantidad: 500, tipo: 'recompensa' },
  })).status, 401);
  assert.equal((await call('/api/stepcoins/adjust', {
    method: 'POST', body: { userId: otherId, cantidad: 500, tipo: 'recompensa' },
  })).status, 403);
  assert.equal((await call('/api/stepcoins/adjust', {
    method: 'POST', body: { userId: ownId, cantidad: 500, tipo: 'recompensa' },
  })).status, 403);
  assert.equal((await call('/api/life/' + otherId)).status, 403);
  assert.equal((await call('/api/life/' + otherId + '/hurt', {
    method: 'POST', body: { damage: 1000 },
  })).status, 403);
  assert.equal((await call('/api/cards/user-cards/' + otherId)).status, 403);
  assert.equal((await call('/api/cards/user-cards/' + otherId, {
    method: 'PUT', body: { mazo: [] },
  })).status, 403);

  const forcedRoulette = await call('/api/stepcoins/ruleta', {
    method: 'POST', body: { resultado: 'Gana 20000 Stepcoins' },
  });
  assert.equal(forcedRoulette.status, 400);
  assert.match((await forcedRoulette.json()).error, /requestId/i);

  assert.equal((await call('/api/skins', {
    method: 'POST', body: {}, authenticated: false,
  })).status, 401);
  assert.equal((await call('/api/ufo/ufo-id', {
    method: 'DELETE', authenticated: false,
  })).status, 401);
  assert.equal((await call('/api/retos', {
    method: 'POST', body: {}, authenticated: false,
  })).status, 401);
  assert.equal((await call('/api/payments', {
    method: 'POST', body: { userId: ownId, cantidad: 10 }, authenticated: false,
  })).status, 401);
  assert.equal((await call('/api/payments', {
    method: 'POST', body: { userId: ownId, cantidad: 10 },
  })).status, 403);
  assert.equal((await call('/api/payments')).status, 403);
  assert.equal((await call('/api/payments/' + otherId)).status, 403);
  assert.equal((await call('/api/orders/paid', { authenticated: false })).status, 401);
  assert.equal((await call('/api/profile/' + otherId, {
    method: 'PATCH', body: { nombre: 'Ataque' },
  })).status, 403);
  assert.equal((await call('/api/projectiles', {
    method: 'POST', authenticated: false, body: {},
  })).status, 401);
  assert.equal((await call('/api/ubicaciones/compartir', {
    method: 'POST', authenticated: false, body: { userId: otherId, lat: 0, lng: 0 },
  })).status, 401);
  assert.equal((await call('/api/ubicaciones/' + otherId, {
    method: 'DELETE',
  })).status, 403);

  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const simulatedCheckout = await call('/api/payments/stepcoins/checkout', {
    method: 'POST', body: { cantidad: 100, requestId: 'request-production-1' },
  });
  if (previousNodeEnv == null) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  assert.equal(simulatedCheckout.status, 503);
});
