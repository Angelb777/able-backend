const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dashboard = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'dashboard.js'),
  'utf8',
);

test('game management edit controls use CSP-safe delegated events', () => {
  assert.match(dashboard, /function bindGameManagementActions\(\)/);
  assert.match(dashboard, /bindGameManagementActions\(\);/);
  for (const action of [
    'edit-ufo', 'delete-ufo',
    'edit-skin', 'delete-skin',
    'edit-card', 'delete-card',
  ]) {
    assert.match(dashboard, new RegExp(`data-game-management-action="${action}"`));
  }
  assert.doesNotMatch(dashboard, /onclick="editar(?:Ufo|Skin|Carta)\(/);
  assert.doesNotMatch(dashboard, /onclick="eliminar(?:Ufo|Skin|Carta)\(/);
});

test('delegated game controls invoke every editor and delete action', () => {
  const start = dashboard.indexOf('function bindGameManagementActions()');
  const end = dashboard.indexOf('\nfunction commercialEscape', start);
  const listeners = {};
  const calls = [];
  const context = vm.createContext({
    document: {
      documentElement: { dataset: {} },
      addEventListener: (name, listener) => { listeners[name] = listener; },
    },
    editarUfo: (id) => calls.push(['edit-ufo', id]),
    eliminarUfo: (id) => calls.push(['delete-ufo', id]),
    editarSkin: (id) => calls.push(['edit-skin', id]),
    eliminarSkin: (id) => calls.push(['delete-skin', id]),
    editarCarta: (id) => calls.push(['edit-card', id]),
    eliminarCarta: (id) => calls.push(['delete-card', id]),
  });
  vm.runInContext(`${dashboard.slice(start, end)}; bindGameManagementActions();`, context);

  for (const action of [
    'edit-ufo', 'delete-ufo', 'edit-skin',
    'delete-skin', 'edit-card', 'delete-card',
  ]) {
    listeners.click({
      preventDefault() {},
      target: {
        closest: () => ({
          dataset: { gameManagementAction: action, entityId: 'entity-1' },
        }),
      },
    });
  }
  assert.deepEqual(calls, [
    ['edit-ufo', 'entity-1'],
    ['delete-ufo', 'entity-1'],
    ['edit-skin', 'entity-1'],
    ['delete-skin', 'entity-1'],
    ['edit-card', 'entity-1'],
    ['delete-card', 'entity-1'],
  ]);
});

test('the admin dashboard authenticates with the shared backend session', () => {
  assert.match(dashboard, /fetch\('\/api\/auth\/me'\)/);
  assert.match(dashboard, /credentials: 'same-origin'/);
  assert.doesNotMatch(dashboard, /localStorage\.getItem\(['"]token/);
});

test('all five police waves expose editable and persisted fields', () => {
  assert.match(dashboard, /Array\.from\(\{ length: 5 \}/);
  assert.match(dashboard, /Oleada \$\{level\}/);
  for (const field of [
    'footOfficers', 'cars', 'helicopters', 'spawnDelaySeconds',
    'escapeDistanceMeters', 'escapeHoldSeconds', 'completionCondition',
    'autoEscalate',
  ]) {
    assert.match(dashboard, new RegExp(`star\\$\\{level\\}_${field}`));
  }
  assert.match(dashboard, /config\.stars\.push\(/);
  assert.match(dashboard, /data\.set\("config", JSON\.stringify\(collectPoliceConfig\(form\)\)\)/);
});
