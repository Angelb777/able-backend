const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { once } = require("node:events");
const {
  ZaragozaTramProviderError,
  ZaragozaTramStopNotFoundError,
  createZaragozaTramProvider,
  normalizeTramArrivalsPayload,
  normalizeTramStop,
  normalizeTramStopsPayloads,
} = require("../api/services/zaragozaTramProvider");
const {
  createTramStopService,
} = require("../api/services/tramStopService");
const { createMobilityRouter } = require("../api/routes/mobility");

const rawStop = {
  id: "101",
  title: "AVENIDA DE LA ACADEMIA",
  geometry: {
    type: "Point",
    coordinates: [-0.8708043196472608, 41.68721736857768],
  },
};

const rawDetails = {
  ...rawStop,
  lastUpdated: "2026-07-29T14:42:01",
  destinos: [
    { linea: "L1", destino: "MAGO DE OZ", minutos: 6 },
    { linea: "L1", destino: "MAGO DE OZ", minutos: 0 },
    { linea: "L1", destino: "MAGO DE OZ", minutos: 15 },
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
    provider: "zaragoza_tram",
    source: "Ayuntamiento de Zaragoza",
    stop: {
      id: "101",
      name: "AVENIDA DE LA ACADEMIA",
      latitude: 41.68721736857768,
      longitude: -0.8708043196472608,
      lines: ["L1"],
    },
    arrivals: [],
    updatedAt: "2026-07-29T12:42:01.000Z",
    ...overrides,
  };
}

test("normaliza una parada física de tranvía con coordenadas WGS84", () => {
  assert.deepEqual(normalizeTramStop(rawStop), {
    id: "101",
    name: "AVENIDA DE LA ACADEMIA",
    latitude: 41.68721736857768,
    longitude: -0.8708043196472608,
    lines: [],
  });
});

test("rechaza identificadores, nombres y coordenadas inválidas", () => {
  assert.equal(normalizeTramStop({ ...rawStop, id: "tram-101" }), null);
  assert.equal(normalizeTramStop({ ...rawStop, title: "" }), null);
  assert.equal(normalizeTramStop({ ...rawStop, geometry: null }), null);
  assert.equal(
    normalizeTramStop({
      ...rawStop,
      geometry: { coordinates: [-0.8, 100] },
    }),
    null,
  );
});

test("deduplica por id sin fusionar andenes con el mismo nombre", () => {
  const stops = normalizeTramStopsPayloads([
    {
      result: [
        rawStop,
        { ...rawStop, title: "NOMBRE ACTUALIZADO" },
        { ...rawStop, id: "102" },
      ],
    },
  ]);
  assert.equal(stops.length, 2);
  assert.equal(stops.find((stop) => stop.id === "101").name, "NOMBRE ACTUALIZADO");
  assert.ok(stops.some((stop) => stop.id === "102"));
});

test("normaliza, ordena y conserva destino y cero minutos", () => {
  const result = normalizeTramArrivalsPayload(rawDetails, "101");
  assert.equal(result.updatedAt, "2026-07-29T12:42:01.000Z");
  assert.deepEqual(
    result.arrivals.map(({ minutes, displayTime, status }) => ({
      minutes,
      displayTime,
      status,
    })),
    [
      { minutes: 0, displayTime: "En parada", status: "at_stop" },
      { minutes: 6, displayTime: "6 min", status: "estimated" },
      { minutes: 15, displayTime: "15 min", status: "estimated" },
    ],
  );
  assert.ok(result.arrivals.every((arrival) => arrival.destination === "MAGO DE OZ"));
  assert.deepEqual(result.stop.lines, ["L1"]);
});

test("acepta una parada sin próximos tranvías y rechaza tiempos malformados", () => {
  assert.deepEqual(
    normalizeTramArrivalsPayload({ ...rawStop, destinos: [] }, "101").arrivals,
    [],
  );
  assert.throws(
    () =>
      normalizeTramArrivalsPayload(
        { ...rawStop, destinos: { linea: "L1" } },
        "101",
      ),
    /malformados/,
  );
});

