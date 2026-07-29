const {
  PROVIDER,
  SOURCE,
  createZaragozaBusProvider,
} = require("./zaragozaBusProvider");

const STOPS_CACHE_TTL_MS = 12 * 60 * 60 * 1_000;
const STOPS_STALE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const ARRIVALS_CACHE_TTL_MS = 30_000;
const ARRIVALS_STALE_MAX_AGE_MS = 5 * 60 * 1_000;

function createBusStopService({
  provider = createZaragozaBusProvider(),
  now = () => Date.now(),
  stopsCacheTtlMs = STOPS_CACHE_TTL_MS,
  arrivalsCacheTtlMs = ARRIVALS_CACHE_TTL_MS,
} = {}) {
  let stopsCache = null;
  let stopsInFlight = null;
  const arrivalsCache = new Map();
  const arrivalsInFlight = new Map();

  function cachedResponse(entry, stale) {
    return {
      ...entry.value,
      fromCache: true,
      stale,
    };
  }

  async function getStops() {
    const currentTime = now();
    if (stopsCache && currentTime - stopsCache.fetchedAt < stopsCacheTtlMs) {
      return cachedResponse(stopsCache, false);
    }

    if (!stopsInFlight) {
      stopsInFlight = (async () => {
        const stops = await provider.fetchStops();
        const fetchedAt = now();
        const value = {
          provider: PROVIDER,
          source: SOURCE,
          updatedAt: new Date(fetchedAt).toISOString(),
          stops,
        };
        stopsCache = { fetchedAt, value };
        return { ...value, fromCache: false, stale: false };
      })().finally(() => {
        stopsInFlight = null;
      });
    }

    try {
      return await stopsInFlight;
    } catch (error) {
      if (
        stopsCache &&
        now() - stopsCache.fetchedAt <= STOPS_STALE_MAX_AGE_MS
      ) {
        return cachedResponse(stopsCache, true);
      }
      throw error;
    }
  }

  async function getArrivals(stopId) {
    const currentTime = now();
    const cached = arrivalsCache.get(stopId);
    if (cached && currentTime - cached.fetchedAt < arrivalsCacheTtlMs) {
      return cachedResponse(cached, false);
    }

    let inFlight = arrivalsInFlight.get(stopId);
    if (!inFlight) {
      inFlight = (async () => {
        const result = await provider.fetchArrivals(stopId, {
          validators: cached?.validators,
        });
        if (result.notModified) {
          if (!cached) {
            throw new Error("El origen devolvió 304 sin una respuesta previa");
          }
          cached.fetchedAt = now();
          return cachedResponse(cached, false);
        }

        const fetchedAt = now();
        const value = {
          ...result.value,
          updatedAt:
            result.value.updatedAt ?? new Date(fetchedAt).toISOString(),
        };
        arrivalsCache.set(stopId, {
          fetchedAt,
          value,
          validators: result.validators,
        });
        return { ...value, fromCache: false, stale: false };
      })().finally(() => {
        arrivalsInFlight.delete(stopId);
      });
      arrivalsInFlight.set(stopId, inFlight);
    }

    try {
      return await inFlight;
    } catch (error) {
      if (
        cached &&
        now() - cached.fetchedAt <= ARRIVALS_STALE_MAX_AGE_MS
      ) {
        return cachedResponse(cached, true);
      }
      throw error;
    }
  }

  return { getStops, getArrivals };
}

module.exports = {
  ARRIVALS_CACHE_TTL_MS,
  ARRIVALS_STALE_MAX_AGE_MS,
  STOPS_CACHE_TTL_MS,
  STOPS_STALE_MAX_AGE_MS,
  createBusStopService,
};
