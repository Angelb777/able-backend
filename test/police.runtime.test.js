const test = require('node:test');
const assert = require('node:assert/strict');
const geo = require('../utils/geo');
const { createPoliceRuntime } = require('../api/services/policeRuntime');
const { createPoliceDirections, decodePolyline } = require('../api/services/policeDirections');

const baseConfig = () => ({
  enabled: true, reuseRadiusMeters: 2000, maxActiveIncidents: 10,
  maxUnitsPerIncident: 30, maxNearbyUnits: 60, updateIntervalMs: 100,
  routeRecalculationDistanceMeters: 100, targetLockSeconds: 4,
  spawnDistanceMeters: 100, patrolPairSpacingMeters: 3,
  helicopterOrbitRadiusMeters: 80, helicopterOrbitDegreesPerSecond: 12,
  units: {
    foot: { movementType: 'road', routeMode: 'walking', life: 100,
      speedMetersPerSecond: 5, damage: 20, rangeMeters: 500,
      fireIntervalSeconds: 1, cooldownSeconds: 1,
      projectileSpeedMetersPerSecond: 1000, hitRadiusMeters: 10 },
    car: { movementType: 'road', routeMode: 'driving', life: 150,
      speedMetersPerSecond: 15, damage: 30, rangeMeters: 500,
      fireIntervalSeconds: 1, cooldownSeconds: 1,
      projectileSpeedMetersPerSecond: 1000, hitRadiusMeters: 14 },
    helicopter: { movementType: 'air', routeMode: 'driving', life: 200,
      speedMetersPerSecond: 20, damage: 40, rangeMeters: 500,
      fireIntervalSeconds: 1, cooldownSeconds: 1,
      projectileSpeedMetersPerSecond: 1000, hitRadiusMeters: 18 },
  },
  stars: Array.from({ length: 5 }, (_, index) => ({
    level: index + 1, footOfficers: 1, cars: 0, helicopters: 0,
    spawnDelaySeconds: index === 0 ? 1 : 0,
    escapeDistanceMeters: 1000, escapeHoldSeconds: 1,
    completionCondition: 'all_units_destroyed', autoEscalate: index < 4,
  })),
});

function fixture(customize = () => {}) {
  let clock = 10000; const config = baseConfig(); customize(config);
  const events = []; const players = new Map(); const routeCalls = [];
  const nsp = { to: (zoneId) => ({ emit: (event, payload) => events.push({ zoneId, event, payload }) }) };
  const runtime = createPoliceRuntime({ nsp, geo,
    PoliceConfigModel: { defaults: baseConfig, findOne: () => ({ lean: async () => config }) },
    applyPlayerDamage: async ({ target, damage }) => {
      target.vida = Math.max(0, target.vida - damage);
      return { vida: target.vida, killed: target.vida === 0 };
    },
    playersForUser: (id) => players.has(String(id)) ? [players.get(String(id))] : [],
    primaryAlivePlayersInZone: () => [...players.values()],
    routeProvider: { getRoute: async (from, to, mode) => {
      routeCalls.push({ from, to, mode });
      return [from, { lat: (from.lat + to.lat) / 2, lng: (from.lng + to.lng) / 2 }, to];
    }, clear() {} },
    now: () => clock, random: () => 0.5,
  });
  const addPlayer = (userId, position) => {
    const player = { userId, zoneId: 'GLOBAL_TEST_ROOM', vida: 1000,
      gameModeEnabled: true, ...position };
    players.set(userId, player); return player;
  };
  return { runtime, config, events, players, routeCalls, addPlayer,
    setClock: (value) => { clock = value; }, advance: (value) => { clock += value; },
    tick: (elapsed = 0.1) => runtime._debug.logicTick(clock, elapsed),
    projectiles: () => runtime._debug.projectiles,
  };
}

test('ambient patrol is shared and shooting alone never starts a pursuit', async (t) => {
  const fx = fixture(); t.after(() => fx.runtime.shutdown());
  const origin = { lat: 41.6567, lng: -0.8785 };
  const a = fx.addPlayer('a', origin);
  const b = fx.addPlayer('b', geo.computeOffset(origin, 500, 90));
  await fx.runtime.ensureAmbientPatrol(a, origin);
  await fx.runtime.ensureAmbientPatrol(b, b);
  assert.equal(fx.runtime._debug.incidents.size, 1);
  const incident = [...fx.runtime._debug.incidents.values()][0];
  assert.equal(incident.state, 'ambient');
  assert.equal(incident.units.size, 1);
  assert.equal([...incident.units.values()][0].state, 'idle');
  assert.equal(fx.runtime._debug.wantedUsers.size, 0);
  await fx.runtime.onPlayerShot(a, origin);
  await fx.runtime.onPlayerShot(b, b);
  fx.tick();
  assert.equal(fx.runtime._debug.wantedUsers.size, 0);
  assert.equal(fx.runtime.hasActivePursuitInZone(a.zoneId), false);
  const unit = [...incident.units.values()][0];
  fx.runtime.applyBulletDamage(unit.unitId, 1, 'a', 'attack-a');
  assert.equal(fx.runtime._debug.wantedUsers.get('a').stars, 1);
  assert.equal(fx.runtime.hasActivePursuitInZone(a.zoneId), true);
  assert.equal(incident.state, 'active');
  fx.runtime.applyBulletDamage(unit.unitId, 1, 'b', 'attack-b');
  assert.equal([...fx.runtime._debug.incidents.values()][0].wanted.size, 2);
});

