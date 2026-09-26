const crypto = require('crypto');

function encryptionKey(raw = process.env.UBER_TOKEN_ENCRYPTION_KEY) {
  const value = String(raw || '').trim();
  let key;
  if (/^[a-f0-9]{64}$/i.test(value)) key = Buffer.from(value, 'hex');
  else {
    try { key = Buffer.from(value, 'base64'); } catch (_) { key = Buffer.alloc(0); }
  }
  if (key.length !== 32) {
    throw new Error('UBER_TOKEN_ENCRYPTION_KEY must be 32 bytes (base64) or 64 hex characters');
  }
  return key;
}

function encryptUberToken(value, rawKey) {
  if (!value) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(rawKey), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decryptUberToken(value, rawKey) {
  if (!value) return '';
  const [version, iv, tag, encrypted] = String(value).split('.');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Invalid encrypted Uber token');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(rawKey), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

module.exports = { encryptUberToken, decryptUberToken, encryptionKey };
