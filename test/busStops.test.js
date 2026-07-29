const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { once } = require("node:events");
const {
  ZaragozaBusProviderError,
  ZaragozaBusStopNotFoundError,
  createZaragozaBusProvider,
  normalizeArrivalsPayload,
  normalizeDisplayTime,
  normalizeStop,
  normalizeStopsPayloads,
} = require("../api/services/zaragozaBusProvider");
const {
  createBusStopService,
} = require("../api/services/busStopService");
const { createMobilityRouter } = require("../api/routes/mobility");

const rawStop = {
  id: "tuzsa-905",
  title: "(905) Vía Ibérica / Hospital Militar Líneas: 57, 58, N4, 42",
  geometry: {
    type: "Point",
    coordinates: [-0.9059113788285126, 41.63082484981311],
  },
  gtfsId: "17576",
};

const rawArrivals = {
  ...rawStop,
  lastUpdated: "2026-07-29T14:01:48",
  destinos: [
    {
      linea: "42",
      destino: "LA PAZ.",
      primero: "En la parada.",
      segundo: "15 minutos.",
    },
    {
      linea: "57",
      destino: "CASABLANCA.",
      primero: "Llegando.",
      segundo: "10 minutos.",
    },
    {
      linea: "58",
      destino: "FUENTE JUNQUERA.",
      primero: "5 minutos.",
      segundo: "32 minutos.",
    },
  ],
};

function headers(values = {}) {
  const normalized = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return { get: (key) => normalized[key.toLowerCase()] ?? null };
}

function responseWith(payload, { status = 200, responseHeaders = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headers(responseHeaders),
    json: async () => payload,
  };
}

function normalizedDetails(overrides = {}) {
  return {
    provider: "zaragoza_bus",
    source: "Ayuntamiento de Zaragoza",
    stop: {
      id: "tuzsa-905",
      code: "905",
      name: "Vía Ibérica / Hospital Militar",
      latitude: 41.63082484981311,
      longitude: -0.9059113788285126,
      lines: ["57", "58", "N4", "42"],
    },
    arrivals: [],
    updatedAt: "2026-07-29T12:01:48.000Z",
    ...overrides,
  };
}

test("normaliza una parada urbana, coordenadas, código, nombre y líneas", () => {
  assert.deepEqual(normalizeStop(rawStop), {
    id: "tuzsa-905",
    code: "905",
    name: "Vía Ibérica / Hospital Militar",
    latitude: 41.63082484981311,
    longitude: -0.9059113788285126,
    lines: ["57", "58", "N4", "42"],
  });
});

test("rechaza rurales, coordenadas nulas, no numéricas y fuera de rango", () => {
  assert.equal(normalizeStop({ ...rawStop, id: "rural-905" }), null);
  assert.equal(normalizeStop({ ...rawStop, geometry: null }), null);
  assert.equal(
    normalizeStop({
      ...rawStop,
      geometry: { coordinates: ["x", 41.6] },
    }),
    null,
  );
  assert.equal(
    normalizeStop({
      ...rawStop,
      geometry: { coordinates: [-0.8, 100] },
    }),
    null,
  );
});

test("elimina duplicados por id sin fusionar postes físicos distintos", () => {
  const stops = normalizeStopsPayloads([
    {
      result: [
        rawStop,
        { ...rawStop, title: "(905) Nombre actualizado Líneas: 42" },
        { ...rawStop, id: "tuzsa-906", title: "(906) Otro poste Líneas: 42" },
        { ...rawStop, id: "rural-1" },
      ],
    },
  ]);

  assert.equal(stops.length, 2);
  assert.equal(stops.find((stop) => stop.id === "tuzsa-905").name, "Nombre actualizado");
  assert.ok(stops.some((stop) => stop.id === "tuzsa-906"));
});

test("normaliza y ordena próximos tiempos sin inventar destinos ni horas", () => {
  const result = normalizeArrivalsPayload(rawArrivals, "tuzsa-905");

  assert.equal(result.updatedAt, "2026-07-29T12:01:48.000Z");
  assert.deepEqual(
    result.arrivals.map(({ line, destination, minutes, displayTime, status }) => ({
      line,
      destination,
      minutes,
      displayTime,
      status,
    })),
    [
      {
        line: "42",
        destination: "LA PAZ",
        minutes: null,
        displayTime: "En parada",
        status: "at_stop",
      },
      {
        line: "57",
        destination: "CASABLANCA",
        minutes: null,
        displayTime: "Llegando",
        status: "arriving",
      },
      {
        line: "58",
        destination: "FUENTE JUNQUERA",
        minutes: 5,
        displayTime: "5 min",
        status: "estimated",
      },
      {
        line: "57",
        destination: "CASABLANCA",
        minutes: 10,
        displayTime: "10 min",
        status: "estimated",
      },
      {
        line: "42",
        destination: "LA PAZ",
        minutes: 15,
        displayTime: "15 min",
        status: "estimated",
      },
      {
        line: "58",
        destination: "FUENTE JUNQUERA",
        minutes: 32,
        displayTime: "32 min",
        status: "estimated",
      },
    ],
  );
  assert.ok(result.arrivals.every((arrival) => arrival.estimatedArrival === null));
});

