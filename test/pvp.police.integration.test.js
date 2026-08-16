const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');
const registerPvp = require('../sockets/pvp.socket');

const once = (socket, event, timeoutMs = 5000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout ${event}`)), timeoutMs);
  socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
});
const ack = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));
const emptyModel = { find: () => ({ lean: async () => [] }) };

const policeConfig = {
  enabled: true, reuseRadiusMeters: 2000, maxActiveIncidents: 5,
  maxUnitsPerIncident: 10, maxNearbyUnits: 20, updateIntervalMs: 100,
  routeRecalculationDistanceMeters: 100, targetLockSeconds: 2, spawnDistanceMeters: 100,
  units: {
    foot: { label: 'Police', movementType: 'road', routeMode: 'walking', life: 100,
      speedMetersPerSecond: 2, damage: 10, rangeMeters: 300, fireIntervalSeconds: 5,
      cooldownSeconds: 5, projectileSpeedMetersPerSecond: 100, hitRadiusMeters: 20 },
    car: { movementType: 'road', routeMode: 'driving', life: 100 },
    helicopter: { movementType: 'air', life: 100 },
  },
  stars: Array.from({ length: 5 }, (_, index) => ({ level: index + 1,
    footOfficers: 1, cars: 0, helicopters: 0, spawnDelaySeconds: 0,
    escapeDistanceMeters: 5000, escapeHoldSeconds: 30,
    completionCondition: 'all_units_destroyed', autoEscalate: index < 4 })),
};

async function start() {
  const httpServer = http.createServer();
  const io = new Server(httpServer, { transports: ['websocket'] });
  const users = new Map();
  registerPvp(io, {
    requireAuth: false,
    CardModel: { findById: () => ({ lean: async () => ({ _id: 'card', tipoArma: 'Proyectil',
      alcance: 350, dano: 200, tiempoEspera: 0 }) }) },
    LifeModel: { findOne: ({ userId }) => ({ lean: async () => ({ vida: users.get(userId) ?? 1000 }) }),
      updateOne: async ({ userId }, update) => users.set(userId, update.$set.vida) },
    TurretModel: emptyModel, MineModel: emptyModel, AirstrikeModel: emptyModel, UfoModel: emptyModel,
    PoliceConfigModel: { defaults: () => policeConfig,
      findOne: () => ({ lean: async () => policeConfig }) },
    PoliceRouteProvider: { getRoute: async (from, to) => [from, to], clear() {} },
    UserModel: {
      findById: (id) => { const query = { select: () => query,
        lean: async () => ({ _id: id, gameModeEnabled: true }) }; return query; },
      findOne: () => ({ lean: async () => ({ _id: 'owner' }) }),
      findOneAndUpdate: () => ({ lean: async () => null }), updateOne: async () => ({}),
    },
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  return { io, httpServer, url: `http://127.0.0.1:${httpServer.address().port}`,
    close: async () => { await new Promise((resolve) => io.close(resolve));
      if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve)); } };
}
async function connect(url) {
  const socket = createClient(`${url}/pvp`, { transports: ['websocket'], forceNew: true, reconnection: false });
  await once(socket, 'connect'); return socket;
}
const hello = (socket, userId, position) => ack(socket, 'presence:hello', { userId, ...position, heading: 0 });
const shoot = (socket, position, id, speed = 0, heading = 0) => ack(socket, 'bullet:spawn', {
  clientShotId: id, cardId: 'card', from: position, heading, speed, alcance: 350, dano: 200,
});

test('ambient police is shared, remains neutral until attacked and then becomes authoritative pursuit', async (t) => {
  const server = await start(); t.after(() => server.close());
  const origin = { lat: 41.6567, lng: -0.8785 };
  const a = await connect(server.url); const b = await connect(server.url);
  const first = await hello(a, 'a', origin);
  const second = await hello(b, 'b', { lat: 41.657, lng: -0.8785 });
  assert.equal(first.policeUnits.length, 1);
  assert.equal(first.policeWanted.length, 0);
  assert.equal(first.policeUnits[0].state, 'idle');
  assert.equal(second.policeUnits[0].unitId, first.policeUnits[0].unitId);

  await shoot(a, origin, 'shot-in-the-air');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const neutralSnapshot = await hello(a, 'a', origin);
  assert.equal(neutralSnapshot.policeWanted.length, 0);
  const latest = neutralSnapshot.policeUnits[0];

  const destroyed = once(a, 'police:unit:destroy');
  await hello(b, 'b', { lat: latest.lat, lng: latest.lng });
  await shoot(b, { lat: latest.lat, lng: latest.lng }, 'attack-police', 180, 0);
  const death = await destroyed;
  assert.equal(death.unitId, latest.unitId);
  assert.equal(death.life, 0);
  assert.equal(death.attackerUserId, 'b');

  await new Promise((resolve) => setTimeout(resolve, 200));
  const snapshot = await hello(b, 'b', { lat: latest.lat, lng: latest.lng });
  assert.equal(snapshot.policeIncidents.length, 1);
  assert.equal(snapshot.policeWanted.length, 1);
  assert.equal(snapshot.policeWanted[0].userId, 'b');
  assert.equal(snapshot.policeWanted[0].stars, 2);
  assert.equal(snapshot.policeUnits.length, 1);
  a.disconnect(); b.disconnect();
});
