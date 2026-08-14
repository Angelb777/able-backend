const express = require("express");
const { rateLimit } = require("express-rate-limit");
const {
  WeatherUpstreamError,
  createWeatherService,
} = require("../services/weatherService");

function createWeatherRouter({ weather = createWeatherService() } = {}) {
  const router = express.Router();
  router.use(rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }));

  router.get("/current", async (req, res) => {
    const latitude = Number(req.query.latitude);
    const longitude = Number(req.query.longitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return res.status(400).json({
        error: "INVALID_COORDINATES",
        message: "Las coordenadas no son válidas",
      });
    }
    try {
      return res.json(await weather.getCurrent(latitude, longitude));
    } catch (error) {
      const detail = error instanceof WeatherUpstreamError
        ? error.message
        : "Error inesperado consultando meteorología";
      console.error(`[weather] ${detail}`);
      return res.status(502).json({
        error: "WEATHER_UNAVAILABLE",
        message: "La meteorología no está disponible temporalmente",
      });
    }
  });

  return router;
}

module.exports = createWeatherRouter();
module.exports.createWeatherRouter = createWeatherRouter;
