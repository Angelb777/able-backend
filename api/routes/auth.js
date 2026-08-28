const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { rateLimit } = require('express-rate-limit');
const User = require('../models/User');
const { getFirebaseAuth } = require('../services/firebaseAdmin');
const {
  AuthenticationError,
  decodeFirebaseIdToken,
  normalizeRole,
  providerIds,
  userFromFirebaseToken,
} = require('../services/authIdentity');
const { verifyToken } = require('../middlewares/authMiddleware');
const { validateNickname } = require('../utils/nickname');
const {
  CSRF_COOKIE,
  csrfCookieOptions,
  issueCsrfToken,
  legacySessionCookieName,
  parseCookies,
  sessionCookieName,
  sessionCookieOptions,
  validCsrfRequest,
} = require('../utils/authCookies');

const PUBLIC_ROLES = new Set(['cliente', 'comercio']);
const SESSION_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;
const GENERIC_LOGIN_ERROR = 'El correo o la contrasena no son correctos';
// La configuracion del SDK Web identifica la aplicacion, pero no concede
// privilegios administrativos ni contiene credenciales privadas. Las variables
// de entorno permiten sustituirla sin cambiar codigo si se migra de proyecto.
const DEFAULT_FIREBASE_WEB_CONFIG = Object.freeze({
  apiKey: 'AIzaSyDcXxMDzYCnCzVBIGSa3Z4sM4i_ZsUX6vI',
  authDomain: 'able-8a1b8.firebaseapp.com',
  projectId: 'able-8a1b8',
  appId: '1:502569781663:web:4aff9c65c4a3e8fd1fd5aa',
  messagingSenderId: '502569781663',
});

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function emailQuery(email) {
  return { email: { $regex: `^${escapeRegex(email)}$`, $options: 'i' } };
}

function serializeUser(user, authType) {
  return {
    id: String(user._id),
    nickname: user.nickname || '',
    needsNickname: !user.nickname,
    email: user.email,
    role: normalizeRole(user.role),
    authType,
  };
}

function authLimiter(options = {}) {
  return rateLimit({
    windowMs: options.windowMs || 15 * 60 * 1000,
    limit: options.limit || 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: options.disabled ? () => true : undefined,
    message: {
      error: 'Demasiados intentos. Espera unos minutos antes de continuar.',
      code: 'AUTH_RATE_LIMITED',
    },
  });
}

function bearerFrom(req) {
  const authorization = String(req.headers.authorization || '');
  if (authorization.startsWith('Bearer ')) return authorization.slice(7).trim();
  return String(req.body?.idToken || '').trim();
}

async function findProfileByEmail(UserModel, email) {
  return UserModel.findOne(emailQuery(email));
}

function canLinkVerifiedGoogleProfile(decoded) {
  return decoded.email_verified === true &&
    decoded.firebase?.sign_in_provider === 'google.com';
}

async function linkGoogleProfile(profile, decoded) {
  profile.firebaseUid = decoded.uid;
  profile.authProviders = Array.from(new Set([
    ...(Array.isArray(profile.authProviders) ? profile.authProviders : []),
    ...providerIds(decoded),
  ]));
  await profile.save();
  return profile;
}

