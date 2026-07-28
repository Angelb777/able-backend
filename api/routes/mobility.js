const express = require("express");
const {
  BiziUpstreamError,
  createBiziStationService,
} = require("../services/biziZaragozaProvider");

function createMobilityRouter({
  biziStations = createBiziStationService(),
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

  return router;
}

module.exports = createMobilityRouter();
module.exports.createMobilityRouter = createMobilityRouter;
