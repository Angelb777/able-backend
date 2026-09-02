const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { createGoogleMapsRouter } = require('../api/routes/googleMaps');
const { createGoogleMapsMobileService } = require('../api/services/googleMapsMobileService');

async function startRouter(router) {
  const app = express();
  app.use(express.json());
  app.use('/api/google-maps', router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}/api/google-maps`,
  };
}

const authenticate = (req, _res, next) => {
  req.user = { id: 'user-1' };
  next();
};

test('Google service keeps the existing Directions and Places parameters server-side', async () => {
  const calls = [];
  const service = createGoogleMapsMobileService({
    apiKey: 'server-secret',
    fetchImpl: async (url) => {
      calls.push(new URL(url));
      return { ok: true, json: async () => ({ status: 'OK' }) };
    },
  });

  await service.directions({
    origin: { lat: 41.65, lng: -0.88 },
    destination: { lat: 41.67, lng: -0.86 },
    mode: 'walking',
  });
  await service.autocomplete({
    input: 'Plaza Espana',
    sessionToken: 'session-1',
    origin: { lat: 41.65, lng: -0.88 },
  });
  await service.details({ placeId: 'place-1', sessionToken: 'session-1' });

  assert.equal(calls[0].pathname, '/maps/api/directions/json');
  assert.equal(calls[0].searchParams.get('mode'), 'walking');
  assert.equal(calls[1].pathname, '/maps/api/place/autocomplete/json');
  assert.equal(calls[1].searchParams.get('radius'), '50000');
  assert.equal(calls[2].pathname, '/maps/api/place/details/json');
  assert.equal(calls[2].searchParams.get('fields'), 'geometry');
  assert.ok(calls.every((url) => url.searchParams.get('key') === 'server-secret'));
});

test('map endpoints require authentication and preserve Google response bodies', async (t) => {
  const maps = {
    directions: async () => ({ status: 'OK', routes: [{ overview_polyline: { points: 'abc' } }] }),
    autocomplete: async () => ({ status: 'OK', predictions: [{ place_id: 'place-1' }] }),
    details: async () => ({ status: 'OK', result: { geometry: { location: { lat: 1, lng: 2 } } } }),
  };
  const rejectAuthentication = (_req, res) => res.status(401).json({ error: 'AUTH_REQUIRED' });
  const unauthenticated = await startRouter(createGoogleMapsRouter({
    maps, authenticate: rejectAuthentication, disableRateLimit: true,
  }));
  t.after(() => new Promise((resolve) => unauthenticated.server.close(resolve)));
  assert.equal((await fetch(`${unauthenticated.baseUrl}/directions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })).status, 401);

  const authenticated = await startRouter(createGoogleMapsRouter({
    maps, authenticate, disableRateLimit: true,
  }));
  t.after(() => new Promise((resolve) => authenticated.server.close(resolve)));
  const response = await fetch(`${authenticated.baseUrl}/directions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin: { lat: 41.65, lng: -0.88 },
      destination: { lat: 41.67, lng: -0.86 },
      mode: 'driving',
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), await maps.directions());
});

test('Directions rejects unsupported modes and applies its per-user limit', async (t) => {
  const maps = { directions: async () => ({ status: 'OK', routes: [] }) };
  const running = await startRouter(createGoogleMapsRouter({
    maps, authenticate, limits: { directions: 2 },
  }));
  t.after(() => new Promise((resolve) => running.server.close(resolve)));
  const call = (mode = 'walking') => fetch(`${running.baseUrl}/directions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin: { lat: 41.65, lng: -0.88 },
      destination: { lat: 41.67, lng: -0.86 },
      mode,
    }),
  });

  assert.equal((await call('flying')).status, 400);
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 429);
});
