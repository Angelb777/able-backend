const crypto = require('crypto');

const CSRF_COOKIE = 'able73_csrf';

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function sessionCookieName() {
  return isProduction() ? '__Host-able73_session' : 'able73_session';
}

function legacySessionCookieName() {
  return isProduction() ? '__Host-able73_legacy' : 'able73_legacy';
}

function parseCookies(header = '') {
  return String(header).split(';').reduce((cookies, part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return cookies;
    const key = part.slice(0, separator).trim();
    if (!key) return cookies;
    try {
      cookies[key] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch (_error) {
      cookies[key] = '';
    }
    return cookies;
  }, {});
}

function csrfCookieOptions() {
  return {
    httpOnly: false,
    secure: isProduction(),
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 1000,
  };
}

function sessionCookieOptions(maxAge) {
  return {
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'lax',
    path: '/',
    maxAge,
  };
}

function issueCsrfToken(res) {
  const token = crypto.randomBytes(32).toString('base64url');
  res.cookie(CSRF_COOKIE, token, csrfCookieOptions());
  return token;
}

function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function validCsrfRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  const supplied = req.get('x-csrf-token') || req.body?.csrfToken;
  return timingSafeEqual(cookies[CSRF_COOKIE], supplied);
}

module.exports = {
  CSRF_COOKIE,
  csrfCookieOptions,
  issueCsrfToken,
  legacySessionCookieName,
  parseCookies,
  sessionCookieName,
  sessionCookieOptions,
  validCsrfRequest,
};
