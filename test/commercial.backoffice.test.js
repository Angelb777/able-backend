const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const dashboard = read('public/js/dashboard.js');

test('the dashboard exposes direct multi-location map subscriptions', () => {
  const server = read('server.js');
  const html = read('public/dashboard.html');
  const script = dashboard;

  assert.match(server, /express\.static\(path\.join\(__dirname,\s*['"]public['"]\)\)/);
  assert.match(server, /app\.use\(['"]\/api\/commercial['"]/);
  assert.match(html, /<script src="js\/dashboard\.js\?v=commerce-locations-1"><\/script>/);

  for (const id of [
    'commerceEstablishment',
    'commerceLocationsList',
    'commerceSkins',
    'commerceWeapons',
    'commerceRewards',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }

  const commerceMenu = script.match(/comercio:\s*\[([\s\S]*?)\],\s*admin:/);
  assert.ok(commerceMenu, 'commerce menu must exist');
  const labels = Array.from(commerceMenu[1].matchAll(/"([^"]+)"/g), (match) => match[1]);
  assert.deepEqual(labels, [
    'Mi establecimiento',
    'Skins',
    'Armas',
    'Descuentos y premios',
    'Historial de pagos',
    'Lista de compradores',
  ]);

  for (const endpoint of [
    '/api/commercial/locations',
    '/api/commercial/map-plans',
    '/api/commercial/specifications',
  ]) {
    assert.ok(script.includes(endpoint), `${endpoint} must be connected from the dashboard`);
  }
  assert.match(script, /role = String\(user\.role \|\| ""\)\.toLowerCase\(\)/);
  assert.match(html, /Promociona tu local físico en el mapa/);
  assert.match(html, /Llega a más clientes de verdad/);
  assert.match(script, /\/api\/commercial\/locations\/\$\{id\}\/subscribe/);
  assert.match(script, /El local ya está publicado en el mapa/);
  assert.doesNotMatch(html, /id="gestionComercial"/);
  assert.doesNotMatch(html, /id="commercePositioning"/);
  assert.doesNotMatch(html, /id="commerceRequests"/);
  assert.doesNotMatch(commerceMenu[1], /Posicionamiento|Mis solicitudes/);
  assert.match(script, /function bindCommercialActions\(\)/);
  assert.match(script, /data-commercial-action="subscribe-location"/);

  const commercialHtml = html.slice(
    html.indexOf('id="commerceEstablishment"'),
    html.indexOf('<!-- Sección Mis Pagos'),
  );
  assert.doesNotMatch(commercialHtml, /\son(?:click|change)=/);
});

test('location subscription uses the CSP-safe delegated click handler', async () => {
  const start = dashboard.indexOf('function bindCommercialActions()');
  const end = dashboard.indexOf('\nfunction commercialEscape', start);
  const listeners = {};
  const calls = [];
  const context = vm.createContext({
    document: {
      documentElement: { dataset: {} },
      addEventListener: (name, listener) => { listeners[name] = listener; },
    },
    commercialEstablishmentAction: async () => {},
    commercialRequestAction: async () => {},
    createCommercePositioningRequest: async () => {},
    uploadCommerceRequestMaterial: async () => {},
    withdrawCommerceRequest: async () => {},
    payCommercePositioning: async () => {},
    renderGestionComercial: async () => {},
    renderCommerceRequests: async () => {},
    subscribeCommerceLocation: async (id, planId) => calls.push([id, planId]),
  });
  vm.runInContext(`${dashboard.slice(start, end)}; bindCommercialActions();`, context);
  const button = {
    dataset: {
      commercialAction: 'subscribe-location',
      entityId: 'location-1',
      planId: 'plan-1',
    },
    disabled: false,
    isConnected: true,
  };
  await listeners.click({ preventDefault() {}, target: { closest: () => button } });
  assert.deepEqual(calls, [['location-1', 'plan-1']]);
  assert.equal(button.disabled, false);
});
