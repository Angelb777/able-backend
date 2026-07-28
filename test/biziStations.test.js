const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { once } = require("node:events");
const {
  createBiziStationService,
  normalizeStation,
  normalizeStations,
} = require("../api/services/biziZaragozaProvider");
const { createMobilityRouter } = require("../api/routes/mobility");

const upstreamStation = {
  id: 34,
  title: "Puerta del Sol",
  estado: "IN_SERVICE",
  bicisDisponibles: 17.9,
  anclajesDisponibles: -5,
  geometry: {
    type: "Point",
    coordinates: [-0.870556, 41.654208],
  },
  lastUpdated: "2026-07-28T10:21:02Z",
};

function responseWith(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  };
}

test("normaliza tipos, coordenadas, disponibilidad, estado y fecha", () => {
  assert.deepEqual(normalizeStation(upstreamStation), {
    externalId: "34",
    provider: "bizi_zaragoza",
    city: "Zaragoza",
    name: "Puerta del Sol",
    latitude: 41.654208,
    longitude: -0.870556,
    vehiclesAvailable: 17,
    docksAvailable: 0,
    isOperational: true,
    status: "IN_SERVICE",
    lastUpdated: "2026-07-28T10:21:02.000Z",
  });
});

test("conserva la hora local ISO del Ayuntamiento cuando no incluye zona", () => {
  const station = normalizeStation({
    ...upstreamStation,
    lastUpdated: "2026-07-28T20:25:04",
  });

  assert.equal(station.lastUpdated, "2026-07-28T20:25:04");
});

test("descarta registros inválidos y elimina duplicados por ID", () => {
  const stations = normalizeStations({
    result: [
      upstreamStation,
      { ...upstreamStation, title: "Nombre actualizado" },
      { id: "sin-coordenadas" },
      {
        id: "fuera-de-rango",
        geometry: { coordinates: [-0.8, 123] },
      },
    ],
  });

  assert.equal(stations.length, 1);
  assert.equal(stations[0].name, "Nombre actualizado");
});

test("reutiliza la caché durante 60 segundos", async () => {
  let currentTime = Date.parse("2026-07-28T12:00:00Z");
  let calls = 0;
  const service = createBiziStationService({
    now: () => currentTime,
    fetchImpl: async () => {
      calls += 1;
      return responseWith({ result: [upstreamStation] });
    },
  });

  const fresh = await service.getStations();
  currentTime += 59_999;
  const cached = await service.getStations();

  assert.equal(calls, 1);
  assert.equal(fresh.fromCache, false);
  assert.equal(cached.fromCache, true);
  assert.equal(cached.stale, false);
});

test("devuelve la última respuesta válida como stale si falla el origen", async () => {
  let currentTime = Date.parse("2026-07-28T12:00:00Z");
  let shouldFail = false;
  const service = createBiziStationService({
    now: () => currentTime,
    fetchImpl: async () => {
      if (shouldFail) throw new Error("fallo simulado");
      return responseWith({ result: [upstreamStation] });
    },
  });

  await service.getStations();
  currentTime += 60_001;
  shouldFail = true;
  const stale = await service.getStations();

  assert.equal(stale.fromCache, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.stations.length, 1);
});

test("falla de forma controlada si nunca hubo datos válidos", async () => {
  const service = createBiziStationService({
    fetchImpl: async () => responseWith({ result: [] }),
  });

  await assert.rejects(
    service.getStations(),
    /no contiene estaciones válidas/,
  );
});

test("el endpoint responde 502 sin exponer trazas si no hay datos", async (t) => {
  const app = express();
  app.use(
    "/api/mobility",
    createMobilityRouter({
      biziStations: {
        getStations: async () => {
          throw new Error("detalle interno sensible");
        },
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/mobility/bizi/stations`,
  );
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.equal(body.error, "BIZI_STATIONS_UNAVAILABLE");
  assert.equal(JSON.stringify(body).includes("detalle interno sensible"), false);
  assert.equal(JSON.stringify(body).includes("stack"), false);
});
