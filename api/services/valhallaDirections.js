const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_TIMEOUT_MS = 1500;

function decodePolyline6(encoded) {
  const points = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;

  const decodeValue = () => {
    let result = 0;
    let shift = 0;
    while (index < encoded.length) {
      const byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0) return null;
      result |= (byte & 0x1f) << shift;
      if (byte < 0x20) return (result & 1) ? ~(result >> 1) : result >> 1;
      shift += 5;
      if (shift > 30) return null;
    }
    return null;
  };

  while (index < encoded.length) {
    const latitudeDelta = decodeValue();
    const longitudeDelta = decodeValue();
    if (latitudeDelta == null || longitudeDelta == null) return [];
    latitude += latitudeDelta;
    longitude += longitudeDelta;
    points.push({ lat: latitude / 1e6, lng: longitude / 1e6 });
  }
  return points;
}

function validPoint(point) {
  return point && Number.isFinite(point.lat) && Number.isFinite(point.lng) &&
    point.lat >= -90 && point.lat <= 90 && point.lng >= -180 && point.lng <= 180;
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function createValhallaDirections({
  baseUrl = process.env.VALHALLA_BASE_URL || '',
  fetchImpl = global.fetch,
  timeoutMs = Number(process.env.VALHALLA_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  const endpoint = normalizeBaseUrl(baseUrl);
  const cache = new Map();
  const inFlight = new Map();
  let missingConfigurationReported = false;

  const keyFor = (from, to, mode) => [
    mode,
    from.lat.toFixed(4),
    from.lng.toFixed(4),
    to.lat.toFixed(4),
    to.lng.toFixed(4),
  ].join(':');

  const requestJson = async (path, body, requestTimeoutMs = timeoutMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(`${endpoint}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  };

  const getRoute = async (from, to, mode = 'driving', options = {}) => {
    if (!endpoint || typeof fetchImpl !== 'function') {
      if (!missingConfigurationReported) {
        console.error('[ROUTING:VALHALLA] VALHALLA_BASE_URL no esta configurada');
        missingConfigurationReported = true;
      }
      return [];
    }
    if (!validPoint(from) || !validPoint(to)) return [];
    const costing = mode === 'walking' ? 'pedestrian' : mode === 'driving' ? 'auto' : '';
    if (!costing) return [];

    const key = keyFor(from, to, mode);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.points;
    if (inFlight.has(key)) return inFlight.get(key);

    const request = requestJson('/route', {
      locations: [
        { lat: from.lat, lon: from.lng, type: 'break' },
        { lat: to.lat, lon: to.lng, type: 'break' },
      ],
      costing,
      units: 'kilometers',
      language: 'es-ES',
      shape_format: 'polyline6',
    }).then((data) => {
      const points = [];
      for (const leg of data?.trip?.legs || []) {
        const decoded = typeof leg?.shape === 'string' ? decodePolyline6(leg.shape) : [];
        if (points.length && decoded.length &&
            points.at(-1).lat === decoded[0].lat && points.at(-1).lng === decoded[0].lng) {
          decoded.shift();
        }
        points.push(...decoded);
      }
      if (points.length > 1) {
        const effectiveTtlMs = Math.max(30000, Number(options.ttlMs) || ttlMs);
        cache.set(key, { points, expiresAt: Date.now() + effectiveTtlMs });
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      }
      return points;
    }).catch((error) => {
      const reason = error?.name === 'AbortError' ? 'timeout' : error?.message || 'unknown';
      console.error(`[ROUTING:VALHALLA] route error: ${reason}`);
      return [];
    }).finally(() => inFlight.delete(key));

    inFlight.set(key, request);
    return request;
  };

  const healthCheck = async () => {
    if (!endpoint || typeof fetchImpl !== 'function') return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${endpoint}/status`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      return response.ok;
    } catch (_) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    provider: 'valhalla',
    configured: Boolean(endpoint),
    getRoute,
    healthCheck,
    clear: () => {
      cache.clear();
      inFlight.clear();
    },
    cache,
  };
}

module.exports = { createValhallaDirections, decodePolyline6, validPoint };
