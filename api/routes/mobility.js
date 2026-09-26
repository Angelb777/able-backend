const express = require("express");
const {
  BiziUpstreamError,
  createBiziStationService,
} = require("../services/biziZaragozaProvider");
const { createBusStopService } = require("../services/busStopService");
const {
  URBAN_STOP_ID_PATTERN,
  ZaragozaBusProviderError,
  ZaragozaBusStopNotFoundError,
} = require("../services/zaragozaBusProvider");
const { createTramStopService } = require("../services/tramStopService");
const {
  TRAM_STOP_ID_PATTERN,
  ZaragozaTramProviderError,
  ZaragozaTramStopNotFoundError,
} = require("../services/zaragozaTramProvider");
const {
  createPersistentMobilityCache,
} = require("../services/persistentMobilityCache");

const BIZI_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const STOP_SNAPSHOT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000;

function createMobilityRouter({
  biziStations = createBiziStationService(),
  busStops = createBusStopService(),
  tramStops = createTramStopService(),
  persistentCache = createPersistentMobilityCache(),
} = {}) {
  const router = express.Router();

  async function loadWithPersistentFallback(key, loader, maxAgeMs) {
    try {
      const value = await loader();
      if (value?.fromCache !== true && value?.stale !== true) {
        persistentCache.put(key, value).catch((error) => {
          console.warn(`[mobility:cache:write] ${key}: ${error.message}`);
        });
      }
      return value;
    } catch (upstreamError) {
      try {
        const cached = await persistentCache.get(key, { maxAgeMs });
        if (cached) return cached;
      } catch (cacheError) {
        console.warn(`[mobility:cache:read] ${key}: ${cacheError.message}`);
      }
      throw upstreamError;
    }
  }

  router.get("/bizi/stations", async (_req, res) => {
    try {
      res.json(await loadWithPersistentFallback(
        "bizi-stations",
        () => biziStations.getStations(),
        BIZI_SNAPSHOT_MAX_AGE_MS,
      ));
    } catch (error) {
      const controlledError =
        error instanceof BiziUpstreamError
          ? error.message
          : "Error inesperado consultando las estaciones Bizi";
      console.error(`[mobility:bizi] ${controlledError}`);
      res.status(502).json({
        error: "BIZI_STATIONS_UNAVAILABLE",
        message: "Las estaciones Bizi no están disponibles temporalmente",
      });
    }
  });

  router.get("/bus/stops", async (_req, res) => {
    try {
      res.json(await loadWithPersistentFallback(
        "bus-stops",
        () => busStops.getStops(),
        STOP_SNAPSHOT_MAX_AGE_MS,
      ));
    } catch (error) {
      const controlledError =
        error instanceof ZaragozaBusProviderError
          ? error.message
          : "Error inesperado consultando las paradas de autobús";
      console.error(`[mobility:bus:stops] ${controlledError}`);
      res.status(502).json({
        error: "BUS_STOPS_UNAVAILABLE",
        message: "Las paradas de autobús no están disponibles temporalmente",
      });
    }
  });

  router.get("/bus/stops/:stopId/arrivals", async (req, res) => {
    const stopId = String(req.params.stopId ?? "").trim();
    if (!URBAN_STOP_ID_PATTERN.test(stopId)) {
      return res.status(400).json({
        error: "INVALID_BUS_STOP_ID",
        message: "El identificador de parada no es válido",
      });
    }

    try {
      return res.json(await busStops.getArrivals(stopId));
    } catch (error) {
      if (error instanceof ZaragozaBusStopNotFoundError) {
        return res.status(404).json({
          error: "BUS_STOP_NOT_FOUND",
          message: "La parada de autobús no existe",
        });
      }
      const controlledError =
        error instanceof ZaragozaBusProviderError
          ? error.message
          : "Error inesperado consultando los tiempos de autobús";
      console.error(`[mobility:bus:arrivals] ${controlledError}`);
      return res.status(502).json({
        error: "BUS_ARRIVALS_UNAVAILABLE",
        message: "Los tiempos de autobús no están disponibles temporalmente",
      });
    }
  });

  router.get("/tram/stops", async (_req, res) => {
    try {
      res.json(await loadWithPersistentFallback(
        "tram-stops",
        () => tramStops.getStops(),
        STOP_SNAPSHOT_MAX_AGE_MS,
      ));
    } catch (error) {
      const controlledError =
        error instanceof ZaragozaTramProviderError
          ? error.message
          : "Error inesperado consultando las paradas de tranvía";
      console.error(`[mobility:tram:stops] ${controlledError}`);
      res.status(502).json({
        error: "TRAM_STOPS_UNAVAILABLE",
        message: "Las paradas de tranvía no están disponibles temporalmente",
      });
    }
  });

  router.get("/tram/stops/:stopId/arrivals", async (req, res) => {
    const stopId = String(req.params.stopId ?? "").trim();
    if (!TRAM_STOP_ID_PATTERN.test(stopId)) {
      return res.status(400).json({
        error: "INVALID_TRAM_STOP_ID",
        message: "El identificador de parada de tranvía no es válido",
      });
    }
    try {
      return res.json(await tramStops.getArrivals(stopId));
    } catch (error) {
      if (error instanceof ZaragozaTramStopNotFoundError) {
        return res.status(404).json({
          error: "TRAM_STOP_NOT_FOUND",
          message: "La parada de tranvía no existe",
        });
      }
      const controlledError =
        error instanceof ZaragozaTramProviderError
          ? error.message
          : "Error inesperado consultando los tiempos de tranvía";
      console.error(`[mobility:tram:arrivals] ${controlledError}`);
      return res.status(502).json({
        error: "TRAM_ARRIVALS_UNAVAILABLE",
        message: "Los tiempos de tranvía no están disponibles temporalmente",
      });
    }
  });

  return router;
}

module.exports = createMobilityRouter();
module.exports.createMobilityRouter = createMobilityRouter;
module.exports.BIZI_SNAPSHOT_MAX_AGE_MS = BIZI_SNAPSHOT_MAX_AGE_MS;
module.exports.STOP_SNAPSHOT_MAX_AGE_MS = STOP_SNAPSHOT_MAX_AGE_MS;
