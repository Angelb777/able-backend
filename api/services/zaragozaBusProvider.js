const BUS_STOPS_API_URL =
  "https://www.zaragoza.es/sede/servicio/urbanismo-infraestructuras/transporte-urbano/poste-autobus.json";
const BUS_STOP_DETAIL_API_URL =
  "https://www.zaragoza.es/sede/servicio/urbanismo-infraestructuras/transporte-urbano/poste-autobus";

const PROVIDER = "zaragoza_bus";
const SOURCE = "Ayuntamiento de Zaragoza";
const PAGE_SIZE = 500;
const DEFAULT_TIMEOUT_MS = 8_000;
const URBAN_STOP_ID_PATTERN = /^tuzsa-\d+$/i;

class ZaragozaBusProviderError extends Error {
  constructor(message, { cause, status, code = "UPSTREAM_ERROR" } = {}) {
    super(message, { cause });
    this.name = "ZaragozaBusProviderError";
    this.status = status;
    this.code = code;
  }
}

class ZaragozaBusStopNotFoundError extends ZaragozaBusProviderError {
  constructor(stopId) {
    super(`La parada ${stopId} no existe`, {
      status: 404,
      code: "STOP_NOT_FOUND",
    });
    this.name = "ZaragozaBusStopNotFoundError";
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

function parseStopTitle(title, fallbackCode = "") {
  const normalized = cleanText(title);
  const codeMatch = normalized.match(/^\(([^)]+)\)\s*/);
  const code = cleanText(codeMatch?.[1] ?? fallbackCode);
  const withoutCode = normalized.replace(/^\([^)]+\)\s*/, "");
  const linesMatch = withoutCode.match(/\s+L[ií]neas?\s*:\s*(.+)$/i);
  const name = cleanText(
    linesMatch ? withoutCode.slice(0, linesMatch.index) : withoutCode,
  );
  const lines = linesMatch
    ? [...new Set(
      linesMatch[1]
        .split(",")
        .map(cleanText)
        .filter(Boolean),
    )]
    : [];
  return { code, name, lines };
}

function normalizeStop(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = cleanText(raw.id);
  if (!URBAN_STOP_ID_PATTERN.test(id)) return null;
  const coordinates = validCoordinates(raw);
  if (!coordinates) return null;

  const idCode = id.replace(/^tuzsa-/i, "");
  const parsed = parseStopTitle(raw.title, idCode);
  const code = parsed.code || idCode;
  const name = parsed.name || `Parada ${code}`;

  return {
    id,
    code,
    name,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    lines: parsed.lines,
  };
}

function normalizeStopsPayloads(payloads) {
  if (!Array.isArray(payloads) || payloads.length === 0) {
    throw new ZaragozaBusProviderError(
      "La respuesta municipal de paradas está vacía",
      { code: "MALFORMED_RESPONSE" },
    );
  }

  const byId = new Map();
  for (const payload of payloads) {
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.result)) {
      throw new ZaragozaBusProviderError(
        "La respuesta municipal de paradas no contiene una lista válida",
        { code: "MALFORMED_RESPONSE" },
      );
    }
    for (const rawStop of payload.result) {
      const stop = normalizeStop(rawStop);
      if (stop) byId.set(stop.id, stop);
    }
  }

  if (byId.size === 0) {
    throw new ZaragozaBusProviderError(
      "La respuesta municipal no contiene paradas urbanas válidas",
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
  if (!match) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  const parts = match.slice(1, 7).map(Number);
  const milliseconds = Number(`0.${match[7] ?? "0"}`) * 1_000;
  let utc = Date.UTC(
    parts[0],
    parts[1] - 1,
    parts[2],
    parts[3],
    parts[4],
    parts[5],
    milliseconds,
  );
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

  // Dos iteraciones resuelven también los cambios de horario de verano.
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
    const wanted = Date.UTC(
      parts[0],
      parts[1] - 1,
      parts[2],
      parts[3],
      parts[4],
      parts[5],
      milliseconds,
    );
    utc += wanted - represented;
  }
  return new Date(utc).toISOString();
}

