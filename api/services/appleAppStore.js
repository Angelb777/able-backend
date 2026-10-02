// Verificacion server-to-server de transacciones StoreKit 2.
const fs = require('fs');
const path = require('path');
const {
  Environment,
  SignedDataVerifier,
} = require('@apple/app-store-server-library');

const BUNDLE_ID = process.env.APPLE_IAP_BUNDLE_ID || 'com.able73.app';
const APPLE_APP_ID = Number(process.env.APPLE_IAP_APP_ID);
const ENABLE_ONLINE_CHECKS = process.env.APPLE_IAP_ENABLE_ONLINE_CHECKS !== 'false';
const DEFAULT_CERTIFICATE_PATHS = [
  'AppleIncRootCertificate.cer',
  'AppleRootCA-G2.cer',
  'AppleRootCA-G3.cer',
].map((name) => path.join(__dirname, '..', 'certificates', 'apple', name));

let verifierState;

function certificatePaths() {
  const configured = String(process.env.APPLE_IAP_ROOT_CA_PATHS || '').trim();
  return configured
    ? configured.split(path.delimiter).map((value) => value.trim()).filter(Boolean)
    : DEFAULT_CERTIFICATE_PATHS;
}

function buildVerifierState() {
  try {
    const roots = certificatePaths().map((certificatePath) =>
      fs.readFileSync(certificatePath));
    const verifiers = [{
      environment: Environment.SANDBOX,
      verifier: new SignedDataVerifier(
        roots,
        ENABLE_ONLINE_CHECKS,
        Environment.SANDBOX,
        BUNDLE_ID,
      ),
    }];

    if (Number.isSafeInteger(APPLE_APP_ID) && APPLE_APP_ID > 0) {
      verifiers.unshift({
        environment: Environment.PRODUCTION,
        verifier: new SignedDataVerifier(
          roots,
          ENABLE_ONLINE_CHECKS,
          Environment.PRODUCTION,
          BUNDLE_ID,
          APPLE_APP_ID,
        ),
      });
    }

    return { verifiers, error: null };
  } catch (error) {
    console.error('❌ No se pudo configurar la verificacion de App Store:', error);
    return { verifiers: [], error };
  }
}

function state() {
  if (!verifierState) verifierState = buildVerifierState();
  return verifierState;
}

function appStoreVerificationAvailable() {
  return state().verifiers.length > 0;
}

async function verifyAppStoreTransaction(signedTransaction) {
  const value = String(signedTransaction || '').trim();
  if (!value) throw new Error('La transaccion firmada de App Store esta vacia');

  const configured = state();
  if (!configured.verifiers.length) {
    throw configured.error || new Error('App Store no esta configurado');
  }

  let lastError;
  for (const candidate of configured.verifiers) {
    try {
      const transaction = await candidate.verifier.verifyAndDecodeTransaction(value);
      return { transaction, environment: candidate.environment };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Apple rechazo la transaccion');
}

function validateAppStoreTransaction(transaction, { productId, purchaseID }) {
  const transactionId = String(transaction?.transactionId || '').trim();
  if (!/^\d+$/.test(transactionId)) {
    throw Object.assign(new Error('transactionId de App Store no valido'), { status: 400 });
  }
  if (String(purchaseID || '').trim() !== transactionId) {
    throw Object.assign(new Error('El transactionId no coincide con la compra'), { status: 400 });
  }
  if (transaction.bundleId !== BUNDLE_ID) {
    throw Object.assign(new Error('Bundle ID de App Store no valido'), { status: 400 });
  }
  if (transaction.productId !== productId) {
    throw Object.assign(new Error('El producto no coincide con la transaccion'), { status: 400 });
  }
  if (transaction.type !== 'Consumable' || Number(transaction.quantity) !== 1) {
    throw Object.assign(new Error('La transaccion no es un consumible valido'), { status: 400 });
  }
  if (transaction.revocationDate != null) {
    throw Object.assign(new Error('La compra fue revocada por App Store'), { status: 409 });
  }
  if (![Environment.SANDBOX, Environment.PRODUCTION].includes(transaction.environment)) {
    throw Object.assign(new Error('Entorno de App Store no valido'), { status: 400 });
  }
  return transactionId;
}

module.exports = {
  appStoreVerificationAvailable,
  verifyAppStoreTransaction,
  validateAppStoreTransaction,
};
