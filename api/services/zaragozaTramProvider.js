const TRAM_STOPS_API_URL =
  "https://www.zaragoza.es/sede/servicio/urbanismo-infraestructuras/transporte-urbano/parada-tranvia.json";
const TRAM_STOP_DETAIL_API_URL =
  "https://www.zaragoza.es/sede/servicio/urbanismo-infraestructuras/transporte-urbano/parada-tranvia";

const PROVIDER = "zaragoza_tram";
const SOURCE = "Ayuntamiento de Zaragoza";
const PAGE_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 8_000;
const TRAM_STOP_ID_PATTERN = /^\d+$/;

class ZaragozaTramProviderError extends Error {
  constructor(message, { cause, status, code = "UPSTREAM_ERROR" } = {}) {
    super(message, { cause });
    this.name = "ZaragozaTramProviderError";
    this.status = status;
    this.code = code;
  }
}

class ZaragozaTramStopNotFoundError extends ZaragozaTramProviderError {
  constructor(stopId) {
    super(`La parada de tranvía ${stopId} no existe`, {
      status: 404,
      code: "STOP_NOT_FOUND",
    });
    this.name = "ZaragozaTramStopNotFoundError";
  }
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function validCoordinates(raw) {
  const coordinates = raw?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
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
  return { latitude, longitude };
}

function normalizeTramStop(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = cleanText(raw.id);
  const name = cleanText(raw.title);
  const coordinates = validCoordinates(raw);
  if (!TRAM_STOP_ID_PATTERN.test(id) || !name || !coordinates) return null;
  return {
    id,
    name,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    lines: [],
  };
}

function normalizeTramStopsPayloads(payloads) {
  if (!Array.isArray(payloads) || payloads.length === 0) {
    throw new ZaragozaTramProviderError(
      "La respuesta municipal de paradas de tranvía está vacía",
      { code: "MALFORMED_RESPONSE" },
    );
  }

  const byId = new Map();
  for (const payload of payloads) {
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.result)) {
      throw new ZaragozaTramProviderError(
        "La respuesta municipal de tranvía no contiene una lista válida",
        { code: "MALFORMED_RESPONSE" },
      );
    }
    for (const rawStop of payload.result) {
      const stop = normalizeTramStop(rawStop);
      if (stop) byId.set(stop.id, stop);
    }
  }
  if (byId.size === 0) {
    throw new ZaragozaTramProviderError(
      "La respuesta municipal no contiene paradas de tranvía válidas",
      { code: "EMPTY_RESPONSE" },
    );
  }
  return [...byId.values()];
}

function zaragozaLocalToIso(value) {
  const raw = cleanText(value).replace(" ", "T");
  if (!raw) return null;
  if (/Z$|[+-]\d{2}:\d{2}$/.test(raw)) {
    const absolute = new Date(raw);
    return Number.isNaN(absolute.getTime()) ? null : absolute.toISOString();
  }
  const match = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/,
  );
  if (!match) return null;

  const parts = match.slice(1, 7).map(Number);
  const milliseconds = Number(`0.${match[7] ?? "0"}`) * 1_000;
  const wanted = Date.UTC(
    parts[0],
    parts[1] - 1,
    parts[2],
    parts[3],
    parts[4],
    parts[5],
    milliseconds,
  );
  let utc = wanted;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const zoned = Object.fromEntries(
      formatter
        .formatToParts(new Date(utc))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    const represented = Date.UTC(
      zoned.year,
      zoned.month - 1,
      zoned.day,
      zoned.hour,
      zoned.minute,
      zoned.second,
      milliseconds,
    );
    utc += wanted - represented;
  }
  return new Date(utc).toISOString();
}

function normalizeTramArrivalsPayload(payload, expectedStopId) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ZaragozaTramProviderError(
      "La respuesta municipal de tiempos de tranvía no es válida",
      { code: "MALFORMED_RESPONSE" },
    );
  }
  const id = cleanText(payload.id);
  const name = cleanText(payload.title);
  const coordinates = validCoordinates(payload);
  if (id !== expectedStopId || !TRAM_STOP_ID_PATTERN.test(id) || !name) {
    throw new ZaragozaTramProviderError(
      "La respuesta municipal no identifica la parada solicitada",
      { code: "MALFORMED_RESPONSE" },
    );
  }
  if (!coordinates) {
    throw new ZaragozaTramProviderError(
      "La parada de tranvía no contiene coordenadas válidas",
      { code: "MALFORMED_RESPONSE" },
    );
  }
  if (payload.destinos !== undefined && !Array.isArray(payload.destinos)) {
    throw new ZaragozaTramProviderError(
      "La respuesta municipal contiene tiempos de tranvía malformados",
      { code: "MALFORMED_RESPONSE" },
    );
  }

  const arrivals = [];
  const lines = [];
  const seenLines = new Set();
  for (const rawArrival of payload.destinos ?? []) {
    if (!rawArrival || typeof rawArrival !== "object") continue;
    const line = cleanText(rawArrival.linea);
    const minutes = Number(rawArrival.minutos);
    if (!line || !Number.isFinite(minutes) || minutes < 0) continue;
    const normalizedMinutes = Math.trunc(minutes);
    if (!seenLines.has(line)) {
      seenLines.add(line);
      lines.push(line);
    }
    arrivals.push({
      line,
      destination: cleanText(rawArrival.destino) || null,
      minutes: normalizedMinutes,
      estimatedArrival: null,
      displayTime:
        normalizedMinutes === 0 ? "En parada" : `${normalizedMinutes} min`,
      status: normalizedMinutes === 0 ? "at_stop" : "estimated",
    });
  }
  arrivals.sort((left, right) => left.minutes - right.minutes);

  return {
    provider: PROVIDER,
    source: SOURCE,
    stop: {
      id,
      name,
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      lines,
    },
    arrivals,
    updatedAt: zaragozaLocalToIso(payload.lastUpdated),
  };
}