function createAuthRouter(dependencies = {}) {
  const router = express.Router();
  const UserModel = dependencies.UserModel || User;
  const firebaseAuth = dependencies.firebaseAuth || null;
  const limiterDisabled = dependencies.disableRateLimit === true;
  const loginLimiter = authLimiter({ limit: 10, disabled: limiterDisabled });
  const registrationLimiter = authLimiter({ limit: 15, disabled: limiterDisabled });

  const currentFirebaseAuth = () => firebaseAuth || getFirebaseAuth();

  router.get('/firebase-config', (_req, res) => {
    const config = {
      apiKey: process.env.FIREBASE_WEB_API_KEY || DEFAULT_FIREBASE_WEB_CONFIG.apiKey,
      authDomain: process.env.FIREBASE_WEB_AUTH_DOMAIN || DEFAULT_FIREBASE_WEB_CONFIG.authDomain,
      projectId: process.env.FIREBASE_PROJECT_ID || DEFAULT_FIREBASE_WEB_CONFIG.projectId,
      appId: process.env.FIREBASE_WEB_APP_ID || DEFAULT_FIREBASE_WEB_CONFIG.appId,
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID ||
        DEFAULT_FIREBASE_WEB_CONFIG.messagingSenderId,
    };
    return res.json(config);
  });

  router.get('/csrf', (_req, res) => {
    const csrfToken = issueCsrfToken(res);
    return res.json({ csrfToken });
  });

  router.get('/nickname-available', registrationLimiter, async (req, res, next) => {
    try {
      const checked = validateNickname(req.query.nickname);
      if (!checked.ok) return res.status(400).json({ available: false, error: checked.error });
      const existing = await UserModel.exists({
        normalizedNickname: checked.normalizedNickname,
      });
      return res.json({ available: !existing });
    } catch (error) {
      return next(error);
    }
  });

  // Cerrado definitivamente para altas nuevas. Se conserva la ruta con una
  // respuesta explicita para que ningun cliente antiguo cree cuentas legacy.
  router.post('/register', registrationLimiter, (_req, res) => res.status(410).json({
    error: 'El registro antiguo ya no esta disponible. Actualiza Able73 para crear una cuenta.',
    code: 'LEGACY_REGISTRATION_DISABLED',
  }));

  router.post('/firebase/status', registrationLimiter, async (req, res, next) => {
    try {
      const idToken = bearerFrom(req);
      const decoded = await decodeFirebaseIdToken(idToken, {
        firebaseAuth: currentFirebaseAuth(),
        requireVerifiedEmail: false,
      });
      const linked = await UserModel.findOne({ firebaseUid: decoded.uid });
      if (linked) {
        return res.json({ status: 'linked', user: serializeUser(linked, 'firebase') });
      }
      const email = normalizeEmail(decoded.email);
      if (!email) return res.status(400).json({ error: 'Firebase no ha proporcionado un email' });
      const collision = await findProfileByEmail(UserModel, email);
      if (collision) {
        if (canLinkVerifiedGoogleProfile(decoded)) {
          const migrated = await linkGoogleProfile(collision, decoded);
          return res.json({
            status: 'linked',
            user: serializeUser(migrated, 'firebase'),
          });
        }
        return res.status(409).json({
          status: 'legacy_conflict',
          error: 'Ya existe un perfil Able73 con ese correo. Entra con el acceso legacy para conservarlo.',
          code: 'EXISTING_PROFILE_REQUIRES_LEGACY',
        });
      }
      return res.json({
        status: 'needs_profile',
        provider: decoded.firebase?.sign_in_provider || '',
        emailVerified: decoded.email_verified === true,
      });
    } catch (error) {
      if (error instanceof AuthenticationError) {
        return res.status(error.status).json({
          error: error.code === 'FIREBASE_ADMIN_NOT_CONFIGURED'
            ? 'El acceso Firebase no esta configurado en el servidor'
            : 'No se pudo validar la cuenta Firebase',
          code: error.code,
        });
      }
      return next(error);
    }
  });

  router.post('/firebase/register', registrationLimiter, async (req, res, next) => {
    try {
      const role = String(req.body.role || '');
      if (!PUBLIC_ROLES.has(role)) {
        return res.status(403).json({
          error: 'El registro publico solo permite Usuario o Comercio',
          code: 'PUBLIC_ROLE_NOT_ALLOWED',
        });
      }
      const checked = validateNickname(req.body.nickname);
      if (!checked.ok) return res.status(400).json({ error: checked.error, code: 'INVALID_NICKNAME' });

      const idToken = bearerFrom(req);
      const decoded = await decodeFirebaseIdToken(idToken, {
        firebaseAuth: currentFirebaseAuth(),
        requireVerifiedEmail: false,
      });
      const email = normalizeEmail(decoded.email);
      if (!email) return res.status(400).json({ error: 'Firebase no ha proporcionado un email' });

      const linked = await UserModel.findOne({ firebaseUid: decoded.uid });
      if (linked) return res.json({ user: serializeUser(linked, 'firebase') });

      // Google verificado puede recuperar el perfil del mismo correo sin
      // duplicar ni perder sus datos. Otros proveedores siguen bloqueados.
      const emailCollision = await findProfileByEmail(UserModel, email);
      if (emailCollision) {
        if (canLinkVerifiedGoogleProfile(decoded)) {
          const migrated = await linkGoogleProfile(emailCollision, decoded);
          return res.json({ user: serializeUser(migrated, 'firebase') });
        }
        return res.status(409).json({
          error: 'Ya existe un perfil Able73 con ese correo. No se ha vinculado ni modificado.',
          code: 'EXISTING_PROFILE_REQUIRES_LEGACY',
        });
      }
      const nicknameCollision = await UserModel.exists({
        normalizedNickname: checked.normalizedNickname,
      });
      if (nicknameCollision) {
        return res.status(409).json({ error: 'Ese nickname ya esta en uso', code: 'NICKNAME_TAKEN' });
      }

      const user = new UserModel({
        firebaseUid: decoded.uid,
        authProviders: providerIds(decoded),
        email,
        nombre: typeof decoded.name === 'string' ? decoded.name.trim() : '',
        nickname: checked.nickname,
        normalizedNickname: checked.normalizedNickname,
        role,
        ...(role === 'cliente' ? {
          onboarding: {
            version: 1,
            status: 'active',
            step: 'mapBasics',
          },
        } : {}),
      });
      try {
        await user.save();
      } catch (error) {
        if (error?.code === 11000) {
          return res.status(409).json({
            error: 'El email o nickname acaba de ser utilizado. Elige otro nickname.',
            code: 'PROFILE_CONFLICT',
          });
        }
        throw error;
      }
      return res.status(201).json({
        user: serializeUser(user, 'firebase'),
        emailVerified: decoded.email_verified === true,
      });
    } catch (error) {
      if (error instanceof AuthenticationError) {
        return res.status(error.status).json({
          error: error.code === 'FIREBASE_ADMIN_NOT_CONFIGURED'
            ? 'El acceso Firebase no esta configurado en el servidor'
            : 'No se pudo validar la cuenta Firebase',
          code: error.code,
        });
      }
      return next(error);
    }
  });

  // TEMPORAL: login exclusivo para documentos MongoDB anteriores a Firebase.
  router.post('/login', loginLimiter, async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body.email);
      const password = typeof req.body.password === 'string' ? req.body.password : '';
      if (!email || !password) {
        return res.status(401).json({ error: GENERIC_LOGIN_ERROR, code: 'INVALID_CREDENTIALS' });
      }
      const user = await findProfileByEmail(UserModel, email);
      // Los administradores conservan el acceso de respaldo por contrasena
      // aunque su perfil tambien este vinculado a Firebase. Esto evita dejar
      // el backoffice inaccesible si Firebase Web no esta configurado.
      const linkedAdmin = user?.firebaseUid && normalizeRole(user.role) === 'admin';
      if (!user || (user.firebaseUid && !linkedAdmin) || !user.password) {
        return res.status(401).json({ error: GENERIC_LOGIN_ERROR, code: 'INVALID_CREDENTIALS' });
      }
      const matches = await bcrypt.compare(password, user.password);
      if (!matches) {
        return res.status(401).json({ error: GENERIC_LOGIN_ERROR, code: 'INVALID_CREDENTIALS' });
      }
      const token = jwt.sign({ id: user._id, legacy: true }, process.env.JWT_SECRET, {
        expiresIn: '7d',
      });
      if (req.body.webSession === true) {
        if (!validCsrfRequest(req)) {
          return res.status(403).json({ error: 'Solicitud no valida', code: 'INVALID_CSRF_TOKEN' });
        }
        res.cookie(legacySessionCookieName(), token, sessionCookieOptions(SESSION_MAX_AGE_MS));
        return res.json({ user: serializeUser(user, 'legacy') });
      }
      return res.json({ token, user: serializeUser(user, 'legacy') });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/session-login', loginLimiter, async (req, res, next) => {
    try {
      if (!validCsrfRequest(req)) {
        return res.status(403).json({ error: 'Solicitud no valida', code: 'INVALID_CSRF_TOKEN' });
      }
      const idToken = bearerFrom(req);
      const decoded = await decodeFirebaseIdToken(idToken, {
        firebaseAuth: currentFirebaseAuth(),
        requireVerifiedEmail: true,
      });
      if (Math.floor(Date.now() / 1000) - Number(decoded.auth_time || 0) > 5 * 60) {
        return res.status(401).json({ error: 'Vuelve a iniciar sesion', code: 'RECENT_LOGIN_REQUIRED' });
      }
      const identity = await userFromFirebaseToken(idToken, {
        firebaseAuth: currentFirebaseAuth(), UserModel,
      });
      const sessionCookie = await currentFirebaseAuth().createSessionCookie(idToken, {
        expiresIn: SESSION_MAX_AGE_MS,
      });
      res.cookie(sessionCookieName(), sessionCookie, sessionCookieOptions(SESSION_MAX_AGE_MS));
      return res.json({ user: identity });
    } catch (error) {
      if (error instanceof AuthenticationError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      return next(error);
    }
  });

  router.post('/session-logout', loginLimiter, async (req, res) => {
    if (!validCsrfRequest(req)) {
      return res.status(403).json({ error: 'Solicitud no valida', code: 'INVALID_CSRF_TOKEN' });
    }
    const cookies = parseCookies(req.headers.cookie);
    const cookie = cookies[sessionCookieName()];
    if (cookie) {
      try {
        const decoded = await currentFirebaseAuth().verifySessionCookie(cookie, false);
        await currentFirebaseAuth().revokeRefreshTokens(decoded.uid);
      } catch (_error) {
        // La cookie se elimina igualmente si estaba caducada o no era valida.
      }
    }
    res.clearCookie(sessionCookieName(), sessionCookieOptions(0));
    res.clearCookie(legacySessionCookieName(), sessionCookieOptions(0));
    res.clearCookie(CSRF_COOKIE, csrfCookieOptions());
    return res.status(204).end();
  });

  router.post('/logout', verifyToken, async (req, res, next) => {
    try {
      if (req.user.firebaseUid) {
        await currentFirebaseAuth().revokeRefreshTokens(req.user.firebaseUid);
      }
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.get('/me', verifyToken, (req, res) => res.json({ user: req.user }));

  return router;
}

const router = createAuthRouter();
router.createAuthRouter = createAuthRouter;
module.exports = router;
module.exports.createAuthRouter = createAuthRouter;
