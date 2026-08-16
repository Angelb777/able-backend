const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 500;

function decodePolyline(encoded) {
  const points = []; let index = 0; let lat = 0; let lng = 0;
  while (index < encoded.length) {
    let result = 0; let shift = 0; let byte;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; }
    while (byte >= 0x20 && index <= encoded.length);
    lat += (result & 1) ? ~(result >> 1) : result >> 1;
    result = 0; shift = 0;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; }
    while (byte >= 0x20 && index <= encoded.length);
    lng += (result & 1) ? ~(result >> 1) : result >> 1;
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

function createPoliceDirections({
  apiKey = process.env.GOOGLE_MAPS_SERVER_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '',
  fetchImpl = global.fetch, ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  const cache = new Map(); const inFlight = new Map();
  const keyFor = (from, to, mode) => [mode, from.lat.toFixed(3), from.lng.toFixed(3),
    to.lat.toFixed(3), to.lng.toFixed(3)].join(':');
  const getRoute = async (from, to, mode = 'driving', options = {}) => {
    if (!apiKey || typeof fetchImpl !== 'function') return [];
    const key = keyFor(from, to, mode); const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.points;
    if (inFlight.has(key)) return inFlight.get(key);
    const request = (async () => {
      const params = new URLSearchParams({ origin: `${from.lat},${from.lng}`,
        destination: `${to.lat},${to.lng}`, mode: mode === 'walking' ? 'walking' : 'driving', apiKey });
      params.set('key', params.get('apiKey')); params.delete('apiKey');
      const response = await fetchImpl(`https://maps.googleapis.com/maps/api/directions/json?${params}`);
      if (!response.ok) throw new Error(`Directions HTTP ${response.status}`);
      const data = await response.json(); const encoded = data.routes?.[0]?.overview_polyline?.points;
      const points = encoded ? decodePolyline(encoded) : [];
      if (points.length > 1) {
        const effectiveTtlMs = Math.max(30000, Number(options.ttlMs) || ttlMs);
        cache.set(key, { points, expiresAt: Date.now() + effectiveTtlMs });
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      }
      return points;
    })().catch((error) => { console.error('[POLICE] Directions route error', error.message); return []; })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, request); return request;
  };
  return { getRoute, clear: () => { cache.clear(); inFlight.clear(); }, cache };
}

module.exports = { createPoliceDirections, decodePolyline };
