const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { verifyToken } = require('../middlewares/authMiddleware');
const {
  GoogleMapsMobileServiceError,
  createGoogleMapsMobileService,
  validCoordinate,
} = require('../services/googleMapsMobileService');

const DIRECTIONS_MODES = new Set(['walking', 'bicycling', 'driving', 'transit']);

function limiter(limit) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => String(req.user.id),
    handler: (_req, res) => res.status(429).json({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Demasiadas solicitudes de mapas. Intentalo de nuevo en un minuto.',
    }),
  });
}

function text(value, maxLength) {
  const normalized = String(value ?? '').trim();
  return normalized && normalized.length <= maxLength ? normalized : '';
}

function createGoogleMapsRouter({
  maps = createGoogleMapsMobileService(),
  authenticate = verifyToken,
  limits = {},
  disableRateLimit = false,
} = {}) {
  const router = express.Router();
  router.use(authenticate);

  const applyLimit = (value) => disableRateLimit
    ? (_req, _res, next) => next()
    : limiter(value);

  router.post('/directions', applyLimit(limits.directions || 60), async (req, res) => {
    const origin = {
      lat: Number(req.body?.origin?.lat),
      lng: Number(req.body?.origin?.lng),
    };
    const destination = {
      lat: Number(req.body?.destination?.lat),
      lng: Number(req.body?.destination?.lng),
    };
    const mode = text(req.body?.mode, 20);
    if (!validCoordinate(origin) || !validCoordinate(destination) ||
        !DIRECTIONS_MODES.has(mode)) {
      return res.status(400).json({
        error: 'INVALID_DIRECTIONS_REQUEST',
        message: 'Origen, destino o modo de transporte no validos.',
      });
    }
    try {
      return res.json(await maps.directions({ origin, destination, mode }));
    } catch (error) {
      return upstreamFailure(res, error, 'Directions');
    }
  });

  router.post('/places/autocomplete', applyLimit(limits.autocomplete || 120), async (req, res) => {
    const input = text(req.body?.input, 200);
    const sessionToken = text(req.body?.sessionToken, 128);
    const rawOrigin = req.body?.origin;
    const origin = rawOrigin == null ? null : {
      lat: Number(rawOrigin.lat),
      lng: Number(rawOrigin.lng),
    };
    if (input.length < 2 || !sessionToken || (origin && !validCoordinate(origin))) {
      return res.status(400).json({
        error: 'INVALID_AUTOCOMPLETE_REQUEST',
        message: 'La busqueda o la sesion de Places no son validas.',
      });
    }
    try {
      return res.json(await maps.autocomplete({ input, sessionToken, origin }));
    } catch (error) {
      return upstreamFailure(res, error, 'Places autocomplete');
    }
  });

  router.post('/places/details', applyLimit(limits.details || 30), async (req, res) => {
    const placeId = text(req.body?.placeId, 512);
    const sessionToken = text(req.body?.sessionToken, 128);
    if (!placeId || !sessionToken) {
      return res.status(400).json({
        error: 'INVALID_PLACE_DETAILS_REQUEST',
        message: 'El lugar o la sesion de Places no son validos.',
      });
    }
    try {
      return res.json(await maps.details({ placeId, sessionToken }));
    } catch (error) {
      return upstreamFailure(res, error, 'Places details');
    }
  });

  return router;
}

function upstreamFailure(res, error, operation) {
  const controlled = error instanceof GoogleMapsMobileServiceError;
  console.error(`[google-maps:${operation}] ${controlled ? error.message : 'Unexpected error'}`);
  return res.status(controlled ? error.status : 502).json({
    error: controlled ? error.code : 'GOOGLE_MAPS_UNAVAILABLE',
    message: 'Google Maps no esta disponible temporalmente.',
  });
}

module.exports = createGoogleMapsRouter();
module.exports.createGoogleMapsRouter = createGoogleMapsRouter;
