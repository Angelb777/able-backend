const BIZI_API_URL =
  "https://www.zaragoza.es/sede/servicio/urbanismo-infraestructuras/estacion-bicicleta.json?srsname=wgs84&rows=500";

const PROVIDER = "bizi_zaragoza";
const SOURCE = "zaragoza_open_data";
const CACHE_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 8_000;

class BiziUpstreamError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "BiziUpstreamError";
  }
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

function isoDateOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).trim().replace(" ", "T");
  const date = new Date(raw);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)) {
    return Number.isNaN(date.getTime()) ? null : raw;
  }
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeStation(raw) {
  if (!raw || typeof raw !== "object") return null;

  const externalId = raw.id === null || raw.id === undefined
    ? ""
    : String(raw.id).trim();
  const coordinates = raw.geometry?.coordinates;
  if (!externalId || !Array.isArray(coordinates) || coordinates.length < 2) {
    return null;
  }

  const longitude = Number(coordinates[0]);
  const latitude = Number(coordinates[1]);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }

  const rawStatus = String(raw.estado ?? "").trim().toUpperCase();
  const status = rawStatus || "UNKNOWN";
  const isOperational = [
    "IN_SERVICE",
    "OPERATIONAL",
    "OPERATIVE",
    "OPERATIVA",
  ].includes(status);

  const name = String(raw.title ?? raw.address ?? `Estación ${externalId}`).trim();

  return {
    externalId,
    provider: PROVIDER,
    city: "Zaragoza",
    name: name || `Estación ${externalId}`,
    latitude,
    longitude,
    vehiclesAvailable: nonNegativeInteger(raw.bicisDisponibles),
    docksAvailable: nonNegativeInteger(raw.anclajesDisponibles),
    isOperational,
    status,
    lastUpdated: isoDateOrNull(raw.lastUpdated),
  };
}

function normalizeStations(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.result)) {
    throw new BiziUpstreamError("La respuesta de Bizi no contiene una lista válida");
  }

  const byId = new Map();
  for (const rawStation of payload.result) {
    const station = normalizeStation(rawStation);
    if (station) byId.set(station.externalId, station);
  }

  if (byId.size === 0) {
    throw new BiziUpstreamError("La respuesta de Bizi no contiene estaciones válidas");
  }

  return [...byId.values()];
}

function createBiziStationService({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Este runtime de Node.js no dispone de fetch");
  }

  let lastValid = null;
  let inFlight = null;

  async function fetchFresh() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(BIZI_API_URL, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "Able73/1.0",
        },
        signal: controller.signal,
      });

      if (!response || !response.ok) {
        throw new BiziUpstreamError(
          `La API de Bizi respondió con HTTP ${response?.status ?? "desconocido"}`,
        );
      }

      const payload = await response.json();
      const fetchedAt = now();
      const normalized = {
        provider: PROVIDER,
        source: SOURCE,
        updatedAt: new Date(fetchedAt).toISOString(),
        stations: normalizeStations(payload),
      };
      lastValid = { fetchedAt, value: normalized };

      return {
        ...normalized,
        fromCache: false,
        stale: false,
      };
    } catch (error) {
      if (error instanceof BiziUpstreamError) throw error;
      const message =
        error?.name === "AbortError"
          ? "La API de Bizi superó el tiempo de espera"
          : "No se pudo consultar la API de Bizi";
      throw new BiziUpstreamError(message, error);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function getStations() {
    const currentTime = now();
    if (lastValid && currentTime - lastValid.fetchedAt < CACHE_TTL_MS) {
      return {
        ...lastValid.value,
        fromCache: true,
        stale: false,
      };
    }

    try {
      if (!inFlight) {
        inFlight = fetchFresh().finally(() => {
          inFlight = null;
        });
      }
      return await inFlight;
    } catch (error) {
      if (lastValid) {
        return {
          ...lastValid.value,
          fromCache: true,
          stale: true,
        };
      }
      throw error;
    }
  }

  return { getStations };
}

module.exports = {
  BIZI_API_URL,
  BiziUpstreamError,
  CACHE_TTL_MS,
  createBiziStationService,
  normalizeStation,
  normalizeStations,
};
