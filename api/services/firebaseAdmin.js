const fs = require('fs');
const path = require('path');
const { applicationDefault, cert, getApps, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

let cachedAuth = null;

function parseServiceAccount(raw) {
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (typeof parsed.private_key === 'string') {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  }
  return parsed;
}

function firebaseOptions() {
  const inline = parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (inline) return { credential: cert(inline) };

  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (serviceAccountPath) {
    const absolutePath = path.resolve(serviceAccountPath);
    const account = parseServiceAccount(fs.readFileSync(absolutePath, 'utf8'));
    return { credential: cert(account) };
  }

  const options = { credential: applicationDefault() };
  if (process.env.FIREBASE_PROJECT_ID) options.projectId = process.env.FIREBASE_PROJECT_ID;
  return options;
}

function getFirebaseAuth() {
  if (cachedAuth) return cachedAuth;
  if (!getApps().length) initializeApp(firebaseOptions());
  cachedAuth = getAuth();
  return cachedAuth;
}

function setFirebaseAuthForTests(auth) {
  cachedAuth = auth;
}

module.exports = { getFirebaseAuth, setFirebaseAuthForTests };
