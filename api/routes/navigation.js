const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { verifyToken } = require('../middlewares/authMiddleware');
const { authenticatedUserKey } = require('../middlewares/securityLimits');
const { createGroundRouteProvider } = require('../services/groundRouteProvider');
const { validPoint } = require('../services/valhallaDirections');

const ROUTING_MODES = new Set(['pedestrian', 'bicycle', 'auto']);

function createNavigationRouter({
  routing = createGroundRouteProvider(),
  authenticate = verifyToken,
  disableRateLimit = false,
} = {}) {
  const router = express.Router();
  router.use(authenticate);
  if (!disableRateLimit) {
    router.use(rateLimit({
      windowMs: 60 * 1000,
      limit: 45,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      keyGenerator: authenticatedUserKey,
      handler: (_req, res) => res.status(429).json({
        error: 'ROUTING_RATE_LIMIT_EXCEEDED',
        message: 'Demasiadas solicitudes de rutas. Intentalo de nuevo en un minuto.',
      }),
    }));
  }

  router.post('/directions', async (req, res) => {
    const origin = {
      lat: Number(req.body?.origin?.lat),
      lng: Number(req.body?.origin?.lng),
    };
    const destination = {
      lat: Number(req.body?.destination?.lat),
      lng: Number(req.body?.destination?.lng),
    };
    const mode = String(req.body?.mode || '').trim().toLowerCase();
    if (!validPoint(origin) || !validPoint(destination) || !ROUTING_MODES.has(mode)) {
      return res.status(400).json({
        error: 'INVALID_DIRECTIONS_REQUEST',
        message: 'Origen, destino o modo de transporte no validos.',
      });
    }
    try {
      const route = await routing.getRouteDetails(origin, destination, mode);
      return res.json({ status: 'OK', route });
    } catch (error) {
      const unavailable = error?.message === 'VALHALLA_EMPTY_ROUTE';
      console.error(`[navigation:directions] ${error?.message || 'unknown'}`);
      return res.status(unavailable ? 422 : 503).json({
        error: unavailable ? 'ROUTE_NOT_FOUND' : 'ROUTING_UNAVAILABLE',
        message: unavailable
          ? 'No se ha encontrado una ruta para este trayecto.'
          : 'El servicio de rutas no esta disponible temporalmente.',
      });
    }
  });

  return router;
}

module.exports = createNavigationRouter();
module.exports.createNavigationRouter = createNavigationRouter;
