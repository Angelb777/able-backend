const DEFAULT_FREE_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const DEFAULT_CUSTOMER_ENDPOINT =
  "https://customer-api.open-meteo.com/v1/forecast";

class WeatherUpstreamError extends Error {}

function createWeatherService({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  cacheTtlMs = 10 * 60 * 1000,
  endpoint = process.env.WEATHER_API_BASE_URL,
  apiKey = process.env.OPEN_METEO_API_KEY,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Este servidor necesita Node.js 18+ para consultar meteorología");
  }
  const baseUrl = endpoint ||
    (apiKey ? DEFAULT_CUSTOMER_ENDPOINT : DEFAULT_FREE_ENDPOINT);
  const cache = new Map();
  let inFlight = null;

  async function getCurrent(latitude, longitude) {
    const cacheKey = `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
    const cached = cache.get(cacheKey);
    if (cached && now() - cached.fetchedAt < cacheTtlMs) return cached.payload;
    if (inFlight?.key === cacheKey) return inFlight.promise;

    const promise = fetchCurrent(latitude, longitude)
      .then((payload) => {
        cache.set(cacheKey, { fetchedAt: now(), payload });
        if (cache.size > 500) cache.delete(cache.keys().next().value);
        return payload;
      })
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
      });
    inFlight = { key: cacheKey, promise };
    return promise;
  }

  async function fetchCurrent(latitude, longitude) {
    const url = new URL(baseUrl);
    url.searchParams.set("latitude", latitude.toFixed(5));
    url.searchParams.set("longitude", longitude.toFixed(5));
    url.searchParams.set(
      "current",
      "weather_code,precipitation,rain,showers,snowfall,visibility",
    );
    url.searchParams.set("timezone", "auto");
    url.searchParams.set("forecast_days", "1");
    if (apiKey) url.searchParams.set("apikey", apiKey);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new WeatherUpstreamError(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!payload || typeof payload.current !== "object") {
        throw new WeatherUpstreamError("Respuesta meteorológica inválida");
      }
      return payload;
    } catch (error) {
      if (error instanceof WeatherUpstreamError) throw error;
      throw new WeatherUpstreamError(error?.message || "Error de red meteorológico");
    } finally {
      clearTimeout(timeout);
    }
  }

  return { getCurrent };
}

module.exports = {
  WeatherUpstreamError,
  createWeatherService,
};

