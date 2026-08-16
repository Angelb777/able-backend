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