function normalizeDisplayTime(value) {
  const original = cleanText(value).replace(/[.,;]+$/, "");
  if (!original) return null;
  const lower = original.toLocaleLowerCase("es-ES");

  if (/\ben (?:la )?parada\b/.test(lower)) {
    return {
      minutes: null,
      displayTime: "En parada",
      status: "at_stop",
      sortMinutes: 0,
    };
  }
  if (/\bllegando\b/.test(lower)) {
    return {
      minutes: null,
      displayTime: "Llegando",
      status: "arriving",
      sortMinutes: 0.25,
    };
  }
  if (/menos de\s*1\s*(?:min|minuto)/.test(lower)) {
    return {
      minutes: null,
      displayTime: "Menos de 1 min",
      status: "arriving",
      sortMinutes: 0.5,
    };
  }
  if (/servicio\s+finalizado|finalizado/.test(lower)) {
    return {
      minutes: null,
      displayTime: "Servicio finalizado",
      status: "service_ended",
      sortMinutes: Number.POSITIVE_INFINITY,
    };
  }
  if (/sin estimaci[oó]n|no disponible|sin servicio/.test(lower)) {
    return {
      minutes: null,
      displayTime: "Sin estimación",
      status: "unavailable",
      sortMinutes: Number.POSITIVE_INFINITY,
    };
  }

  const minuteMatch = lower.match(/(\d+)\s*(?:min|minuto)/);
  if (minuteMatch) {
    const minutes = Number(minuteMatch[1]);
    return {
      minutes,
      displayTime: `${minutes} min`,
      status: "estimated",
      sortMinutes: minutes,
    };
  }
  const clockMatch = original.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (clockMatch) {
    return {
      minutes: null,
      displayTime: `${clockMatch[1].padStart(2, "0")}:${clockMatch[2]}`,
      status: "scheduled",
      sortMinutes: Number.POSITIVE_INFINITY,
    };
  }

  return {
    minutes: null,
    displayTime: original,
    status: "unavailable",
    sortMinutes: Number.POSITIVE_INFINITY,
  };
}

function cleanDestination(value) {
  const destination = cleanText(value).replace(/[\s,.;:]+$/, "");
  return destination || null;
}

function normalizeArrivalsPayload(payload, expectedStopId) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ZaragozaBusProviderError(
      "La respuesta municipal de tiempos no es válida",
      { code: "MALFORMED_RESPONSE" },
    );
  }

  const rawId = cleanText(payload.id);
  if (!URBAN_STOP_ID_PATTERN.test(rawId) || rawId !== expectedStopId) {
    throw new ZaragozaBusProviderError(
      "La respuesta municipal no identifica la parada solicitada",
      { code: "MALFORMED_RESPONSE" },
    );
  }
  const coordinates = validCoordinates(payload);
  if (!coordinates) {
    throw new ZaragozaBusProviderError(
      "La parada municipal no contiene coordenadas válidas",
      { code: "MALFORMED_RESPONSE" },
    );
  }
  if (payload.destinos !== undefined && !Array.isArray(payload.destinos)) {
    throw new ZaragozaBusProviderError(
      "La respuesta municipal contiene tiempos malformados",
      { code: "MALFORMED_RESPONSE" },
    );
  }

  const idCode = rawId.replace(/^tuzsa-/i, "");
  const parsed = parseStopTitle(payload.title, idCode);
  const stop = {
    id: rawId,
    code: parsed.code || idCode,
    name: parsed.name || `Parada ${parsed.code || idCode}`,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    lines: parsed.lines,
  };
  const arrivals = [];
  let sourceOrder = 0;

  for (const rawDestination of payload.destinos ?? []) {
    if (!rawDestination || typeof rawDestination !== "object") continue;
    const line = cleanText(rawDestination.linea);
    if (!line) continue;
    const destination = cleanDestination(rawDestination.destino);
    for (const field of ["primero", "segundo"]) {
      const timing = normalizeDisplayTime(rawDestination[field]);
      if (!timing) continue;
      arrivals.push({
        line,
        destination,
        minutes: timing.minutes,
        estimatedArrival: null,
        displayTime: timing.displayTime,
        status: timing.status,
        _sortMinutes: timing.sortMinutes,
        _sourceOrder: sourceOrder,
      });
      sourceOrder += 1;
    }
  }

  arrivals.sort(
    (left, right) =>
      left._sortMinutes - right._sortMinutes ||
      left._sourceOrder - right._sourceOrder,
  );
  for (const arrival of arrivals) {
    delete arrival._sortMinutes;
    delete arrival._sourceOrder;
  }

  return {
    provider: PROVIDER,
    source: SOURCE,
    stop,
    arrivals,
    updatedAt: zaragozaLocalToIso(payload.lastUpdated),
  };
}

