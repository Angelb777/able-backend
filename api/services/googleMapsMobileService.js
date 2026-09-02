const GOOGLE_MAPS_HOST = 'https://maps.googleapis.com';

class GoogleMapsMobileServiceError extends Error {
  constructor(message, { code = 'GOOGLE_MAPS_UNAVAILABLE', status = 502 } = {}) {
    super(message);
    this.name = 'GoogleMapsMobileServiceError';
    this.code = code;
    this.status = status;
  }
}

function validCoordinate(point) {
  return point && Number.isFinite(point.lat) && Number.isFinite(point.lng) &&
    point.lat >= -90 && point.lat <= 90 && point.lng >= -180 && point.lng <= 180;
}

function createGoogleMapsMobileService({
  apiKey = process.env.GOOGLE_MAPS_MOBILE_SERVICES_API_KEY || '',
  fetchImpl = global.fetch,
  timeoutMs = 14000,
} = {}) {
  async function request(path, parameters, requestTimeoutMs = timeoutMs) {
    if (!apiKey) {
      throw new GoogleMapsMobileServiceError('Google Maps no esta configurado', {
        code: 'GOOGLE_MAPS_NOT_CONFIGURED',
        status: 503,
      });
    }
    if (typeof fetchImpl !== 'function') {
      throw new GoogleMapsMobileServiceError('Cliente HTTP no disponible');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const query = new URLSearchParams({ ...parameters, key: apiKey });
      const response = await fetchImpl(`${GOOGLE_MAPS_HOST}${path}?${query}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new GoogleMapsMobileServiceError(`Google Maps HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      if (error instanceof GoogleMapsMobileServiceError) throw error;
      const message = error?.name === 'AbortError'
        ? 'Google Maps ha agotado el tiempo de espera'
        : 'No se ha podido consultar Google Maps';
      throw new GoogleMapsMobileServiceError(message);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    directions({ origin, destination, mode }) {
      if (!validCoordinate(origin) || !validCoordinate(destination)) {
        throw new TypeError('INVALID_COORDINATES');
      }
      return request('/maps/api/directions/json', {
        origin: `${origin.lat},${origin.lng}`,
        destination: `${destination.lat},${destination.lng}`,
        mode,
        language: 'es',
      });
    },

    autocomplete({ input, sessionToken, origin }) {
      return request('/maps/api/place/autocomplete/json', {
        input,
        language: 'es',
        region: 'es',
        sessiontoken: sessionToken,
        ...(origin ? {
          location: `${origin.lat},${origin.lng}`,
          radius: '50000',
        } : {}),
      }, 10000);
    },

    details({ placeId, sessionToken }) {
      return request('/maps/api/place/details/json', {
        place_id: placeId,
        fields: 'geometry',
        language: 'es',
        sessiontoken: sessionToken,
      }, 10000);
    },
  };
}

module.exports = {
  GoogleMapsMobileServiceError,
  createGoogleMapsMobileService,
  validCoordinate,
};