function createZaragozaTramProvider({
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Este runtime de Node.js no dispone de fetch");
  }

  async function requestJson(url, { validators } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const headers = {
      Accept: "application/json",
      "User-Agent": "Able73/1.0",
    };
    if (validators?.etag) headers["If-None-Match"] = validators.etag;
    if (validators?.lastModified) {
      headers["If-Modified-Since"] = validators.lastModified;
    }

    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      if (response?.status === 304) {
        return { notModified: true, validators };
      }
      if (response?.status === 404) {
        throw new ZaragozaTramStopNotFoundError(
          decodeURIComponent(url.split("/").pop().split(".json")[0]),
        );
      }
      if (!response?.ok) {
        const status = response?.status;
        throw new ZaragozaTramProviderError(
          `La API municipal de tranvía respondió con HTTP ${status ?? "desconocido"}`,
          {
            status,
            code: status === 429 ? "RATE_LIMITED" : "UPSTREAM_HTTP_ERROR",
          },
        );
      }
      const payload = await response.json();
      return {
        payload,
        validators: {
          etag: response.headers?.get?.("etag") ?? null,
          lastModified: response.headers?.get?.("last-modified") ?? null,
        },
      };
    } catch (error) {
      if (error instanceof ZaragozaTramProviderError) throw error;
      const timedOut = error?.name === "AbortError";
      throw new ZaragozaTramProviderError(
        timedOut
          ? "La API municipal de tranvía superó el tiempo de espera"
          : "No se pudo consultar la API municipal de tranvía",
        {
          cause: error,
          code: timedOut ? "TIMEOUT" : "NETWORK_ERROR",
        },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchStops() {
    const payloads = [];
    let start = 0;
    let totalCount = Number.POSITIVE_INFINITY;
    while (start < totalCount) {
      const url = new URL(TRAM_STOPS_API_URL);
      url.searchParams.set("srsname", "wgs84");
      url.searchParams.set("rows", String(PAGE_SIZE));
      url.searchParams.set("start", String(start));
      url.searchParams.set("fl", "id,title,geometry");
      const { payload } = await requestJson(url.toString());
      if (!payload || typeof payload !== "object" || !Array.isArray(payload.result)) {
        throw new ZaragozaTramProviderError(
          "La respuesta municipal de tranvía no contiene una lista válida",
          { code: "MALFORMED_RESPONSE" },
        );
      }
      payloads.push(payload);
      totalCount = Number(payload.totalCount);
      if (!Number.isFinite(totalCount) || totalCount < 0) {
        throw new ZaragozaTramProviderError(
          "La paginación municipal de tranvía no es válida",
          { code: "MALFORMED_RESPONSE" },
        );
      }
      if (payload.result.length === 0 && start < totalCount) {
        throw new ZaragozaTramProviderError(
          "La paginación municipal de tranvía terminó antes de tiempo",
          { code: "MALFORMED_RESPONSE" },
        );
      }
      start += payload.result.length;
    }
    return normalizeTramStopsPayloads(payloads);
  }

  async function fetchArrivals(stopId, { validators } = {}) {
    if (!TRAM_STOP_ID_PATTERN.test(stopId)) {
      throw new ZaragozaTramStopNotFoundError(stopId);
    }
    const url =
      `${TRAM_STOP_DETAIL_API_URL}/${encodeURIComponent(stopId)}.json` +
      "?srsname=wgs84";
    const result = await requestJson(url, { validators });
    if (result.notModified) return result;
    return {
      value: normalizeTramArrivalsPayload(result.payload, stopId),
      validators: result.validators,
    };
  }

  return { fetchStops, fetchArrivals };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  PAGE_SIZE,
  PROVIDER,
  SOURCE,
  TRAM_STOPS_API_URL,
  TRAM_STOP_DETAIL_API_URL,
  TRAM_STOP_ID_PATTERN,
  ZaragozaTramProviderError,
  ZaragozaTramStopNotFoundError,
  createZaragozaTramProvider,
  normalizeTramArrivalsPayload,
  normalizeTramStop,
  normalizeTramStopsPayloads,
};
