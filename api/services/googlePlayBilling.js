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
  const inline = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (inline) {
    try {
      return JSON.parse(inline);
    } catch (err) {
      console.error('❌ GOOGLE_PLAY_SERVICE_ACCOUNT_JSON no es un JSON valido:', err);
      return null;
    }
  }
  const path = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_PATH;
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

async function acknowledgeProductPurchase(productId, purchaseToken) {
  try {
    await callAndroidPublisher(
      `/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`,
      { method: 'POST', data: {} },
    );
  } catch (err) {
    // Google devuelve 400 si ya estaba confirmada/consumida en el cliente; no es un fallo real.
    if (err?.response?.status !== 400) throw err;
  }
}

module.exports = {
  playBillingAvailable,
  getProductPurchase,
  acknowledgeProductPurchase,
};
