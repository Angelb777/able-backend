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

function createMobilityRouter({
  biziStations = createBiziStationService(),
  busStops = createBusStopService(),
  tramStops = createTramStopService(),
} = {}) {
  const router = express.Router();

  router.get("/bizi/stations", async (_req, res) => {
    try {
      res.json(await biziStations.getStations());
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
      res.json(await busStops.getStops());
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
      res.json(await tramStops.getStops());
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
