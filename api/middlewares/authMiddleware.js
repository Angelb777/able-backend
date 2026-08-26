const {
  AuthenticationError,
  normalizeRole,
  resolveBearerToken,
  userFromSessionCookie,
} = require('../services/authIdentity');
const {
  parseCookies,
  legacySessionCookieName,
  sessionCookieName,
  validCsrfRequest,
} = require('../utils/authCookies');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function authFailure(res, error) {
  const status = error instanceof AuthenticationError ? error.status : 401;
  const code = error instanceof AuthenticationError ? error.code : 'INVALID_AUTHENTICATION';
  const message = code === 'EMAIL_NOT_VERIFIED'
    ? 'Debes verificar tu correo antes de continuar'
    : 'La sesion no es valida o ha caducado';
  return res.status(status).json({ error: message, code });
}

async function verifyToken(req, res, next) {
  try {
    const authorization = String(req.headers.authorization || '');
    const bearer = authorization.startsWith('Bearer ')
      ? authorization.slice(7).trim()
      : authorization.trim();

    if (bearer) {
      req.user = await resolveBearerToken(bearer);
      return next();
    }

    const cookies = parseCookies(req.headers.cookie);
    const sessionCookie = cookies[sessionCookieName()];
    const legacyCookie = cookies[legacySessionCookieName()];
    if (!sessionCookie && !legacyCookie) {
      return authFailure(res, new AuthenticationError('MISSING_TOKEN'));
    }
    if (!SAFE_METHODS.has(req.method) && !validCsrfRequest(req)) {
      return res.status(403).json({
        error: 'La solicitud no ha superado la proteccion CSRF',
        code: 'INVALID_CSRF_TOKEN',
      });
    }
    req.user = sessionCookie
      ? await userFromSessionCookie(sessionCookie)
      : await resolveBearerToken(legacyCookie);
    return next();
  } catch (error) {
    if (error instanceof AuthenticationError) return authFailure(res, error);
    return next(error);
  }
}

function checkRole(allowedRoles) {
  return (req, res, next) => {
    // El rol procede siempre del documento MongoDB cargado por verifyToken.
    const role = normalizeRole(req.user?.role);
    if (!role || !allowedRoles.includes(role)) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    req.user.role = role;
    return next();
  };
}

function requireSelfOrAdmin(paramName = 'userId') {
  return (req, res, next) => {
    const requestedUserId = String(req.params?.[paramName] || '');
    const authenticatedUserId = String(req.user?.id || '');
    if (req.user?.role !== 'admin' && requestedUserId !== authenticatedUserId) {
      return res.status(403).json({ error: 'No puedes operar sobre otro usuario' });
    }
    return next();
  };
}

async function requireNickname(req, res, next) {
  try {
    const User = require('../models/User');
    const user = await User.findById(req.user.id).select('nickname').lean();
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });
    if (!user.nickname) {
      return res.status(428).json({
        error: 'Debes elegir un nickname antes de utilizar funciones sociales',
        code: 'NICKNAME_REQUIRED',
        needsNickname: true,
      });
    }
    req.publicUser = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = { verifyToken, checkRole, requireSelfOrAdmin, requireNickname };
