const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createNavigationRouter } = require('../api/routes/navigation');

function startServer(routing) {
  const app = express();
  app.use(express.json());
  app.use('/api/navigation', createNavigationRouter({
    routing,
    authenticate: (_req, _res, next) => next(),
    disableRateLimit: true,
  }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('navigation endpoint returns the provider-neutral Valhalla route', async () => {
  let captured;
  const expected = {
    provider: 'valhalla',
    mode: 'pedestrian',
    geometry: [
      { lat: 41.65, lng: -0.88 },
      { lat: 41.66, lng: -0.87 },
    ],
    distanceMeters: 1450,
    durationSeconds: 980,
  };
  const server = await startServer({
    getRouteDetails: async (origin, destination, mode) => {
      captured = { origin, destination, mode };
      return expected;
    },
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/navigation/directions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin: { lat: 41.65, lng: -0.88 },
          destination: { lat: 41.66, lng: -0.87 },
          mode: 'pedestrian',
        }),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'OK', route: expected });
    assert.deepEqual(captured, {
      origin: { lat: 41.65, lng: -0.88 },
      destination: { lat: 41.66, lng: -0.87 },
      mode: 'pedestrian',
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('navigation endpoint rejects transit during this migration', async () => {
  const server = await startServer({ getRouteDetails: async () => null });
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/navigation/directions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin: { lat: 41.65, lng: -0.88 },
          destination: { lat: 41.66, lng: -0.87 },
          mode: 'transit',
        }),
      },
    );
    assert.equal(response.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