test("el provider proyecta campos, pagina y solicita WGS84", async () => {
  const requested = [];
  const provider = createZaragozaTramProvider({
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      requested.push(parsed);
      const start = Number(parsed.searchParams.get("start"));
      return responseWith({
        totalCount: 2,
        start,
        result:
          start === 0
            ? [
              rawStop,
              { ...rawStop, id: "102", title: "SEGUNDO ANDÉN" },
            ]
            : [],
      });
    },
  });
  const stops = await provider.fetchStops();
  assert.equal(stops.length, 2);
  assert.equal(requested.length, 1);
  assert.equal(requested[0].searchParams.get("srsname"), "wgs84");
  assert.equal(requested[0].searchParams.get("fl"), "id,title,geometry");
});

test("la caché larga evita recargar el listado", async () => {
  let currentTime = Date.parse("2026-07-29T10:00:00Z");
  let calls = 0;
  const service = createTramStopService({
    now: () => currentTime,
    provider: {
      fetchStops: async () => {
        calls += 1;
        return [normalizeTramStop(rawStop)];
      },
    },
  });
  await service.getStops();
  currentTime += 11 * 60 * 60 * 1_000;
  const cached = await service.getStops();
  assert.equal(calls, 1);
  assert.equal(cached.fromCache, true);
  assert.equal(cached.stale, false);
});

test("la caché de llegadas es independiente por stopId", async () => {
  let currentTime = Date.parse("2026-07-29T10:00:00Z");
  const calls = [];
  const service = createTramStopService({
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
  await service.getArrivals("101");
  await service.getArrivals("101");
  await service.getArrivals("102");
  currentTime += 30_001;
  await service.getArrivals("101");
  assert.deepEqual(calls, ["101", "102", "101"]);
});

test("deduplica peticiones simultáneas para la misma parada", async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const service = createTramStopService({
    provider: {
      fetchArrivals: async () => {
        calls += 1;
        await pending;
        return { value: normalizedDetails(), validators: {} };
      },
    },
  });
  const first = service.getArrivals("101");
  const second = service.getArrivals("101");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
});

test("devuelve listado y tiempos stale cuando falla el origen", async () => {
  let currentTime = Date.parse("2026-07-29T10:00:00Z");
  let fail = false;
  const provider = {
    fetchStops: async () => {
      if (fail) throw new ZaragozaTramProviderError("fallo");
      return [normalizeTramStop(rawStop)];
    },
    fetchArrivals: async () => {
      if (fail) throw new ZaragozaTramProviderError("fallo");
      return { value: normalizedDetails(), validators: {} };
    },
  };
  const service = createTramStopService({
    now: () => currentTime,
    stopsCacheTtlMs: 100,
    arrivalsCacheTtlMs: 100,
    provider,
  });
  await service.getStops();
  await service.getArrivals("101");
  currentTime += 101;
  fail = true;
  assert.equal((await service.getStops()).stale, true);
  assert.equal((await service.getArrivals("101")).stale, true);
});

test("convierte timeout externo en error controlado", async () => {
  const provider = createZaragozaTramProvider({
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
    provider.fetchArrivals("101"),
    (error) =>
      error instanceof ZaragozaTramProviderError &&
      error.code === "TIMEOUT",
  );
});

test("traduce un 404 municipal a parada inexistente", async () => {
  const provider = createZaragozaTramProvider({
    fetchImpl: async () => responseWith({}, { status: 404 }),
  });
  await assert.rejects(
    provider.fetchArrivals("99999"),
    ZaragozaTramStopNotFoundError,
  );
});

test("los endpoints internos exponen contratos controlados", async (t) => {
  const app = express();
  app.use(
    "/api/mobility",
    createMobilityRouter({
      biziStations: { getStations: async () => ({ stations: [] }) },
      busStops: {
        getStops: async () => ({ stops: [] }),
        getArrivals: async () => ({}),
      },
      tramStops: {
        getStops: async () => ({
          provider: "zaragoza_tram",
          stops: [normalizeTramStop(rawStop)],
        }),
        getArrivals: async (stopId) => {
          if (stopId === "99999") {
            throw new ZaragozaTramStopNotFoundError(stopId);
          }
          return normalizedDetails();
        },
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api/mobility`;

  const stops = await fetch(`${base}/tram/stops`);
  assert.equal(stops.status, 200);
  assert.equal((await stops.json()).stops[0].id, "101");
  assert.equal((await fetch(`${base}/tram/stops/no/arrivals`)).status, 400);
  assert.equal((await fetch(`${base}/tram/stops/99999/arrivals`)).status, 404);
});
