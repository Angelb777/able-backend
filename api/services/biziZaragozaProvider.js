const BIZI_API_URL =
  "https://www.zaragoza.es/sede/servicio/urbanismo-infraestructuras/estacion-bicicleta.json?srsname=wgs84&rows=500";
const BIZI_GBFS_DISCOVERY_URL =
  "https://zaragoza.publicbikesystem.net/customer/gbfs/v3.0/gbfs.json";
const BIZI_MIRROR_API_URL = "https://datosbizi.com/api/stations";

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

function normalizeMirrorStations(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.stations)) {
    throw new BiziUpstreamError("La respuesta alternativa de Bizi no contiene una lista válida");
  }

  return normalizeStations({
    result: payload.stations.map((station) => ({
      id: station.id,
      title: station.name,
      estado: station.isOperational === false ? "OUT_OF_SERVICE" : "IN_SERVICE",
      bicisDisponibles: station.bikesAvailable,
      anclajesDisponibles: station.anchorsFree,
      geometry: { coordinates: [station.lon, station.lat] },
      lastUpdated: station.recordedAt ?? payload.generatedAt,
    })),
  });
}

function normalizeGbfsStations(informationPayload, statusPayload) {
  const information = informationPayload?.data?.stations;
  const statuses = statusPayload?.data?.stations;
  if (!Array.isArray(information) || !Array.isArray(statuses)) {
    throw new BiziUpstreamError("La respuesta GBFS de Bizi no contiene estaciones válidas");
  }

  const statusById = new Map(
    statuses.map((status) => [String(status.station_id ?? ""), status]),
  );
  const result = information.map((station) => {
    const status = statusById.get(String(station.station_id ?? "")) ?? {};
    const operational = status.is_installed !== false && status.is_installed !== 0 &&
      status.is_renting !== false && status.is_renting !== 0 &&
      status.is_returning !== false && status.is_returning !== 0;
    const reportedAt = status.last_reported;
    const numericTimestamp = Number(reportedAt);
    const lastUpdated = reportedAt !== null && reportedAt !== "" &&
      Number.isFinite(numericTimestamp)
      ? new Date(numericTimestamp * 1_000).toISOString()
      : isoDateOrNull(reportedAt);
    return {
      id: station.station_id,
      title: station.name,
      estado: operational ? "IN_SERVICE" : "OUT_OF_SERVICE",
      bicisDisponibles:
        status.num_vehicles_available ?? status.num_bikes_available,
      anclajesDisponibles: status.num_docks_available,
      geometry: { coordinates: [station.lon, station.lat] },
      lastUpdated,
    };
  });
  return normalizeStations({ result });
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

  async function requestJson(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "Able73/1.0 (https://able73.com)",
        },
        signal: controller.signal,
      });
      if (!response?.ok) {
        throw new BiziUpstreamError(
          `La API de Bizi respondió con HTTP ${response?.status ?? "desconocido"}`,
        );
      }
      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchFresh() {
    try {
      let stations;
      try {
        const discovery = await requestJson(BIZI_GBFS_DISCOVERY_URL);
        // Mantiene compatibilidad con el contrato municipal y con los tests.
        if (Array.isArray(discovery?.result)) {
          stations = normalizeStations(discovery);
        } else {
          const feeds = discovery?.data?.feeds ?? discovery?.data?.es?.feeds;
          const informationUrl = feeds?.find(
            (feed) => feed.name === "station_information",
          )?.url;
          const statusUrl = feeds?.find(
            (feed) => feed.name === "station_status",
          )?.url;
          if (!informationUrl || !statusUrl) {
            throw new BiziUpstreamError("El descubrimiento GBFS de Bizi está incompleto");
          }
          const [information, status] = await Promise.all([
            requestJson(informationUrl),
            requestJson(statusUrl),
          ]);
          stations = normalizeGbfsStations(information, status);
        }
      } catch (gbfsError) {
        try {
          stations = normalizeMirrorStations(await requestJson(BIZI_MIRROR_API_URL));
        } catch (mirrorError) {
          try {
            stations = normalizeStations(await requestJson(BIZI_API_URL));
          } catch (municipalError) {
            throw gbfsError instanceof BiziUpstreamError ? gbfsError : municipalError;
          }
        }
      }
      const fetchedAt = now();
      const normalized = {
        provider: PROVIDER,
        source: SOURCE,
        updatedAt: new Date(fetchedAt).toISOString(),
        stations,
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
  BIZI_GBFS_DISCOVERY_URL,
  BIZI_MIRROR_API_URL,
  BiziUpstreamError,
  CACHE_TTL_MS,
  createBiziStationService,
  normalizeStation,
  normalizeGbfsStations,
  normalizeMirrorStations,
  normalizeStations,
};
