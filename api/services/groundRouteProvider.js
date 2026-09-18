const { createValhallaDirections } = require('./valhallaDirections');

function createGroundRouteProvider({
  provider = process.env.GROUND_ROUTING_PROVIDER || 'valhalla',
  ...options
} = {}) {
  const normalized = String(provider).trim().toLowerCase();
  if (normalized !== 'valhalla') {
    throw new Error(`GROUND_ROUTING_PROVIDER no soportado: ${normalized || '(vacio)'}. Solo Valhalla; las rutas de pago estan desactivadas.`);
  }
  return createValhallaDirections(options);
}

module.exports = { createGroundRouteProvider };