test('ambient police is never created outside game mode', async (t) => {
  const fx = fixture(); t.after(() => fx.runtime.shutdown());
  const player = fx.addPlayer('disabled', { lat: 41.6567, lng: -0.8785 });
  player.gameModeEnabled = false;

  const incident = await fx.runtime.ensureAmbientPatrol(player, player);

  assert.equal(incident, null);
  assert.equal(fx.runtime._debug.incidents.size, 0);
  assert.equal(fx.runtime.getSnapshot(player.zoneId).policeUnits.length, 0);
});

test('the initial foot patrol walks as a pair and both pursue its attacker', async (t) => {
  const fx = fixture((config) => {
    config.stars[0].footOfficers = 2;
    config.patrolPairSpacingMeters = 4;
  });
  t.after(() => fx.runtime.shutdown());
  const origin = { lat: 41.6567, lng: -0.8785 };
  const player = fx.addPlayer('a', origin);
  await fx.runtime.ensureAmbientPatrol(player, origin);
  const incident = [...fx.runtime._debug.incidents.values()][0];
  const units = [...incident.units.values()];
  assert.equal(units.length, 2);
  assert.ok(geo.distanceMeters(units[0], units[1]) <= 4.1);

  fx.tick(1);
  await Promise.resolve(); await Promise.resolve();
  fx.advance(100); fx.tick(1);
  assert.equal(fx.routeCalls.filter((call) => call.mode === 'walking').length, 1,
    'only the leader requests the ambient walking route');
  assert.ok(geo.distanceMeters(units[0], units[1]) <= 8,
    'the partner stays alongside the leader');

  const before = units.map((unit) => geo.distanceMeters(unit, player));
  fx.runtime.applyBulletDamage(units[0].unitId, 1, 'a', 'attack-pair');
  fx.advance(100); fx.tick(1);
  await Promise.resolve(); await Promise.resolve();
  fx.advance(100); fx.tick(1);
  assert.deepEqual(units.map((unit) => unit.targetUserId), ['a', 'a']);
  assert.ok(units.every((unit, index) => geo.distanceMeters(unit, player) < before[index]),
    'both officers advance toward the attacker');
});

test('destroying each wave escalates progressively and never exceeds five stars', async (t) => {
  const fx = fixture((config) => config.stars.forEach((star) => { star.spawnDelaySeconds = 0; }));
  t.after(() => fx.runtime.shutdown());
  const origin = { lat: 41.6567, lng: -0.8785 };
  const player = fx.addPlayer('a', origin);
  await fx.runtime.ensureAmbientPatrol(player, origin); fx.tick();
  for (let expected = 2; expected <= 5; expected += 1) {
    const incident = [...fx.runtime._debug.incidents.values()][0];
    const unit = [...incident.units.values()][0];
    assert.ok(unit, `wave ${expected - 1} spawned`);
    fx.runtime.applyBulletDamage(unit.unitId, 999, 'a', `kill-${expected}`);
    assert.equal(fx.runtime._debug.wantedUsers.get('a').stars, expected);
    fx.tick();
  }
  const incident = [...fx.runtime._debug.incidents.values()][0];
  const lastUnit = [...incident.units.values()][0];
  fx.runtime.applyBulletDamage(lastUnit.unitId, 999, 'a', 'kill-five');
  assert.equal(fx.runtime._debug.wantedUsers.get('a').stars, 5);
  assert.equal(incident.pendingWaveAt, null);
});

