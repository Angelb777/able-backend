const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const jwt = require('jsonwebtoken');

const PoliceConfig = require('../api/models/PoliceConfig');
const User = require('../api/models/User');

test('Police dashboard uses shared session fetch and exposes rows and columns', () => {
  const dashboard = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'dashboard.js'),
    'utf8'
  );
  const policeSectionStart = dashboard.indexOf('const policeUnitMeta');
  const policeSection = dashboard.slice(
    policeSectionStart,
    dashboard.indexOf('async function renderGestionJuego', policeSectionStart)
  );

  assert.doesNotMatch(policeSection, /Bearer \$\{token\}/);
  assert.doesNotMatch(policeSection, /Config spritesheet JSON/);
  assert.match(policeSection, /Filas <input[^>]+spritesheetRows/);
  assert.match(policeSection, /Columnas <input[^>]+spritesheetColumns/);
  assert.match(policeSection, /const gridChanged = rows !== Number\(storedSheet\.rows\)/);
  assert.match(policeSection, /spritesheet: \{ \.\.\.storedSheet, rows, columns, frames \}/);

  const context = vm.createContext({});
  vm.runInContext(
    `${policeSection}; globalThis.collectPoliceConfigForTest = collectPoliceConfig;`,
    context
  );
  const fields = new Map();
  const field = (name, value = 0, checked = false) => fields.set(name, {
    value: String(value), checked,
  });
  for (const name of ['reuseRadiusMeters', 'maxActiveIncidents', 'maxUnitsPerIncident',
    'maxNearbyUnits', 'updateIntervalMs', 'routeRecalculationDistanceMeters',
    'routeCacheTtlSeconds', 'targetLockSeconds', 'spawnDistanceMeters']) field(name, 1);
  for (const type of ['foot', 'car', 'helicopter']) {
    field(`${type}_label`, type);
    field(`${type}_renderType`, 'flame_spritesheet');
    field(`${type}_spritesheetMetadata`, JSON.stringify({
      rows: type === 'foot' ? 2 : 1,
      columns: type === 'foot' ? 4 : 1,
      frames: type === 'foot' ? 6 : 1,
      fps: 12,
    }));
    field(`${type}_spritesheetRows`, type === 'car' ? 2 : (type === 'foot' ? 2 : 1));
    field(`${type}_spritesheetColumns`, type === 'car' ? 3 : (type === 'foot' ? 4 : 1));
    for (const name of ['life', 'speedMetersPerSecond', 'damage', 'rangeMeters',
      'fireIntervalSeconds', 'cooldownSeconds', 'projectileSpeedMetersPerSecond',
      'hitRadiusMeters']) field(`${type}_${name}`, 1);
  }
  for (let level = 1; level <= 5; level += 1) {
    for (const name of ['footOfficers', 'cars', 'helicopters', 'spawnDelaySeconds',
      'escapeDistanceMeters', 'escapeHoldSeconds']) field(`star${level}_${name}`, 1);
    field(`star${level}_completionCondition`, 'all_units_destroyed');
    field(`star${level}_autoEscalate`, '', true);
  }
  const collected = context.collectPoliceConfigForTest({
    enabled: { checked: true },
    elements: { namedItem: (name) => fields.get(name) },
  });
  assert.equal(collected.units.foot.spritesheet.frames, 6);
  assert.equal(collected.units.car.spritesheet.rows, 2);
  assert.equal(collected.units.car.spritesheet.columns, 3);
  assert.equal(collected.units.car.spritesheet.frames, 6);
});

test('Police configuration saves, reloads and edits spritesheet grids', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  const originalFindById = User.findById;
  const originalFindOne = PoliceConfig.findOne;
  const originalFindOneAndUpdate = PoliceConfig.findOneAndUpdate;
  process.env.JWT_SECRET = 'police-dashboard-route-test-secret';

  let stored = null;
  User.findById = () => {
    const query = {
      select: () => query,
      lean: async () => ({
        _id: '507f1f77bcf86cd799439011',
        role: 'admin',
        email: 'admin@able73.test',
        nickname: 'Admin',
      }),
    };
    return query;
  };
  PoliceConfig.findOne = () => ({
    lean: async () => stored && structuredClone(stored),
  });
  PoliceConfig.findOneAndUpdate = async (_filter, update) => {
    const document = new PoliceConfig(update.$set);
    const validationError = document.validateSync();
    if (validationError) throw validationError;
    stored = document.toObject();
    return document;
  };

  delete require.cache[require.resolve('../api/routes/police')];
  const policeRouter = require('../api/routes/police');
  const app = express();
  app.use('/api/police', policeRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const token = jwt.sign(
    { id: '507f1f77bcf86cd799439011' },
    process.env.JWT_SECRET
  );
  const headers = { Authorization: `Bearer ${token}` };

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    User.findById = originalFindById;
    PoliceConfig.findOne = originalFindOne;
    PoliceConfig.findOneAndUpdate = originalFindOneAndUpdate;
    delete require.cache[require.resolve('../api/routes/police')];
    if (previousSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  const firstConfig = PoliceConfig.defaults();
  firstConfig.units.foot.renderType = 'flame_spritesheet';
  firstConfig.units.foot.spritesheet = {
    url: '/uploads/police/foot.png', rows: 2, columns: 4,
    frames: 8, fps: 12, loop: true,
  };
  const firstBody = new FormData();
  firstBody.set('config', JSON.stringify(firstConfig));
  const firstSave = await fetch(`${baseUrl}/api/police`, {
    method: 'PUT', headers, body: firstBody,
  });
  assert.equal(firstSave.status, 200);

  const firstReload = await fetch(`${baseUrl}/api/police`, { headers });
  assert.equal(firstReload.status, 200);
  const reloaded = await firstReload.json();
  assert.equal(reloaded.units.foot.spritesheet.rows, 2);
  assert.equal(reloaded.units.foot.spritesheet.columns, 4);
  assert.equal(reloaded.units.foot.spritesheet.frames, 8);

  const editedConfig = PoliceConfig.defaults();
  editedConfig.units.foot.renderType = 'flame_spritesheet';
  editedConfig.units.foot.spritesheet = {
    ...reloaded.units.foot.spritesheet,
    rows: 3,
    columns: 5,
    frames: 15,
  };
  const editBody = new FormData();
  editBody.set('config', JSON.stringify(editedConfig));
  const editSave = await fetch(`${baseUrl}/api/police`, {
    method: 'PUT', headers, body: editBody,
  });
  assert.equal(editSave.status, 200);

  const editedReload = await fetch(`${baseUrl}/api/police`, { headers });
  assert.equal(editedReload.status, 200);
  const edited = await editedReload.json();
  assert.equal(edited.units.foot.spritesheet.rows, 3);
  assert.equal(edited.units.foot.spritesheet.columns, 5);
  assert.equal(edited.units.foot.spritesheet.frames, 15);
  assert.equal(edited.units.foot.spritesheet.url, '/uploads/police/foot.png');
});
