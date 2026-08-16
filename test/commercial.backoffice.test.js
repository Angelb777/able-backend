const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('the served web dashboard exposes the centralized commerce workflow', () => {
  const server = read('server.js');
  const html = read('public/dashboard.html');
  const script = read('public/js/dashboard.js');

  assert.match(server, /express\.static\(path\.join\(__dirname,\s*['"]public['"]\)\)/);
  assert.match(server, /app\.use\(['"]\/api\/commercial['"]/);
  assert.match(html, /<script src="js\/dashboard\.js\?v=police-pair-effects-3"><\/script>/);

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
});