test('targeting prioritizes stars, locks target and respects range/cooldown', async (t) => {
  const fx = fixture((config) => {
    config.stars[0].spawnDelaySeconds = 0;
    Object.assign(config.units.foot, {
      projectileSpriteUrl: '/police-shot.png',
      projectileRenderType: 'flame_spritesheet',
      projectileSpritesheet: { url: '/police-shot.png', rows: 1, columns: 4, frames: 4 },
      impactSpriteUrl: '/police-impact.png',
      impactRenderType: 'flame_spritesheet',
      impactSpritesheet: { url: '/police-impact.png', rows: 2, columns: 3, frames: 6, loop: false },
    });
  });
  t.after(() => fx.runtime.shutdown());
  const origin = { lat: 41.6567, lng: -0.8785 };
  const a = fx.addPlayer('a', origin);
  const b = fx.addPlayer('b', geo.computeOffset(origin, 20, 90));
  await fx.runtime.ensureAmbientPatrol(a, origin); fx.tick();
  const unit = [...fx.runtime._debug.incidents.values()][0].units.values().next().value;
  fx.runtime.applyBulletDamage(unit.unitId, 1, 'a', 'attack-a');
  fx.runtime.applyBulletDamage(unit.unitId, 1, 'b', 'attack-b');
  fx.tick();
  fx.runtime._debug.wantedUsers.get('b').stars = 4;
  fx.projectiles().clear();
  fx.advance(4100); fx.tick();
  assert.equal(unit.targetUserId, 'b');
  assert.equal(fx.projectiles().size, 1);
  const projectile = [...fx.projectiles().values()][0];
  assert.equal(projectile.projectileSpritesheet.columns, 4);
  assert.equal(projectile.impactSpritesheet.frames, 6);
  a.lat = unit.lat; a.lng = unit.lng;
  fx.advance(500); fx.tick();
  assert.equal(unit.targetUserId, 'b', 'hysteresis keeps the selected target');
  assert.equal(fx.projectiles().size, 1, 'cooldown prevents another shot');
  fx.advance(600); fx.tick();
  assert.equal(fx.projectiles().size, 2);
});

test('escape blinks one star and removes stars one at a time; death clears everything', async (t) => {
  const fx = fixture((config) => config.stars[0].spawnDelaySeconds = 0);
  t.after(() => fx.runtime.shutdown());
  const origin = { lat: 41.6567, lng: -0.8785 };
  const player = fx.addPlayer('a', origin);
  await fx.runtime.ensureAmbientPatrol(player, origin);
  const incident = [...fx.runtime._debug.incidents.values()][0];
  const unit = [...incident.units.values()][0];
  fx.runtime.applyBulletDamage(unit.unitId, 1, 'a', 'attack-a');
  fx.tick();
  const wanted = fx.runtime._debug.wantedUsers.get('a'); wanted.stars = 2;
  const far = geo.computeOffset(origin, 2500, 0); player.lat = far.lat; player.lng = far.lng;
  fx.advance(100); fx.tick();
  assert.ok(wanted.escapeStartedAt); assert.equal(wanted.stars, 2);
  fx.advance(1000); fx.tick();
  assert.equal(wanted.stars, 1); assert.equal(wanted.escapeStartedAt, null);
  fx.advance(100); fx.tick(); fx.advance(1000); fx.tick();
  assert.equal(fx.runtime._debug.wantedUsers.has('a'), false);
  await fx.runtime.ensureAmbientPatrol(player, player);
  const neutral = [...fx.runtime._debug.incidents.values()][0].units.values().next().value;
  fx.runtime.applyBulletDamage(neutral.unitId, 1, 'a', 'attack-again');
  assert.equal(fx.runtime.handlePlayerDeath('a'), true);
  assert.equal(fx.runtime._debug.wantedUsers.size, 0);
  assert.equal([...fx.runtime._debug.incidents.values()][0].state, 'ambient');
  assert.equal(fx.runtime._debug.projectiles.size, 0);
});

test('road follows a cached route while air orbits and snapshots are shared', async (t) => {
  const fx = fixture((config) => {
    config.stars[1].spawnDelaySeconds = 0;
    config.stars[1].footOfficers = 1;
    config.stars[1].helicopters = 1;
  });
  t.after(() => fx.runtime.shutdown());
  const origin = { lat: 41.6567, lng: -0.8785 };
  const player = fx.addPlayer('a', origin);
  await fx.runtime.ensureAmbientPatrol(player, origin);
  const ambient = [...fx.runtime._debug.incidents.values()][0].units.values().next().value;
  fx.runtime.applyBulletDamage(ambient.unitId, 999, 'a', 'kill-ambient');
  fx.tick();
  const incident = [...fx.runtime._debug.incidents.values()][0];
  const foot = [...incident.units.values()].find((unit) => unit.unitType === 'foot');
  const helicopter = [...incident.units.values()].find((unit) => unit.unitType === 'helicopter');
  const footStart = { lat: foot.lat, lng: foot.lng };
  const airStart = { lat: helicopter.lat, lng: helicopter.lng };
  fx.advance(100); fx.tick(1); await Promise.resolve(); await Promise.resolve();
  fx.advance(100); fx.tick(1);
  assert.ok(geo.distanceMeters(footStart, foot) > 0);
  assert.ok(geo.distanceMeters(airStart, helicopter) > 0);
  assert.ok(geo.distanceMeters(helicopter, player) > 1,
    'the helicopter never targets the exact player coordinate');
  assert.equal(fx.routeCalls.filter((call) => call.mode === 'walking').length, 1);
  const snapshot = fx.runtime.getSnapshot('GLOBAL_TEST_ROOM');
  assert.equal(snapshot.policeIncidents.length, 1);
  assert.equal(snapshot.policeUnits.length, 2);
  assert.equal(snapshot.policeWanted[0].userId, 'a');
});