test("tipa En parada, Llegando, menos de un minuto y estados sin tiempo", () => {
  assert.deepEqual(normalizeDisplayTime("En la parada."), {
    minutes: null,
    displayTime: "En parada",
    status: "at_stop",
    sortMinutes: 0,
  });
  assert.equal(normalizeDisplayTime("Llegando").status, "arriving");
  assert.equal(normalizeDisplayTime("Menos de 1 minuto").displayTime, "Menos de 1 min");
  assert.equal(normalizeDisplayTime("Sin estimación").status, "unavailable");
  assert.equal(normalizeDisplayTime("Servicio finalizado").status, "service_ended");
});

test("acepta una respuesta municipal válida sin próximos tiempos", () => {
  const result = normalizeArrivalsPayload(
    { ...rawStop, lastUpdated: "2026-07-29T14:01:48", destinos: [] },
    "tuzsa-905",
  );
  assert.deepEqual(result.arrivals, []);
});

test("rechaza respuestas municipales vacías o malformadas", () => {
  assert.throws(
    () => normalizeStopsPayloads([{ result: [] }]),
    /no contiene paradas urbanas válidas/,
  );
  assert.throws(
    () => normalizeStopsPayloads([{ result: "incorrecto" }]),
    /no contiene una lista válida/,
  );
  assert.throws(
    () =>
      normalizeArrivalsPayload(
        { ...rawStop, destinos: { linea: "42" } },
        "tuzsa-905",
      ),
    /tiempos malformados/,
  );
});

test("el provider pagina el listado municipal en bloques de 500 y pide WGS84", async () => {
  const requested = [];
  const provider = createZaragozaBusProvider({
    fetchImpl: async (url) => {
      requested.push(new URL(url));
      const start = Number(new URL(url).searchParams.get("start"));
      const items = start === 0
        ? Array.from({ length: 500 }, (_, index) => ({
          ...rawStop,
          id: `tuzsa-${index + 1}`,
          title: `(${index + 1}) Parada ${index + 1} Líneas: 21`,
        }))
        : [{ ...rawStop, id: "tuzsa-501", title: "(501) Final Líneas: 22" }];
      return responseWith({ totalCount: 501, start, rows: 500, result: items });
    },
  });

  const stops = await provider.fetchStops();

  assert.equal(stops.length, 501);
  assert.equal(requested.length, 2);
  assert.deepEqual(requested.map((url) => url.searchParams.get("start")), ["0", "500"]);
  assert.ok(requested.every((url) => url.searchParams.get("srsname") === "wgs84"));
});

test("la caché larga de paradas evita nuevas llamadas", async () => {
  let currentTime = Date.parse("2026-07-29T10:00:00Z");
  let calls = 0;
  const service = createBusStopService({
    now: () => currentTime,
    provider: {
      fetchStops: async () => {
        calls += 1;
        return [normalizeStop(rawStop)];
      },
    },
  });

  const fresh = await service.getStops();
  currentTime += 11 * 60 * 60 * 1_000;
  const cached = await service.getStops();

  assert.equal(calls, 1);
  assert.equal(fresh.fromCache, false);
  assert.equal(cached.fromCache, true);
  assert.equal(cached.stale, false);
});

test("la caché corta es independiente por stopId", async () => {
  let currentTime = Date.parse("2026-07-29T10:00:00Z");
  const calls = [];
  const service = createBusStopService({
    now: () => currentTime,
    provider: {
      fetchArrivals: async (stopId) => {
        calls.push(stopId);
        return {
          value: normalizedDetails({
            stop: { ...normalizedDetails().stop, id: stopId },
          }),
          validators: {},
        };
      },
    },
  });

  await service.getArrivals("tuzsa-905");
  await service.getArrivals("tuzsa-905");
  await service.getArrivals("tuzsa-906");
  currentTime += 30_001;
  await service.getArrivals("tuzsa-905");

  assert.deepEqual(calls, ["tuzsa-905", "tuzsa-906", "tuzsa-905"]);
});

test("deduplica peticiones simultáneas de tiempos para la misma parada", async () => {
  let calls = 0;
  let resolveRequest;
  const pending = new Promise((resolve) => {
    resolveRequest = resolve;
  });
  const service = createBusStopService({
    provider: {
      fetchArrivals: async () => {
        calls += 1;
        await pending;
        return { value: normalizedDetails(), validators: {} };
      },
    },
  });

  const first = service.getArrivals("tuzsa-905");
  const second = service.getArrivals("tuzsa-905");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  resolveRequest();
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(left.stop, right.stop);
});

