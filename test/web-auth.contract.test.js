const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const readPublic = (relative) => fs.readFileSync(
  path.join(__dirname, '..', 'public', relative),
  'utf8',
);

test('web Firebase flow contains registration, verification, Google and recovery', () => {
  const firebaseClient = readPublic('js/firebase-client.js');
  const register = readPublic('js/register.js');
  const login = readPublic('js/login.js');
  assert.match(firebaseClient, /createUserWithEmailAndPassword/);
  assert.match(firebaseClient, /sendPasswordResetEmail/);
  assert.match(firebaseClient, /sendEmailVerification/);
  assert.match(firebaseClient, /GoogleAuthProvider/);
  assert.match(register, /nickname/);
  assert.match(register, /role/);
  assert.match(login, /checkEmailVerified|reload/);
});

test('web sessions use backend cookies and never persist an authentication token', () => {
  const firebaseClient = readPublic('js/firebase-client.js');
  const dashboard = readPublic('js/dashboard.js');
  const cultureGame = readPublic('juego-cultura.html');
  assert.match(firebaseClient, /session-login/);
  assert.match(firebaseClient, /session-logout/);
  assert.match(firebaseClient, /signOut/);
  assert.doesNotMatch(firebaseClient, /setItem\(['"]token/);
  assert.doesNotMatch(dashboard, /getItem\(['"]token/);
  assert.match(dashboard, /fetch\(`\/api\/users\/\$\{userId\}`\)/);
  assert.doesNotMatch(
    dashboard,
    /fetch\(`\/api\/users\/\$\{userId\}`,\s*\{\s*headers:\s*\{\s*Authorization/
  );
  assert.doesNotMatch(cultureGame, /localStorage\.getItem\(['"]token/);
});

test('legacy web accounts are checked before Firebase initialization', () => {
  const login = readPublic('js/login.js');
  const legacyAttempt = login.indexOf('await legacyWebLogin(email, password)');
  const firebaseAttempt = login.indexOf('const auth = await firebaseAuth()', legacyAttempt);
  assert.ok(legacyAttempt >= 0, 'the legacy login attempt must remain available');
  assert.ok(firebaseAttempt > legacyAttempt, 'legacy login must not depend on Firebase Web config');
  assert.match(login, /legacyError\.code !== 'INVALID_CREDENTIALS'/);
});

test('dashboard user actions comply with CSP and report delete failures', () => {
  const dashboard = readPublic('js/dashboard.js');
  assert.doesNotMatch(dashboard, /onclick=["'][^"']*(?:verDetalles|eliminarUsuario)/);
  assert.match(dashboard, /data-user-management-action="delete"/);
  assert.match(dashboard, /if \(!res\.ok\) throw new Error/);
});

test('public navigation always exposes a direct login link', () => {
  const publicPages = [
    'index.html',
    'usuarios.html',
    'empresas.html',
    'comercios.html',
    'taxistas.html',
    'candados.html',
  ];

  for (const page of publicPages) {
    const html = readPublic(page);
    assert.match(
      html,
      /<a class="login-btn" href="\/login\.html" id="login-btn">Acceder<\/a>/,
      `${page} must link directly to the login page`,
    );
    assert.doesNotMatch(
      html,
      /id="login-btn"[^>]*onclick=/,
      `${page} must not depend on inline JavaScript to open the login page`,
    );
  }
});

test('legal pages, footer, cookie choice and registration consent are present', () => {
  for (const page of ['terminos.html', 'privacidad.html', 'aviso-legal.html', 'cookies.html']) {
    const html = readPublic(page);
    assert.match(html, /<main class="legal-document">/);
    assert.match(html, /js\/legal-ui\.js/);
    assert.match(html, /data-legal-email>Mostrar correo electrónico<\/a>/);
    assert.doesNotMatch(html, /info@able73\.com/);
  }

  const legalUi = readPublic('js/legal-ui.js');
  assert.match(legalUi, /Política de Privacidad/);
  assert.match(legalUi, /Términos de Uso/);
  assert.match(legalUi, /Aviso Legal/);
  assert.match(legalUi, /Política de Cookies/);
  assert.match(legalUi, /data-cookie-choice="rejected"[^>]*>Rechazar/);
  assert.match(legalUi, /data-cookie-choice="accepted"[^>]*>Aceptar/);
  assert.match(legalUi, /String\.fromCharCode\(64\)/);
  assert.match(legalUi, /mailto:\$\{email\}/);

  const registration = readPublic('register.html');
  assert.match(registration, /id="terms-accepted"[^>]*required/);
  assert.doesNotMatch(registration, /id="terms-accepted"[^>]*checked/);
  assert.match(registration, /He leído y acepto/);
  assert.match(registration, /Al continuar, aceptas los/);

  const login = readPublic('login.html');
  assert.match(login, /Al continuar, aceptas los/);
  assert.match(login, /href="\/terminos\.html"/);
  assert.match(login, /href="\/privacidad\.html"/);
});
