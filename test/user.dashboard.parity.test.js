const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dashboard = fs.readFileSync(
  path.join(__dirname, '../public/js/dashboard.js'),
  'utf8',
);
const dashboardCss = fs.readFileSync(
  path.join(__dirname, '../public/css/dashboard.css'),
  'utf8',
);
const stepcoinsRoute = fs.readFileSync(
  path.join(__dirname, '../api/routes/stepcoins.js'),
  'utf8',
);
const flutterRoulette = fs.readFileSync(
  path.join(__dirname, '../../ablee/lib/roles/client/roulette_screen.dart'),
  'utf8',
);

test('the web profile uses the same profile and nickname routes as Flutter', () => {
  for (const route of ['/api/user/data', '/api/user/update', '/api/social/me/nickname']) {
    assert.match(dashboard, new RegExp(route.replaceAll('/', '\\/')));
  }
  for (const field of [
    'nickname', 'name', 'lastName', 'address', 'city', 'country',
    'idCardFront', 'idCardBack', 'licenseFront', 'licenseBack',
  ]) {
    assert.match(dashboard, new RegExp(`name=["']${field}["']`));
  }
});

test('the web roulette exposes Flutter games and submits authoritative sessions', () => {
  for (const label of [
    'Juego de Cultura', 'Memory Game', 'Reflex Game',
    'Gana 20000 Stepcoins', 'Pierde 20000 Stepcoins',
  ]) {
    assert.match(flutterRoulette, new RegExp(label));
    assert.match(dashboard, new RegExp(label));
  }
  assert.match(dashboard, /\/api\/stepcoins\/ruleta/);
  assert.doesNotMatch(dashboard, /Juego Nave Espacial/);
  assert.match(dashboard, /clientSurface: "web"/);
  assert.match(stepcoinsRoute, /clientSurface === 'web'/);
  assert.match(stepcoinsRoute, /label !== MINI_GAMES\.space\.rouletteLabel/);
  assert.match(dashboard, /\/api\/stepcoins\/minigame-result/);
  assert.match(dashboard, /targetModulo = \(360 - angleToSliceCenter\)/);
});

test('skin and reward purchases share Flutter persistence routes', () => {
  assert.match(dashboard, /\/api\/stepcoins\/comprar-skin/);
  assert.match(dashboard, /\/api\/users\/\$\{currentUserId\}\/skins/);
  assert.match(dashboard, /\/api\/rewards\/\$\{id\}\/comprar/);
  assert.match(dashboard, /\/api\/rewards\/mis-compras/);
  assert.match(dashboardCss, /\.user-rewards-grid\s*\{[^}]*repeat\(4,/s);
  assert.doesNotMatch(dashboard, /onclick=["'][^"']*comprarSkin/);
  assert.doesNotMatch(dashboard, /onclick=["'][^"']*canjearReward/);
  assert.match(dashboard, /data-user-action="purchase-skin"/);
  assert.match(dashboard, /data-user-action="redeem-reward"/);
});

test('roulette cards refresh from their canonical collection and Culture has a safe launcher', () => {
  assert.match(dashboard, /if \(data\.nuevaCarta\) \{\s*await cargarCartasCliente\(\);/);
  assert.match(dashboard, /function mostrarLanzadorCultura\(sessionId\)/);
  assert.match(dashboard, /class="culture-launch-button"/);
});

test('Vision Dios is hidden from every client navigation surface', () => {
  const clientMenu = dashboard.match(/cliente:\s*\[([\s\S]*?)\],\s*comercio:/)?.[1] || '';
  const csrShell = dashboard.match(/function renderCsrShell[\s\S]*?^}/m)?.[0] || '';
  const home = dashboard.match(/async function renderInicio[\s\S]*?^}/m)?.[0] || '';
  assert.doesNotMatch(clientMenu, /Visión Dios/);
  assert.doesNotMatch(csrShell, /Visión Dios/);
  assert.doesNotMatch(home, /Visión Dios/);
});
