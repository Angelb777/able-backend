const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { verifyToken } = require('../middlewares/authMiddleware');
const { authenticatedUserKey } = require('../middlewares/securityLimits');
const { UberRidersClient, UberApiError } = require('../services/uberRidersClient');

function callbackRedirect(req, status, reason) {
  const query = new URLSearchParams({ status });
  if (reason) query.set('reason', reason);
  return `/api/uber/oauth/complete?${query}`;
}

function sendCompletePage(res, success) {
  res.set('Cache-Control', 'no-store');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  return res.status(success ? 200 : 400).type('html').send(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Uber</title><body style="font-family:system-ui;background:#111;color:#fff;text-align:center;padding:48px"><h1>${success ? 'Cuenta Uber conectada' : 'No se pudo conectar Uber'}</h1><p>${success ? 'Ya puedes volver a Able.' : 'Vuelve a Able e intentalo de nuevo.'}</p></body></html>`);
}

function createUberRouter({
  uber = new UberRidersClient(),
  authenticate = verifyToken,
  disableRateLimit = false,
} = {}) {
  const router = express.Router();

  // Uber vuelve sin la sesion de Able; el state opaco, de un solo uso y con TTL
  // vincula de forma segura el callback con el usuario que inicio el flujo.
  router.get('/oauth/callback', async (req, res) => {
    try {
      await uber.completeAuthorization(req.query || {});
      return res.redirect(303, callbackRedirect(req, 'success'));
    } catch (error) {
      console.warn(`[uber:oauth] ${error?.code || error?.message || 'failed'}`);
      return res.redirect(303, callbackRedirect(req, 'error', error?.code || 'OAUTH_FAILED'));
    }
  });
  router.get('/oauth/complete', (req, res) => sendCompletePage(res, req.query.status === 'success'));

  router.use(authenticate);
  if (!disableRateLimit) {
    router.use(rateLimit({
      windowMs: 60 * 1000,
      limit: 60,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      keyGenerator: authenticatedUserKey,
      handler: (_req, res) => res.status(429).json({
        error: 'UBER_RATE_LIMITED',
        message: 'Demasiadas solicitudes a Uber. Espera un momento.',
      }),
    }));
  }

  const handler = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (error) {
      if (error instanceof UberApiError) {
        return res.status(error.status).json({
          error: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      console.error(`[uber] ${error?.message || 'unexpected error'}`);
      return res.status(500).json({ error: 'UBER_INTERNAL_ERROR', message: 'No se ha podido completar la operacion con Uber.' });
    }
  };

  router.get('/connection', handler(async (req, res) => res.json(await uber.connectionStatus(req.user.id))));
  router.post('/oauth/start', handler(async (req, res) => res.json(await uber.createAuthorization(req.user.id))));
  router.delete('/connection', handler(async (req, res) => {
    await uber.disconnect(req.user.id);
    res.status(204).end();
  }));
  router.post('/offerings', handler(async (req, res) => res.json({
    environment: String(process.env.UBER_API_ENV || 'sandbox').toLowerCase(),
    products: await uber.offerings(req.body?.origin, req.body?.destination),
  })));
  router.get('/payment-methods', handler(async (req, res) => res.json(await uber.paymentMethods(req.user.id))));
  router.post('/rides/estimate', handler(async (req, res) => res.json(await uber.estimateRide(req.user.id, req.body || {}))));
  router.post('/rides', handler(async (req, res) => res.status(202).json(await uber.createRide(req.user.id, req.body || {}))));
  router.get('/rides/current', handler(async (req, res) => {
    const ride = await uber.currentRide(req.user.id);
    if (!ride) return res.status(404).json({ error: 'NO_CURRENT_RIDE', message: 'No hay ningun viaje Uber activo.' });
    return res.json(ride);
  }));
  router.delete('/rides/current', handler(async (req, res) => res.json(await uber.cancelRide(req.user.id))));

  return router;
}

module.exports = createUberRouter();
module.exports.createUberRouter = createUberRouter;
