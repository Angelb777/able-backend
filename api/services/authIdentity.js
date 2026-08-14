const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { getFirebaseAuth } = require('./firebaseAdmin');

class AuthenticationError extends Error {
  constructor(code, message = 'No se pudo validar la sesion') {
    super(message);
    this.name = 'AuthenticationError';
    this.code = code;
    this.status = code === 'EMAIL_NOT_VERIFIED' ? 403 : 401;
  }
}

function providerIds(decoded) {
  const provider = decoded?.firebase?.sign_in_provider;
  return provider ? [String(provider)] : [];
}

function firebaseLike(token) {
  const decoded = jwt.decode(token);
  return typeof decoded?.iss === 'string' &&
    decoded.iss.startsWith('https://securetoken.google.com/');
}

function assertVerifiedEmail(decoded) {
  const provider = decoded?.firebase?.sign_in_provider;
  if (provider === 'password' && decoded.email_verified !== true) {
    throw new AuthenticationError(
      'EMAIL_NOT_VERIFIED',
      'Debes verificar tu correo antes de continuar'
    );
  }
}

async function decodeFirebaseIdToken(token, options = {}) {
  if (!token) throw new AuthenticationError('MISSING_TOKEN');
  const firebaseAuth = options.firebaseAuth || getFirebaseAuth();
  let decoded;
  try {
    decoded = await firebaseAuth.verifyIdToken(token, true);
  } catch (_error) {
    throw new AuthenticationError('INVALID_FIREBASE_TOKEN');
  }
  if (options.requireVerifiedEmail !== false) assertVerifiedEmail(decoded);
  return decoded;
}

async function userFromFirebaseToken(token, dependencies = {}) {
  const firebaseAuth = dependencies.firebaseAuth || getFirebaseAuth();
  const UserModel = dependencies.UserModel || User;
  const decoded = await decodeFirebaseIdToken(token, { firebaseAuth });
  const user = await UserModel.findOne({ firebaseUid: decoded.uid })
    .select('_id role firebaseUid email nickname')
    .lean();
  if (!user) throw new AuthenticationError('FIREBASE_PROFILE_NOT_LINKED');
  return {
    id: String(user._id),
    role: user.role,
    firebaseUid: decoded.uid,
    email: user.email,
    nickname: user.nickname || '',
    authType: 'firebase',
    providers: providerIds(decoded),
  };
}

async function userFromSessionCookie(cookie, dependencies = {}) {
  const firebaseAuth = dependencies.firebaseAuth || getFirebaseAuth();
  const UserModel = dependencies.UserModel || User;
  let decoded;
  try {
    decoded = await firebaseAuth.verifySessionCookie(cookie, true);
  } catch (_error) {
    throw new AuthenticationError('INVALID_SESSION_COOKIE');
  }
  assertVerifiedEmail(decoded);
  const user = await UserModel.findOne({ firebaseUid: decoded.uid })
    .select('_id role firebaseUid email nickname')
    .lean();
  if (!user) throw new AuthenticationError('FIREBASE_PROFILE_NOT_LINKED');
  return {
    id: String(user._id),
    role: user.role,
    firebaseUid: decoded.uid,
    email: user.email,
    nickname: user.nickname || '',
    authType: 'firebase-session',
    providers: providerIds(decoded),
  };
}

async function userFromLegacyToken(token, dependencies = {}) {
  const UserModel = dependencies.UserModel || User;
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (_error) {
    throw new AuthenticationError('INVALID_LEGACY_TOKEN');
  }
  const id = decoded.id || decoded._id || decoded.sub;
  if (!id) throw new AuthenticationError('INVALID_LEGACY_TOKEN');
  const user = await UserModel.findById(id)
    .select('_id role firebaseUid email nickname')
    .lean();
  // TEMPORAL: un perfil vinculado a Firebase nunca puede volver al JWT legacy.
  if (!user || user.firebaseUid) {
    throw new AuthenticationError('LEGACY_ACCOUNT_NOT_ELIGIBLE');
  }
  return {
    id: String(user._id),
    role: user.role,
    email: user.email,
    nickname: user.nickname || '',
    authType: 'legacy',
  };
}

async function resolveBearerToken(token, dependencies = {}) {
  if (!token) throw new AuthenticationError('MISSING_TOKEN');
  return firebaseLike(token)
    ? userFromFirebaseToken(token, dependencies)
    : userFromLegacyToken(token, dependencies);
}

module.exports = {
  AuthenticationError,
  assertVerifiedEmail,
  decodeFirebaseIdToken,
  firebaseLike,
  providerIds,
  resolveBearerToken,
  userFromFirebaseToken,
  userFromLegacyToken,
  userFromSessionCookie,
};