test("devuelve la última lista válida como stale si caduca y falla el origen", async () => {
  let currentTime = Date.parse("2026-07-29T10:00:00Z");
  let fail = false;
  const service = createBusStopService({
    now: () => currentTime,
    stopsCacheTtlMs: 100,
    provider: {
      fetchStops: async () => {
        if (fail) throw new ZaragozaBusProviderError("fallo");
        return [normalizeStop(rawStop)];
      },
    },
  });
  await service.getStops();
  currentTime += 101;
  fail = true;

  const stale = await service.getStops();
  assert.equal(stale.stale, true);
  assert.equal(stale.stops.length, 1);
});

test("devuelve los últimos tiempos como stale solo durante la ventana temporal", async () => {
  let currentTime = Date.parse("2026-07-29T10:00:00Z");
  let fail = false;
  const service = createBusStopService({
    now: () => currentTime,
    arrivalsCacheTtlMs: 100,
    provider: {
      fetchArrivals: async () => {
        if (fail) throw new ZaragozaBusProviderError("fallo");
        return { value: normalizedDetails(), validators: {} };
      },
    },
  });
  await service.getArrivals("tuzsa-905");
  currentTime += 101;
  fail = true;

  const stale = await service.getArrivals("tuzsa-905");
  assert.equal(stale.stale, true);

  currentTime += 5 * 60 * 1_000;
  await assert.rejects(
    service.getArrivals("tuzsa-905"),
    /fallo/,
  );
});

test("reutiliza la respuesta válida cuando el Ayuntamiento responde 304", async () => {
  let currentTime = Date.parse("2026-07-29T10:00:00Z");
  let calls = 0;
  const service = createBusStopService({
    now: () => currentTime,
    arrivalsCacheTtlMs: 100,
    provider: {
      fetchArrivals: async (_stopId, options) => {
        calls += 1;
        if (calls === 2) {
          assert.equal(options.validators.etag, '"bus-1"');
          return { notModified: true };
        }
        return {
          value: normalizedDetails(),
          validators: { etag: '"bus-1"' },
        };
      },
    },
  });
  await service.getArrivals("tuzsa-905");
  currentTime += 101;

  const cached = await service.getArrivals("tuzsa-905");
  assert.equal(cached.fromCache, true);
  assert.equal(cached.stale, false);
  assert.equal(calls, 2);
});

test("convierte timeout externo en error controlado", async () => {
  const provider = createZaragozaBusProvider({
    timeoutMs: 5,
    fetchImpl: async (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });

  await assert.rejects(
    provider.fetchArrivals("tuzsa-905"),
    (error) =>
      error instanceof ZaragozaBusProviderError &&
      error.code === "TIMEOUT",
  );
});

test("traduce 404 municipal a parada inexistente", async () => {
  const provider = createZaragozaBusProvider({
    fetchImpl: async () => responseWith({}, { status: 404 }),
  });
  await assert.rejects(
    provider.fetchArrivals("tuzsa-99999"),
    ZaragozaBusStopNotFoundError,
  );
});

test("los endpoints internos responden con contratos controlados", async (t) => {
  const app = express();
  app.use(
    "/api/mobility",
    createMobilityRouter({
      biziStations: { getStations: async () => ({ stations: [] }) },
      busStops: {
        getStops: async () => ({
          provider: "zaragoza_bus",
          updatedAt: "2026-07-29T10:00:00.000Z",
          stale: false,
          stops: [normalizeStop(rawStop)],
        }),
        getArrivals: async (stopId) => {
          if (stopId === "tuzsa-99999") {
            throw new ZaragozaBusStopNotFoundError(stopId);
          }
          return { ...normalizedDetails(), stale: false };
        },
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api/mobility`;

  const stopsResponse = await fetch(`${base}/bus/stops`);
  const stopsBody = await stopsResponse.json();
  assert.equal(stopsResponse.status, 200);
  assert.equal(stopsBody.stops[0].id, "tuzsa-905");

  const invalidResponse = await fetch(`${base}/bus/stops/905/arrivals`);
  assert.equal(invalidResponse.status, 400);

  const missingResponse = await fetch(
    `${base}/bus/stops/tuzsa-99999/arrivals`,
  );
  const missingBody = await missingResponse.json();
  assert.equal(missingResponse.status, 404);
  assert.equal(missingBody.error, "BUS_STOP_NOT_FOUND");
});

test("el endpoint de tiempos no expone trazas ante un fallo inesperado", async (t) => {
  const app = express();
  app.use(
    "/api/mobility",
    createMobilityRouter({
      biziStations: { getStations: async () => ({ stations: [] }) },
      busStops: {
        getStops: async () => ({ stops: [] }),
        getArrivals: async () => {
          throw new Error("detalle interno sensible");
        },
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/mobility/bus/stops/tuzsa-905/arrivals`,
  );
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.error, "BUS_ARRIVALS_UNAVAILABLE");
  assert.equal(JSON.stringify(body).includes("detalle interno sensible"), false);
  assert.equal(JSON.stringify(body).includes("stack"), false);
});
