const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createPersistentMobilityCache,
} = require("../api/services/persistentMobilityCache");

test("no consulta Mongo cuando la conexion no esta lista", async () => {
  const model = {
    findOne: () => assert.fail("no debe consultar"),
    findOneAndUpdate: () => assert.fail("no debe escribir"),
  };
  const cache = createPersistentMobilityCache({
    model,
    connection: { readyState: 0 },
  });

  assert.equal(await cache.get("bus-stops"), null);
  assert.equal(await cache.put("bus-stops", { stops: [] }), false);
});

test("devuelve una instantanea vigente marcada como stale", async () => {
  const updatedAt = new Date("2026-09-26T10:00:00.000Z");
  const cache = createPersistentMobilityCache({
    connection: { readyState: 1 },
    now: () => Date.parse("2026-09-26T11:00:00.000Z"),
    model: {
      findOne: () => ({
        lean: async () => ({
          payload: { provider: "zaragoza_bus", stops: [{ id: "1" }] },
          updatedAt,
        }),
      }),
    },
  });

  const result = await cache.get("bus-stops", { maxAgeMs: 2 * 60 * 60 * 1_000 });
  assert.equal(result.stale, true);
  assert.equal(result.persistentCache, true);
  assert.equal(result.cachedAt, updatedAt.toISOString());
  assert.equal(result.stops.length, 1);
});

test("descarta una instantanea demasiado antigua", async () => {
  const cache = createPersistentMobilityCache({
    connection: { readyState: 1 },
    now: () => Date.parse("2026-09-26T12:00:00.000Z"),
    model: {
      findOne: () => ({
        lean: async () => ({
          payload: { stops: [{ id: "1" }] },
          updatedAt: new Date("2026-09-26T10:00:00.000Z"),
        }),
      }),
    },
  });

  assert.equal(
    await cache.get("bus-stops", { maxAgeMs: 60 * 60 * 1_000 }),
    null,
  );
});
