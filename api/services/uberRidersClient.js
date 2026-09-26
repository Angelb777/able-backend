const crypto = require('crypto');
const UberConnection = require('../models/UberConnection');
const UberOAuthAttempt = require('../models/UberOAuthAttempt');
const { encryptUberToken, decryptUberToken } = require('./uberTokenCrypto');

const USER_SCOPES = Object.freeze([
  'ride_request.ride_booking',
  'ride_request.user_payment_methods',
  'offline_access',
]);
const ESTIMATE_SCOPE = 'ride_request.estimate';
const TERMINAL_STATUSES = new Set([
  'completed', 'rider_canceled', 'driver_canceled', 'no_drivers_available',
]);

class UberApiError extends Error {
  constructor(code, message, status = 502, upstreamStatus = null, details = null) {
    super(message);
    this.name = 'UberApiError';
    this.code = code;
    this.status = status;
    this.upstreamStatus = upstreamStatus;
    this.details = details;
  }
}

function point(raw, name) {
  const lat = Number(raw?.lat);
  const lng = Number(raw?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new UberApiError('INVALID_LOCATION', `${name} no es valido.`, 400);
  }
  return { lat, lng };
}

function cleanId(value, name) {
  const result = String(value || '').trim();
  if (!result || result.length > 256) throw new UberApiError('INVALID_REQUEST', `${name} no es valido.`, 400);
  return result;
}

function upstreamCode(body, fallback) {
  return String(body?.code || body?.error || fallback || 'UBER_UPSTREAM_ERROR').trim();
}

function publicError(code, upstreamStatus) {
  const normalized = String(code || '').toLowerCase();
  const mappings = {
    no_drivers_available: ['NO_DRIVERS_AVAILABLE', 'No hay conductores disponibles ahora mismo.', 409],
    fare_expired: ['FARE_EXPIRED', 'La tarifa ha caducado. Actualiza la estimacion.', 409],
    invalid_fare_id: ['FARE_EXPIRED', 'La tarifa ya no es valida. Actualiza la estimacion.', 409],
    current_trip_exists: ['CURRENT_TRIP_EXISTS', 'Ya existe un viaje Uber activo.', 409],
    missing_payment_method: ['PAYMENT_METHOD_REQUIRED', 'La cuenta Uber no tiene un metodo de pago disponible.', 409],
    invalid_payment: ['INVALID_PAYMENT', 'Uber ha rechazado el metodo de pago.', 422],
    invalid_payment_method: ['INVALID_PAYMENT', 'El metodo de pago seleccionado ya no es valido.', 422],
    insufficient_balance: ['INVALID_PAYMENT', 'El metodo de pago no tiene saldo suficiente.', 422],
    payment_method_not_allowed: ['INVALID_PAYMENT', 'Uber no permite ese metodo de pago para el viaje.', 422],
    outstanding_balance_update_billing: ['INVALID_PAYMENT', 'La cuenta Uber tiene un saldo pendiente.', 422],
    card_assoc_outstanding_balance: ['INVALID_PAYMENT', 'La cuenta Uber tiene un saldo pendiente.', 422],
    unconfirmed_email: ['UBER_ACCOUNT_ACTION_REQUIRED', 'Confirma el correo de tu cuenta Uber antes de solicitar el viaje.', 422],
    invalid_mobile_phone_number: ['UBER_ACCOUNT_ACTION_REQUIRED', 'Uber requiere un numero de telefono valido.', 422],
    verification_required: ['UBER_ACCOUNT_ACTION_REQUIRED', 'Uber requiere verificar tu identidad en su cuenta antes de reservar.', 403],
    forbidden: ['UBER_ACCOUNT_ACTION_REQUIRED', 'Uber no permite solicitar viajes con esta cuenta en este momento.', 403],
    retry_request: ['UBER_RETRY_REQUIRED', 'Uber no pudo procesar la solicitud. Intentalo de nuevo.', 409],
    surge: ['FARE_EXPIRED', 'La tarifa ha cambiado. Actualiza la estimacion para confirmarla.', 409],
    distance_exceeded: ['DISTANCE_EXCEEDED', 'El trayecto supera la distancia admitida por Uber.', 422],
    same_pickup_dropoff: ['INVALID_LOCATION', 'El origen y el destino no pueden ser iguales.', 422],
    outside_service_area: ['OUTSIDE_SERVICE_AREA', 'El destino esta fuera del area de servicio.', 422],
    no_product_found: ['PRODUCT_UNAVAILABLE', 'El producto Uber ya no esta disponible.', 404],
    unauthorized: ['UBER_REAUTHORIZE_REQUIRED', 'La conexion con Uber ha caducado. Vuelve a autorizarla.', 401],
    invalid_grant: ['UBER_REAUTHORIZE_REQUIRED', 'La conexion con Uber ha caducado. Vuelve a autorizarla.', 401],
  };
  const mapped = mappings[normalized];
  return mapped || ['UBER_REQUEST_FAILED', 'Uber no ha podido completar la solicitud.', upstreamStatus >= 400 && upstreamStatus < 500 ? 422 : 502];
}

