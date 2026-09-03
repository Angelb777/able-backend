const { ipKeyGenerator, rateLimit } = require('express-rate-limit');

function integerEnv(name, fallback, { min = 1, max = 100000 } = {}) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function createLimiter({
  windowMs,
  limit,
  keyGenerator,
  code = 'RATE_LIMIT_EXCEEDED',
  message = 'Demasiadas solicitudes. Intentalo de nuevo mas tarde.',
  skip,
}) {
  const options = {
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: code, message }),
  };
  if (typeof keyGenerator === 'function') options.keyGenerator = keyGenerator;
  if (typeof skip === 'function') options.skip = skip;
  return rateLimit(options);
}

function authenticatedUserKey(req) {
  return req.user?.id
    ? `user:${String(req.user.id)}`
    : `ip:${ipKeyGenerator(req.ip)}`;
}

function requestIpKey(req) {
  return `ip:${ipKeyGenerator(req.ip)}`;
}

function socketRequestIpKey(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  const forwardedParts = String(
    Array.isArray(forwarded) ? forwarded.join(',') : forwarded || '',
  ).split(',').map((value) => value.trim()).filter(Boolean);
  // Igual que `trust proxy = 1`: confiamos en el salto mas cercano, no en un
  // valor que el cliente haya podido anteponer a X-Forwarded-For.
  const clientIp = forwardedParts[forwardedParts.length - 1];
  const remoteIp = req.socket?.remoteAddress || req.connection?.remoteAddress;
  return `socket-ip:${clientIp || remoteIp || 'unknown'}`;
}

function createSocketHandshakeLimiter({ windowMs, limit }) {
  const hits = new Map();
  const maxTrackedIps = 10_000;
  let requestsSinceSweep = 0;

  return (req, res, next) => {
    // Los transports polling reutilizan este middleware para cada paquete.
    // El limite protege solo aperturas nuevas, nunca una sesion ya validada.
    if (req._query?.sid) return next();

    const now = Date.now();
    if (++requestsSinceSweep >= 256) {
      requestsSinceSweep = 0;
      for (const [key, entry] of hits) {
        if (now - entry.startedAt >= windowMs) hits.delete(key);
      }
    }

    const key = socketRequestIpKey(req);
    let entry = hits.get(key);
    if (!entry || now - entry.startedAt >= windowMs) {
      if (!hits.has(key) && hits.size >= maxTrackedIps) {
        hits.delete(hits.keys().next().value);
      }
      entry = { startedAt: now, count: 0 };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count <= limit) return next();

    res.statusCode = 429;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      error: 'SOCKET_RATE_LIMITED',
      message: 'Demasiadas conexiones. Intentalo de nuevo mas tarde.',
    }));
  };
}

module.exports = {
  createLimiter,
  authenticatedUserKey,
  integerEnv,
  requestIpKey,
  createSocketHandshakeLimiter,
};
