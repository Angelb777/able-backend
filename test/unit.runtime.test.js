const test = require('node:test');
const assert = require('node:assert/strict');
const geo = require('../utils/geo');
const { createUnitRuntime } = require('../api/services/unitRuntime');

function fixture() {
  let clock = 10000;
  const events = [];
  const players = [];
  const turrets = [];
  const police = [];
  const hostilePolice = new Set();
  const playerDamage = [];
  const turretDamage = [];
  const runtime = createUnitRuntime({
    nsp: { to: (zoneId) => ({ emit: (event, payload) => events.push({ zoneId, event, payload }) }) },
    geo,
    routeProvider: {
      getRoute: async (from, to) => [from, to],
      clear() {},
    },
    getPlayersInZone: () => players,
    getTurretsInZone: () => turrets,
    getPoliceUnitsInZone: () => police,
    isPoliceHostileToUser: (unitId, userId) => hostilePolice.has(`${unitId}:${userId}`),
    areUsersAllied: async () => false,
    applyPlayerDamage: async (data) => playerDamage.push(data),
    applyTurretDamage: async (...args) => turretDamage.push(args),
    applyPoliceDamage: () => {},
    now: () => clock,
    updateIntervalMs: 100,
  });
  const definition = (overrides = {}) => ({
    unitCount: 1,
    unitSpacingMeters: 3,
    life: 100,
    detectionRangeMeters: 100,
    attackRangeMeters: 2,
    maxPursuitDistanceMeters: 40,
    speedMetersPerSecond: 5,
    damage: 10,
    attackCooldownSeconds: 1,
    durationSeconds: 60,
    ...overrides,
  });
  const spawn = (ownerUserId = 'owner', overrides = {}) => runtime.spawnGroup({
    ownerUserId,
    cardId: 'troop-card',
    zoneId: 'zone',
    position: { lat: 41.6567, lng: -0.8785 },
    definition: definition(overrides),
  });
  return {
    runtime, events, players, turrets, police, hostilePolice, playerDamage,
    turretDamage,
    spawn, advance: (ms) => { clock += ms; },
    tick: async (seconds = 0.1) => runtime._debug.logicTick(clock, seconds),
  };
}

test('troop formation creates independent units with configured spacing and life', (t) => {
  const fx = fixture();
  t.after(() => fx.runtime.shutdown());
  const spawned = fx.spawn('owner', { unitCount: 3, unitSpacingMeters: 4, life: 75 });
  assert.equal(spawned.length, 3);
  assert.ok(geo.distanceMeters(spawned[0], spawned[1]) >= 3.9);
  assert.ok(geo.distanceMeters(spawned[1], spawned[2]) >= 3.9);
  assert.deepEqual(spawned.map((unit) => unit.life), [75, 75, 75]);
});

test('police is ignored until it is hostile to the troop owner', async (t) => {
  const fx = fixture();
  t.after(() => fx.runtime.shutdown());
  fx.spawn();
  fx.police.push({
    unitId: 'officer', life: 100,
    ...geo.computeOffset({ lat: 41.6567, lng: -0.8785 }, 10, 0),
  });

  await fx.tick();
  let unit = fx.runtime.getUnitsInZone('zone')[0];
  assert.equal(unit.targetType, null);
  assert.equal(unit.state, 'idle');

  fx.hostilePolice.add('officer:owner');
  await fx.tick();
  unit = fx.runtime.getUnitsInZone('zone')[0];
  assert.equal(unit.targetType, 'police');
  assert.equal(unit.targetId, 'officer');
});

test('maximum pursuit is anchored to the original deployment point', async (t) => {
  const fx = fixture();
  t.after(() => fx.runtime.shutdown());
  fx.spawn('owner', { detectionRangeMeters: 200, maxPursuitDistanceMeters: 40 });
  const origin = { lat: 41.6567, lng: -0.8785 };
  fx.players.push({ userId: 'enemy', vida: 1000, gameModeEnabled: true,
    ...geo.computeOffset(origin, 45, 0) });

  await fx.tick();
  const unit = fx.runtime.getUnitsInZone('zone')[0];
  assert.equal(unit.targetId, null);
  assert.equal(unit.state, 'idle');

  const inside = geo.computeOffset(origin, 30, 0);
  fx.players[0].lat = inside.lat;
  fx.players[0].lng = inside.lng;
  await fx.tick();
  assert.equal(unit.targetId, 'enemy');

  const outside = geo.computeOffset(origin, 50, 0);
  fx.players[0].lat = outside.lat;
  fx.players[0].lng = outside.lng;
  await fx.tick();
  assert.equal(unit.targetId, null);
  assert.equal(unit.state, 'idle');
});