test('temporary disconnect preserves wanted stars for the reconnect snapshot', async (t) => {
  const fx = fixture(); t.after(() => fx.runtime.shutdown());
  const origin = { lat: 41.6567, lng: -0.8785 };
  const player = fx.addPlayer('a', origin);
  await fx.runtime.ensureAmbientPatrol(player, origin);
  const unit = [...fx.runtime._debug.incidents.values()][0].units.values().next().value;
  fx.runtime.applyBulletDamage(unit.unitId, 1, 'a', 'attack-before-background');
  fx.runtime._debug.wantedUsers.get('a').stars = 3;

  fx.players.delete('a');
  assert.equal(fx.runtime.handleDisconnect('a'), false);
  const snapshot = fx.runtime.getSnapshot('GLOBAL_TEST_ROOM');
  assert.equal(snapshot.policeWanted[0].stars, 3);
  assert.equal(snapshot.policeUnits.length, 1);
});

test('attacking police after player death starts a fresh visible one-star pursuit', async (t) => {
  const fx = fixture(); t.after(() => fx.runtime.shutdown());
  const origin = { lat: 41.6567, lng: -0.8785 };
  const player = fx.addPlayer('a', origin);
  await fx.runtime.ensureAmbientPatrol(player, origin);
  let unit = [...fx.runtime._debug.incidents.values()][0].units.values().next().value;
  fx.runtime.applyBulletDamage(unit.unitId, 1, 'a', 'first-attack');
  const firstSeq = fx.runtime._debug.wantedUsers.get('a').seq;

  assert.equal(fx.runtime.handlePlayerDeath('a'), true);
  const zeroEvent = fx.events.filter((event) => event.event === 'police:wanted:update').at(-1).payload;
  assert.equal(zeroEvent.stars, 0);
  assert.ok(zeroEvent.seq > firstSeq);

  unit = [...fx.runtime._debug.incidents.values()][0].units.values().next().value;
  fx.runtime.applyBulletDamage(unit.unitId, 1, 'a', 'second-attack');
  const restarted = fx.runtime._debug.wantedUsers.get('a');
  assert.equal(restarted.stars, 1);
  assert.ok(restarted.seq > zeroEvent.seq,
    'the new pursuit cannot be rejected as an old HUD event');
});

test('ending the last pursuit restores only the initial ambient foot patrol', async (t) => {
  const fx = fixture((config) => {
    config.stars[0].footOfficers = 2;
    config.stars[1].footOfficers = 0;
    config.stars[1].cars = 1;
    config.stars[1].helicopters = 1;
    config.stars[1].spawnDelaySeconds = 0;
  });
  t.after(() => fx.runtime.shutdown());
  const origin = { lat: 41.6567, lng: -0.8785 };
  const player = fx.addPlayer('a', origin);
  await fx.runtime.ensureAmbientPatrol(player, origin);
  const incident = [...fx.runtime._debug.incidents.values()][0];
  for (const unit of [...incident.units.values()]) {
    fx.runtime.applyBulletDamage(unit.unitId, 999, 'a', `kill-${unit.unitId}`);
  }
  fx.tick();
  assert.deepEqual(
    [...incident.units.values()].map((unit) => unit.unitType).sort(),
    ['car', 'helicopter'],
  );

  assert.equal(fx.runtime.handlePlayerDeath('a'), true);
  assert.equal(incident.state, 'ambient');
  assert.equal(incident.waveLevel, 1);
  assert.equal(incident.wanted.size, 0);
  assert.deepEqual(
    [...incident.units.values()].map((unit) => unit.unitType),
    ['foot', 'foot'],
  );
});

test('Directions polyline decoding and cache avoid duplicate Google calls', async () => {
  assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [
    { lat: 38.5, lng: -120.2 }, { lat: 40.7, lng: -120.95 }, { lat: 43.252, lng: -126.453 },
  ]);
  let calls = 0;
  const provider = createPoliceDirections({ apiKey: 'test', fetchImpl: async () => {
    calls += 1; return { ok: true, json: async () => ({ routes: [{ overview_polyline: {
      points: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' } }] }) };
  } });
  const from = { lat: 38.5, lng: -120.2 }; const to = { lat: 43.252, lng: -126.453 };
  await provider.getRoute(from, to, 'driving'); await provider.getRoute(from, to, 'driving');
  assert.equal(calls, 1); provider.clear();
});
