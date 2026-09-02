const test = require('node:test');
const assert = require('node:assert/strict');

const { createGroundRouteProvider } = require('../api/services/groundRouteProvider');
const { createValhallaDirections, decodePolyline6 } = require('../api/services/valhallaDirections');

function encodePolyline6(points) {
  let lastLat = 0;
  let lastLng = 0;
  let encoded = '';
  const encodeValue = (value) => {
    let current = value < 0 ? ~(value << 1) : value << 1;
    while (current >= 0x20) {
      encoded += String.fromCharCode((0x20 | (current & 0x1f)) + 63);
      current >>= 5;
    }
    encoded += String.fromCharCode(current + 63);
  };
  for (const point of points) {
    const lat = Math.round(point.lat * 1e6);
    const lng = Math.round(point.lng * 1e6);
    encodeValue(lat - lastLat);
    encodeValue(lng - lastLng);
    lastLat = lat;
    lastLng = lng;
  }
  return encoded;
}

test('polyline6 decoder preserves Valhalla route points', () => {
  const points = [
    { lat: 41.656745, lng: -0.878594 },
    { lat: 41.657111, lng: -0.877901 },
    { lat: 41.658002, lng: -0.876992 },
  ];
  assert.deepEqual(decodePolyline6(encodePolyline6(points)), points);
});

test('Valhalla maps driving to auto, walking to pedestrian and caches routes', async () => {
  const points = [
    { lat: 41.656745, lng: -0.878594 },
    { lat: 41.658002, lng: -0.876992 },
  ];
  const bodies = [];
  const provider = createValhallaDirections({
    baseUrl: 'http://valhalla:8002/',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://valhalla:8002/route');
      bodies.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({ trip: { legs: [{ shape: encodePolyline6(points) }] } }),
      };
    },
  });
  const from = points[0];
  const to = points[1];

  assert.deepEqual(await provider.getRoute(from, to, 'driving'), points);
  assert.deepEqual(await provider.getRoute(from, to, 'driving'), points);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].costing, 'auto');
  assert.equal(bodies[0].shape_format, 'polyline6');

  await provider.getRoute(from, to, 'walking');
  assert.equal(bodies[1].costing, 'pedestrian');
});

test('Valhalla returns an empty route on timeout and never invokes Google', async () => {
  let requestedUrl = '';
  const provider = createValhallaDirections({
    baseUrl: 'http://valhalla:8002',
    timeoutMs: 5,
    fetchImpl: (url, options) => {
      requestedUrl = url;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    },
  });
  const route = await provider.getRoute(
    { lat: 41.65, lng: -0.88 },
    { lat: 41.67, lng: -0.86 },
    'walking',
  );
  assert.deepEqual(route, []);
  assert.match(requestedUrl, /^http:\/\/valhalla:8002\/route$/);
  assert.doesNotMatch(requestedUrl, /google/i);
});

test('ground provider rejects every provider other than Valhalla', () => {
  assert.equal(createGroundRouteProvider({
    provider: 'valhalla', baseUrl: 'http://valhalla:8002',
  }).provider, 'valhalla');
  assert.throws(
    () => createGroundRouteProvider({ provider: 'google' }),
    /no soportado/,
  );
});