test('melee attack is authoritative and uses cooldown without projectiles', async (t) => {
  const fx = fixture();
  t.after(() => fx.runtime.shutdown());
  fx.spawn('owner', { attackRangeMeters: 5, attackCooldownSeconds: 1, damage: 25 });
  fx.players.push({ userId: 'enemy', vida: 1000, gameModeEnabled: true,
    ...geo.computeOffset({ lat: 41.6567, lng: -0.8785 }, 2, 0) });

  await fx.tick();
  await fx.tick();
  assert.equal(fx.playerDamage.length, 1);
  assert.equal(fx.playerDamage[0].damage, 25);
  assert.equal(fx.events.filter((item) => item.event === 'unit:attack').length, 1);

  fx.advance(1000);
  await fx.tick();
  assert.equal(fx.playerDamage.length, 2);
});

test('destroying a unit emits no reward event and removes it from snapshots', (t) => {
  const fx = fixture();
  t.after(() => fx.runtime.shutdown());
  const [unit] = fx.spawn();
  const result = fx.runtime.applyDamage(unit.unitId, 100, 'enemy', 'hit-1');
  assert.equal(result.dead, true);
  assert.equal(fx.runtime.getSnapshot('zone').units.length, 0);
  assert.equal(fx.events.some((item) => item.event === 'combat:death'), false);
});

test('units fight enemy units and never treat mines as targets', async (t) => {
  const fx = fixture();
  t.after(() => fx.runtime.shutdown());
  const [attacker] = fx.spawn('owner', {
    attackRangeMeters: 5, damage: 100, detectionRangeMeters: 50,
  });
  const [enemy] = fx.spawn('enemy', { attackRangeMeters: 5, life: 100 });

  await fx.tick();

  assert.equal(fx.runtime.getUnitsInZone('zone')
    .some((unit) => unit.unitId === enemy.unitId), false);
  assert.equal(fx.events.some((item) =>
    item.event === 'unit:attack' && item.payload.unitId === attacker.unitId &&
    item.payload.targetType === 'unit'), true);
  assert.equal(fx.events.some((item) => item.payload?.targetType === 'mine'), false);
});

test('duration and owner removal delete every surviving unit', async (t) => {
  const fx = fixture();
  t.after(() => fx.runtime.shutdown());
  fx.spawn('expiring', { unitCount: 2, durationSeconds: 1 });
  fx.spawn('leaving', { unitCount: 3, durationSeconds: 60 });

  fx.advance(1000);
  await fx.tick();
  assert.equal(fx.runtime.getUnitsInZone('zone')
    .some((unit) => unit.ownerUserId === 'expiring'), false);
  assert.equal(fx.runtime.removeOwner('leaving'), 3);
  assert.equal(fx.runtime.getUnitsInZone('zone').length, 0);
});

test('a troop can acquire and melee an enemy turret', async (t) => {
  const fx = fixture();
  t.after(() => fx.runtime.shutdown());
  fx.spawn('owner', { attackRangeMeters: 5, damage: 35 });
  fx.turrets.push({
    _id: 'turret-1', ownerUserId: 'enemy', vida: 100,
    ...geo.computeOffset({ lat: 41.6567, lng: -0.8785 }, 2, 0),
  });

  await fx.tick();

  assert.equal(fx.turretDamage.length, 1);
  assert.deepEqual(fx.turretDamage[0].slice(0, 3), ['turret-1', 35, 'owner']);
  assert.equal(fx.events.some((item) =>
    item.event === 'unit:attack' && item.payload.targetType === 'turret'), true);
});