class UberRidersClient {
  constructor({
    fetchImpl = global.fetch,
    ConnectionModel = UberConnection,
    OAuthAttemptModel = UberOAuthAttempt,
    now = () => new Date(),
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
    this.fetch = fetchImpl;
    this.Connection = ConnectionModel;
    this.OAuthAttempt = OAuthAttemptModel;
    this.now = now;
    this.refreshes = new Map();
    this.appToken = null;
  }

  get clientId() { return String(process.env.UBER_CLIENT_ID || '').trim(); }
  get clientSecret() { return String(process.env.UBER_CLIENT_SECRET || '').trim(); }
  get redirectUri() { return String(process.env.UBER_REDIRECT_URI || '').trim(); }
  get apiBase() {
    return String(process.env.UBER_API_ENV || 'sandbox').toLowerCase() === 'production'
      ? 'https://api.uber.com/v1.2'
      : 'https://sandbox-api.uber.com/v1.2';
  }

  assertConfigured() {
    if (!this.clientId || !this.clientSecret || !this.redirectUri || !process.env.UBER_TOKEN_ENCRYPTION_KEY) {
      throw new UberApiError('UBER_NOT_CONFIGURED', 'Uber todavia no esta configurado.', 503);
    }
  }

  async createAuthorization(userId) {
    this.assertConfigured();
    const state = crypto.randomBytes(32).toString('base64url');
    const stateHash = crypto.createHash('sha256').update(state).digest('hex');
    await this.OAuthAttempt.create({
      stateHash,
      user: userId,
      expiresAt: new Date(this.now().getTime() + 10 * 60 * 1000),
    });
    const url = new URL('https://auth.uber.com/oauth/v2/authorize');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('scope', USER_SCOPES.join(' '));
    url.searchParams.set('state', state);
    return { authorizationUrl: url.toString(), expiresIn: 600 };
  }

  async completeAuthorization({ state, code, error }) {
    this.assertConfigured();
    const stateHash = crypto.createHash('sha256').update(String(state || '')).digest('hex');
    const attempt = await this.OAuthAttempt.findOneAndDelete({
      stateHash,
      expiresAt: { $gt: this.now() },
    });
    if (!attempt) throw new UberApiError('INVALID_OAUTH_STATE', 'La autorizacion ha caducado o no es valida.', 400);
    if (error) throw new UberApiError('OAUTH_DENIED', 'La autorizacion de Uber fue cancelada.', 400);
    const token = await this.tokenRequest({
      grant_type: 'authorization_code',
      redirect_uri: this.redirectUri,
      code: cleanId(code, 'code'),
    });
    await this.saveTokens(String(attempt.user), token, { connectedAt: this.now() });
  }

  async tokenRequest(fields) {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      ...fields,
    });
    const response = await this.rawFetch('https://auth.uber.com/oauth/v2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const payload = await this.readJson(response);
    if (!response.ok || !payload?.access_token) {
      const [code, message, status] = publicError(upstreamCode(payload, 'oauth_failed'), response.status);
      throw new UberApiError(code, message, status, response.status);
    }
    return payload;
  }

