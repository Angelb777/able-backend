const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const dashboard = read('public/js/dashboard.js');

test('the served web dashboard exposes the centralized commerce workflow', () => {
  const server = read('server.js');
  const html = read('public/dashboard.html');
  const script = dashboard;

  assert.match(server, /express\.static\(path\.join\(__dirname,\s*['"]public['"]\)\)/);
  assert.match(server, /app\.use\(['"]\/api\/commercial['"]/);
  assert.match(html, /<script src="js\/dashboard\.js\?v=commerce-csp-actions-1"><\/script>/);

  for (const id of [
    'commerceEstablishment',
    'commercePositioning',
    'commerceSkins',
    'commerceWeapons',
    'commerceRewards',
    'commerceRequests',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }

  const commerceMenu = script.match(/comercio:\s*\[([\s\S]*?)\],\s*admin:/);
  assert.ok(commerceMenu, 'commerce menu must exist');
  const labels = Array.from(commerceMenu[1].matchAll(/"([^"]+)"/g), (match) => match[1]);
  assert.deepEqual(labels, [
    'Mi establecimiento',
    'Posicionamiento',
    'Skins',
    'Armas',
    'Descuentos y premios',
    'Mis solicitudes',
    'Historial de pagos',
    'Lista de compradores',
  ]);

  for (const endpoint of [
    '/api/commercial/establishment',
    '/api/commercial/packages',
    '/api/commercial/specifications',
    '/api/commercial/requests',
  ]) {
    assert.ok(script.includes(endpoint), `${endpoint} must be connected from the dashboard`);
  }
  assert.match(script, /role = String\(user\.role \|\| ""\)\.toLowerCase\(\)/);
  assert.match(script, /establishment\?\.status === "approved"/);
  assert.match(script, /\/api\/commercial\/requests\/\$\{encodeURIComponent\(id\)\}\/pay/);
  assert.match(script, /Pagar y publicar/);
  assert.match(script, /function bindCommercialActions\(\)/);
  assert.match(script, /data-commercial-action="manage-establishment"/);
  assert.match(script, /data-workflow-action="approve"/);
  assert.doesNotMatch(script, /onclick="commercial(?:Establishment|Request)Action/);
  assert.doesNotMatch(script, /onclick="(?:createCommercePositioningRequest|payCommercePositioning|uploadCommerceRequestMaterial|withdrawCommerceRequest)/);

  const commercialHtml = html.slice(
    html.indexOf('id="gestionComercial"'),
    html.indexOf('<!-- Sección Mis Pagos'),
  );
  assert.doesNotMatch(commercialHtml, /\son(?:click|change)=/);
});

test('commercial approval uses the CSP-safe delegated click handler', async () => {
  const start = dashboard.indexOf('function bindCommercialActions()');
  const end = dashboard.indexOf('\nfunction commercialEscape', start);
  const listeners = {};
  const calls = [];
  const context = vm.createContext({
    document: {
      documentElement: { dataset: {} },
      addEventListener: (name, listener) => { listeners[name] = listener; },
    },
    commercialEstablishmentAction: async (id, action) => calls.push([id, action]),
    commercialRequestAction: async () => {},
    createCommercePositioningRequest: async () => {},
    uploadCommerceRequestMaterial: async () => {},
    withdrawCommerceRequest: async () => {},
    payCommercePositioning: async () => {},
    renderGestionComercial: async () => {},
    renderCommerceRequests: async () => {},
  });
  vm.runInContext(`${dashboard.slice(start, end)}; bindCommercialActions();`, context);
  const button = {
    dataset: {
      commercialAction: 'manage-establishment',
      entityId: 'establishment-1',
      workflowAction: 'approve',
    },
    disabled: false,
    isConnected: true,
  };
  await listeners.click({ preventDefault() {}, target: { closest: () => button } });
  assert.deepEqual(calls, [['establishment-1', 'approve']]);
  assert.equal(button.disabled, false);
});
