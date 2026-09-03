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

module.exports = { createLimiter, authenticatedUserKey, integerEnv, requestIpKey };