function createZaragozaBusProvider({
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
        throw new ZaragozaBusStopNotFoundError(
          decodeURIComponent(url.split("/").pop().split(".json")[0]),
        );
      }
      if (!response?.ok) {
        const status = response?.status;
        const code = status === 429 ? "RATE_LIMITED" : "UPSTREAM_HTTP_ERROR";
        throw new ZaragozaBusProviderError(
          `La API municipal respondió con HTTP ${status ?? "desconocido"}`,
          { status, code },
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
      if (error instanceof ZaragozaBusProviderError) throw error;
      const timedOut = error?.name === "AbortError";
      throw new ZaragozaBusProviderError(
        timedOut
          ? "La API municipal de autobús superó el tiempo de espera"
          : "No se pudo consultar la API municipal de autobús",
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
      const url = new URL(BUS_STOPS_API_URL);
      url.searchParams.set("srsname", "wgs84");
      url.searchParams.set("rows", String(PAGE_SIZE));
      url.searchParams.set("start", String(start));
      const { payload } = await requestJson(url.toString());
      if (
        !payload ||
        typeof payload !== "object" ||
        !Array.isArray(payload.result)
      ) {
        throw new ZaragozaBusProviderError(
          "La respuesta municipal de paradas no contiene una lista válida",
          { code: "MALFORMED_RESPONSE" },
        );
      }
      payloads.push(payload);
      totalCount = Number(payload.totalCount);
      if (!Number.isFinite(totalCount) || totalCount < 0) {
        throw new ZaragozaBusProviderError(
          "La paginación municipal de paradas no es válida",
          { code: "MALFORMED_RESPONSE" },
        );
      }
      if (payload.result.length === 0 && start < totalCount) {
        throw new ZaragozaBusProviderError(
          "La paginación municipal de paradas terminó antes de tiempo",
          { code: "MALFORMED_RESPONSE" },
        );
      }
      start += payload.result.length;
    }
    return normalizeStopsPayloads(payloads);
  }

  async function fetchArrivals(stopId, { validators } = {}) {
    if (!URBAN_STOP_ID_PATTERN.test(stopId)) {
      throw new ZaragozaBusStopNotFoundError(stopId);
    }
    const url =
      `${BUS_STOP_DETAIL_API_URL}/${encodeURIComponent(stopId)}.json` +
      "?srsname=wgs84";
    const result = await requestJson(url, { validators });
    if (result.notModified) return result;
    return {
      value: normalizeArrivalsPayload(result.payload, stopId),
      validators: result.validators,
    };
  }

  return { fetchStops, fetchArrivals };
}

module.exports = {
  BUS_STOPS_API_URL,
  BUS_STOP_DETAIL_API_URL,
  DEFAULT_TIMEOUT_MS,
  PAGE_SIZE,
  PROVIDER,
  SOURCE,
  URBAN_STOP_ID_PATTERN,
  ZaragozaBusProviderError,
  ZaragozaBusStopNotFoundError,
  createZaragozaBusProvider,
  normalizeArrivalsPayload,
  normalizeDisplayTime,
  normalizeStop,
  normalizeStopsPayloads,
  parseStopTitle,
  zaragozaLocalToIso,
};
