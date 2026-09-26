const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createUberRouter } = require('../api/routes/uber');
const {
  UberRidersClient,
  UberApiError,
  USER_SCOPES,
  ESTIMATE_SCOPE,
} = require('../api/services/uberRidersClient');
const { encryptUberToken, decryptUberToken } = require('../api/services/uberTokenCrypto');

async function withServer(uber, run) {
  const app = express();
  app.use(express.json());
  app.use('/api/uber', createUberRouter({
    uber,
    authenticate: (req, _res, next) => { req.user = { id: 'user-1' }; next(); },
    disableRateLimit: true,
  }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('Uber tokens are authenticated-encrypted at rest', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const encrypted = encryptUberToken('secret-access-token', key);
  assert.notEqual(encrypted, 'secret-access-token');
  assert.equal(decryptUberToken(encrypted, key), 'secret-access-token');
  assert.throws(() => decryptUberToken(`${encrypted}x`, key));
});

test('uses the migrated Ride Request scopes', () => {
  assert.equal(ESTIMATE_SCOPE, 'ride_request.estimate');
  assert.deepEqual(USER_SCOPES, [
    'ride_request.ride_booking',
    'ride_request.user_payment_methods',
    'offline_access',
  ]);
});

test('current ride prefers the real active trip over a stored old request', async () => {
  const uber = Object.create(UberRidersClient.prototype);
  uber.Connection = {
    findOne: () => ({
      select: () => ({ lean: async () => ({ currentRequestId: 'old-request' }) }),
    }),
  };
  const paths = [];
  uber.userApiRequest = async (_userId, path) => {
    paths.push(path);
    return { request_id: 'active-request', status: 'accepted' };
  };
  const ride = await uber.currentRide('user-1');
  assert.equal(ride.requestId, 'active-request');
  assert.deepEqual(paths, ['/requests/current']);
});

test('Uber routes keep credentials server-side and expose offerings', async () => {
  const calls = [];
  const uber = {
    offerings: async (origin, destination) => {
      calls.push({ origin, destination });
      return [{ productId: 'uber-x', displayName: 'UberX', available: true }];
    },
  };
  await withServer(uber, async (base) => {
    const response = await fetch(`${base}/api/uber/offerings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: { lat: 41.65, lng: -0.88 }, destination: { lat: 41.66, lng: -0.89 } }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.products[0].productId, 'uber-x');
    assert.equal(JSON.stringify(body).includes('secret'), false);
    assert.equal(calls.length, 1);
  });
});

test('Uber route maps controlled provider errors', async () => {
  const uber = {
    createRide: async () => { throw new UberApiError('FARE_EXPIRED', 'La tarifa ha caducado.', 409); },
  };
  await withServer(uber, async (base) => {
    const response = await fetch(`${base}/api/uber/rides`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'FARE_EXPIRED', message: 'La tarifa ha caducado.' });
  });
});

test('OAuth callback is public and redirects to an in-app completion page', async () => {
  let completed = false;
  const uber = {
    completeAuthorization: async ({ state, code }) => {
      assert.equal(state, 'opaque-state');
      assert.equal(code, 'one-time-code');
      completed = true;
    },
  };
  await withServer(uber, async (base) => {
    const response = await fetch(`${base}/api/uber/oauth/callback?state=opaque-state&code=one-time-code`, { redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location'), /oauth\/complete\?status=success/);
    assert.equal(completed, true);
  });
});
