// api/services/googlePlayBilling.js
// Verificacion server-to-server de compras de Google Play Billing (Android
// Publisher API v3). Sigue la misma convencion de credenciales que Firebase
// Admin: GOOGLE_PLAY_SERVICE_ACCOUNT_JSON (inline) o GOOGLE_PLAY_SERVICE_ACCOUNT_PATH
// (ruta a un fichero fuera del repositorio).
const fs = require('fs');
const { JWT } = require('google-auth-library');

const SCOPES = ['https://www.googleapis.com/auth/androidpublisher'];
const PACKAGE_NAME = process.env.GOOGLE_PLAY_PACKAGE_NAME || 'com.able73.app';

function loadCredentials() {
  const inline = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON
    || process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (inline) {
    try {
      const parsed = JSON.parse(inline);
      if (typeof parsed.private_key === 'string') {
        parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
      }
      return parsed;
    } catch (err) {
      console.error('❌ GOOGLE_PLAY_SERVICE_ACCOUNT_JSON no es un JSON valido:', err);
      return null;
    }
  }
  const path = [
    process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_PATH,
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
  ].find((candidate) => candidate && fs.existsSync(candidate));
  if (path && fs.existsSync(path)) {
    try {
      return JSON.parse(fs.readFileSync(path, 'utf8'));
    } catch (err) {
      console.error('❌ No se pudo leer GOOGLE_PLAY_SERVICE_ACCOUNT_PATH:', err);
      return null;
    }
  }
  return null;
}

const credentials = loadCredentials();
if (!credentials) {
  console.warn(
    '⚠️  Google Play Billing sin credenciales (GOOGLE_PLAY_SERVICE_ACCOUNT_JSON/PATH). ' +
      'La verificacion de compras de Stepcoins no estara disponible.',
  );
}

const authClient = credentials
  ? new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: SCOPES,
    })
  : null;

function playBillingAvailable() {
  return Boolean(authClient);
}

async function callAndroidPublisher(path, { method = 'GET', data } = {}) {
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}${path}`;
  const response = await authClient.request({ url, method, data });
  return response.data;
}

// purchaseState: 0 = comprado, 1 = cancelado, 2 = pendiente
// https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.products
async function getProductPurchase(productId, purchaseToken) {
  return callAndroidPublisher(
    `/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`,
  );
}

async function consumeProductPurchase(productId, purchaseToken) {
  await callAndroidPublisher(
    `/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:consume`,
    { method: 'POST', data: {} },
  );
}

module.exports = {
  playBillingAvailable,
  getProductPurchase,
  consumeProductPurchase,
};