  async saveTokens(userId, token, extra = {}) {
    const expiresIn = Math.max(60, Number(token.expires_in) || 2592000);
    const update = {
      accessTokenEncrypted: encryptUberToken(token.access_token),
      accessTokenExpiresAt: new Date(this.now().getTime() + expiresIn * 1000),
      scopes: String(token.scope || '').split(/\s+/).filter(Boolean),
      ...extra,
    };
    if (token.refresh_token) update.refreshTokenEncrypted = encryptUberToken(token.refresh_token);
    await this.Connection.findOneAndUpdate(
      { user: userId },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  async connectionStatus(userId) {
    const connection = await this.Connection.findOne({ user: userId }).select('scopes accessTokenExpiresAt connectedAt').lean();
    return {
      connected: Boolean(connection),
      scopes: connection?.scopes || [],
      connectedAt: connection?.connectedAt || null,
    };
  }

  async disconnect(userId) {
    const connection = await this.Connection.findOne({ user: userId }).select('+accessTokenEncrypted +refreshTokenEncrypted');
    if (!connection) return;
    let token = '';
    try { token = decryptUberToken(connection.refreshTokenEncrypted || connection.accessTokenEncrypted); } catch (_) { /* delete locally */ }
    if (token) {
      const body = new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, token });
      try {
        await this.rawFetch('https://auth.uber.com/oauth/v2/revoke', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
        });
      } catch (_) { /* local disconnect must still succeed */ }
    }
    await this.Connection.deleteOne({ user: userId });
  }

  async getAppAccessToken(force = false) {
    this.assertConfigured();
    if (!force && this.appToken && this.appToken.expiresAt > this.now().getTime() + 60000) return this.appToken.value;
    const token = await this.tokenRequest({ grant_type: 'client_credentials', scope: ESTIMATE_SCOPE });
    this.appToken = {
      value: token.access_token,
      expiresAt: this.now().getTime() + (Math.max(60, Number(token.expires_in) || 3600) * 1000),
    };
    return this.appToken.value;
  }

  async getUserAccessToken(userId, force = false) {
    const connection = await this.Connection.findOne({ user: userId }).select('+accessTokenEncrypted +refreshTokenEncrypted');
    if (!connection) throw new UberApiError('UBER_NOT_CONNECTED', 'Conecta tu cuenta Uber para continuar.', 401);
    if (!force && connection.accessTokenExpiresAt > new Date(this.now().getTime() + 60000)) {
      return decryptUberToken(connection.accessTokenEncrypted);
    }
    if (!connection.refreshTokenEncrypted) {
      await this.Connection.deleteOne({ user: userId });
      throw new UberApiError('UBER_REAUTHORIZE_REQUIRED', 'Vuelve a autorizar tu cuenta Uber.', 401);
    }
    if (!this.refreshes.has(String(userId))) {
      this.refreshes.set(String(userId), this.refreshUserToken(userId, connection).finally(() => this.refreshes.delete(String(userId))));
    }
    return this.refreshes.get(String(userId));
  }

  async refreshUserToken(userId, connection) {
    try {
      const token = await this.tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: decryptUberToken(connection.refreshTokenEncrypted),
      });
      await this.saveTokens(userId, token, { lastRefreshAt: this.now() });
      return token.access_token;
    } catch (error) {
      if (error.code === 'UBER_REAUTHORIZE_REQUIRED') await this.Connection.deleteOne({ user: userId });
      throw error;
    }
  }

  async apiRequest(path, { token, method = 'GET', body } = {}) {
    const response = await this.rawFetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Accept-Language': 'es_ES',
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await this.readJson(response);
    if (!response.ok) {
      const upstream = upstreamCode(payload, `http_${response.status}`);
      const [code, message, status] = publicError(upstream, response.status);
      throw new UberApiError(code, message, status, response.status, { upstreamCode: upstream });
    }
    return payload;
  }

  async userApiRequest(userId, path, options = {}, retried = false) {
    const token = await this.getUserAccessToken(userId, retried);
    try {
      return await this.apiRequest(path, { ...options, token });
    } catch (error) {
      if (!retried && error.upstreamStatus === 401) return this.userApiRequest(userId, path, options, true);
      throw error;
    }
  }

  async offerings(originRaw, destinationRaw) {
    const origin = point(originRaw, 'El origen');
    const destination = point(destinationRaw, 'El destino');
    let token = await this.getAppAccessToken();
    const queryProducts = new URLSearchParams({ latitude: origin.lat, longitude: origin.lng });
    const queryTime = new URLSearchParams({ start_latitude: origin.lat, start_longitude: origin.lng });
    const queryPrice = new URLSearchParams({
      start_latitude: origin.lat, start_longitude: origin.lng,
      end_latitude: destination.lat, end_longitude: destination.lng,
    });
    const optionalEstimate = async (path, kind) => {
      try {
        return await this.apiRequest(path, { token });
      } catch (error) {
        // A newly-created/Limited Access app may have products enabled before
        // Uber enables every estimate endpoint. Keep the product selector
        // usable; the authenticated upfront-fare call is still mandatory
        // before booking.
        if (error.upstreamStatus === 401) throw error;
        console.warn(`[uber:offerings:${kind}] ${error.code || 'unavailable'}`);
        return { _unavailable: true };
      }
    };
    const load = () => Promise.all([
      this.apiRequest(`/products?${queryProducts}`, { token }),
      optionalEstimate(`/estimates/time?${queryTime}`, 'time'),
      optionalEstimate(`/estimates/price?${queryPrice}`, 'price'),
    ]);
    let responses;
    try { responses = await load(); } catch (error) {
      if (error.upstreamStatus !== 401) throw error;
      token = await this.getAppAccessToken(true);
      responses = await load();
    }
    const [productsPayload, timesPayload, pricesPayload] = responses;
    const availabilityKnown = Array.isArray(timesPayload.times);
    const times = new Map((timesPayload.times || []).map((item) => [item.product_id, item]));
    const prices = new Map((pricesPayload.prices || []).map((item) => [item.product_id, item]));
    return (productsPayload.products || []).map((product) => {
      const eta = times.get(product.product_id);
      const price = prices.get(product.product_id);
      return {
        productId: product.product_id,
        displayName: product.display_name,
        description: product.description,
        capacity: product.capacity,
        imageUrl: product.image,
        upfrontFareEnabled: product.upfront_fare_enabled === true,
        available: !availabilityKnown || Number.isFinite(Number(eta?.estimate)),
        pickupEtaSeconds: Number.isFinite(Number(eta?.estimate)) ? Number(eta.estimate) : null,
        priceEstimate: price?.estimate || null,
        lowEstimate: Number.isFinite(Number(price?.low_estimate)) ? Number(price.low_estimate) : null,
        highEstimate: Number.isFinite(Number(price?.high_estimate)) ? Number(price.high_estimate) : null,
        currencyCode: price?.currency_code || product.price_details?.currency_code || null,
        tripDurationSeconds: Number.isFinite(Number(price?.duration)) ? Number(price.duration) : null,
        distance: Number.isFinite(Number(price?.distance)) ? Number(price.distance) : null,
      };
    }).filter((item) => item.upfrontFareEnabled);
  }

  async paymentMethods(userId) {
    const payload = await this.userApiRequest(userId, '/payment-methods');
    return {
      paymentMethods: (payload.payment_methods || []).map((item) => ({
        id: item.payment_method_id,
        type: item.type,
        description: item.description,
      })),
      lastUsed: payload.last_used || null,
    };
  }

  rideBody(input, { requireFare = false } = {}) {
    const origin = point(input.origin, 'El origen');
    const destination = point(input.destination, 'El destino');
    const body = {
      product_id: cleanId(input.productId, 'productId'),
      start_latitude: origin.lat,
      start_longitude: origin.lng,
      end_latitude: destination.lat,
      end_longitude: destination.lng,
    };
    if (input.paymentMethodId) body.payment_method_id = cleanId(input.paymentMethodId, 'paymentMethodId');
    if (requireFare) body.fare_id = cleanId(input.fareId, 'fareId');
    return body;
  }

  async estimateRide(userId, input) {
    const payload = await this.userApiRequest(userId, '/requests/estimate', {
      method: 'POST', body: this.rideBody(input),
    });
    return {
      fareId: payload.fare?.fare_id || null,
      fareDisplay: payload.fare?.display || null,
      fareValue: payload.fare?.value ?? null,
      currencyCode: payload.fare?.currency_code || null,
      expiresAt: payload.fare?.expires_at || null,
      pickupEtaMinutes: payload.pickup_estimate ?? null,
      durationSeconds: payload.trip?.duration_estimate ?? null,
      distance: payload.trip?.distance_estimate ?? null,
      distanceUnit: payload.trip?.distance_unit || null,
    };
  }

  async createRide(userId, input) {
    const payload = await this.userApiRequest(userId, '/requests', {
      method: 'POST', body: this.rideBody(input, { requireFare: true }),
    });
    if (payload.request_id) {
      await this.Connection.updateOne({ user: userId }, { $set: { currentRequestId: payload.request_id } });
    }
    return this.normalizeRide(payload);
  }

  normalizeRide(payload) {
    return {
      requestId: payload.request_id || null,
      productId: payload.product_id || null,
      status: payload.status || 'processing',
      etaMinutes: payload.eta ?? payload.pickup?.eta ?? null,
      driver: payload.driver ? {
        name: payload.driver.name || null,
        rating: payload.driver.rating ?? null,
        pictureUrl: payload.driver.picture_url || null,
      } : null,
      vehicle: payload.vehicle ? {
        make: payload.vehicle.make || null,
        model: payload.vehicle.model || null,
        licensePlate: payload.vehicle.license_plate || null,
        pictureUrl: payload.vehicle.picture_url || null,
      } : null,
      location: payload.location ? {
        lat: payload.location.latitude,
        lng: payload.location.longitude,
        bearing: payload.location.bearing ?? null,
      } : null,
      terminal: TERMINAL_STATUSES.has(payload.status),
    };
  }

  async currentRide(userId) {
    const connection = await this.Connection.findOne({ user: userId }).select('currentRequestId').lean();
    try {
      // Prefer the account's real active trip. This also handles an existing
      // trip created in Uber itself or by another approved integration.
      return this.normalizeRide(await this.userApiRequest(userId, '/requests/current'));
    } catch (error) {
      if (error.upstreamStatus !== 404) throw error;
    }
    if (!connection?.currentRequestId) return null;
    try {
      return this.normalizeRide(await this.userApiRequest(
        userId,
        `/requests/${encodeURIComponent(connection.currentRequestId)}`,
      ));
    } catch (error) {
      if (error.upstreamStatus === 404) return null;
      throw error;
    }
  }

  async cancelRide(userId) {
    await this.userApiRequest(userId, '/requests/current', { method: 'DELETE' });
    return { status: 'rider_canceled' };
  }

  async rawFetch(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(2000, Number(process.env.UBER_HTTP_TIMEOUT_MS) || 10000));
    try {
      return await this.fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      throw new UberApiError(
        'UBER_UNAVAILABLE',
        error?.name === 'AbortError' ? 'Uber no ha respondido a tiempo.' : 'No se ha podido conectar con Uber.',
        503,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async readJson(response) {
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch (_) { return {}; }
  }
}

module.exports = {
  UberRidersClient,
  UberApiError,
  USER_SCOPES,
  ESTIMATE_SCOPE,
  TERMINAL_STATUSES,
  point,
};
