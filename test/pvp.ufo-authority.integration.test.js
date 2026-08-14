const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');
const registerPvp = require('../sockets/pvp.socket');
const ufoRouter = require('../api/routes/ufo');
const User = require('../api/models/User');
const geo = require('../utils/geo');

const once = (socket, event, timeoutMs = 5000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout ${event}`)), timeoutMs);
  socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
});
const matching = (socket, event, predicate, timeoutMs = 5000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout matching ${event}`));
    }, timeoutMs);
    const handler = (data) => {
      if (!predicate(data)) return;
      clearTimeout(timer); socket.off(event, handler); resolve(data);
    };
    socket.on(event, handler);
  });
const ack = (socket, event, payload) => new Promise((resolve) =>
  socket.emit(event, payload, resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emptyModel = { find: () => ({ lean: async () => [] }) };

function fixtures({ ufoLife = 200, ufoDamage = 80 } = {}) {
  const life = new Map();
  let lifeWrites = 0;
  let turretSeq = 0;
  return {
    life,
    get lifeWrites() { return lifeWrites; },
    dependencies: {
      requireAuth: false,
      CardModel: {
        findById: (id) => ({ lean: async () => id === 'turret-card'
          ? {
              _id: id, tipoArma: 'Arrastre', alcance: 500, dano: 25,
              vida: 100, cadenciaDisparo: 1, duracion: 20,
            }
          : {
              _id: id, tipoArma: 'Proyectil', alcance: 350, dano: 250,
              tiempoEspera: 0,
            } }),
      },
      LifeModel: {
        findOne: ({ userId }) => ({
          lean: async () => ({ vida: life.get(String(userId)) ?? 1000 }),
        }),
        updateOne: async ({ userId }, update) => {
          lifeWrites += 1;
          life.set(String(userId), update.$set.vida);
        },
      },
      TurretModel: {
        find: () => ({ lean: async () => [] }),
        create: async (data) => {
          const stored = { _id: `turret-${++turretSeq}`, ...data };
          return { ...stored, toObject: () => ({ ...stored }) };
        },
        updateOne: async () => ({}), deleteOne: async () => ({}),
      },
      MineModel: emptyModel,
      AirstrikeModel: emptyModel,
      UfoModel: {
        find: () => ({ lean: async () => [{
          _id: 'shared-ufo', nombre: 'Shared UFO', vida: ufoLife,
          imagenOvni: '/ufo.webp', imagenBala: '/ufo-bullet.webp',
          velocidadBala: 1000, velocidadMovimiento: 0.5,
          tiempoAparicion: 0, duracionPantalla: 30,
          segundosEntreDisparos: 1, danoBala: ufoDamage,
          stepcoinsPremio: 10,
        }] }),
      },
      UserModel: {
        findById: (id) => {
          const query = {
            select: () => query,
            lean: async () => ({ _id: id, gameModeEnabled: true }),
          };
          return query;
        },
        findOne: () => ({ lean: async () => ({ _id: 'owner' }) }),
        findOneAndUpdate: () => ({ lean: async () => null }),
        updateOne: async () => ({}),
      },
    },
  };
}

async function start(dependencies) {
  const httpServer = http.createServer();
  const io = new Server(httpServer, { transports: ['websocket'] });
  registerPvp(io, dependencies);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  return {
    io, httpServer, url: `http://127.0.0.1:${httpServer.address().port}`,
    async close() {
      await new Promise((resolve) => io.close(resolve));
      if (httpServer.listening) {
        await new Promise((resolve) => httpServer.close(resolve));
      }
    },
  };
}
async function connect(url) {
  const socket = createClient(`${url}/pvp`, {
    transports: ['websocket'], forceNew: true, reconnection: false,
  });
  await once(socket, 'connect');
  return socket;
}
const hello = (socket, userId, position) => ack(socket, 'presence:hello', {
  userId, ...position, heading: 0,
});
const triggerUfo = (socket, position, id = 'trigger') => ack(socket, 'bullet:spawn', {
  clientShotId: id, cardId: 'projectile-card', from: position,
  heading: 90, speed: 0, alcance: 350, dano: 250,
});

test('UFO target, projectile, impact, snapshot and death are server authoritative', async (t) => {
  const fx = fixtures();
  const server = await start(fx.dependencies);
  t.after(() => server.close());
  const origin = { lat: 41.65671, lng: -0.8785 };
  const a = await connect(server.url);
  const b = await connect(server.url);
  await hello(a, 'a', origin);
  await hello(b, 'b', geo.computeOffset(origin, 20, 180));

  const spawnA = once(a, 'ufo:spawn');
  const spawnB = once(b, 'ufo:spawn');
  await triggerUfo(a, origin);
  const [ufoA, ufoB] = await Promise.all([spawnA, spawnB]);
  assert.deepEqual(ufoA, ufoB);
  assert.equal(ufoA.ufoId, ufoB.ufoId);
  assert.equal(ufoA.lat, ufoB.lat);
  assert.equal(ufoA.lng, ufoB.lng);

  const hurtA = await ack(a, 'ufo:hurt', { ufoId: ufoA.ufoId, damage: 9999 });
  const hurtB = await ack(b, 'ufo:impact', { ufoId: ufoA.ufoId, damage: 9999 });
  assert.equal(hurtA.ok, false);
  assert.equal(hurtB.ok, false);

  const targetA = once(a, 'ufo:target');
  const targetB = once(b, 'ufo:target');
  const shotA = once(a, 'ufo:projectile:spawn');
  const shotB = once(b, 'ufo:projectile:spawn');
  const [selectedA, selectedB, projectileA, projectileB] = await Promise.all([
    targetA, targetB, shotA, shotB,
  ]);
  assert.deepEqual(selectedA, selectedB);
  assert.equal(selectedA.targetUserId, selectedB.targetUserId);
  assert.deepEqual(projectileA, projectileB);
  assert.equal(projectileA.projectileId, projectileB.projectileId);
  assert.equal(projectileA.targetUserId, selectedA.targetUserId);

  const impactA = once(a, 'ufo:projectile:impact');
  const impactB = once(b, 'ufo:projectile:impact');
  const [hitA, hitB] = await Promise.all([impactA, impactB]);
  assert.deepEqual(hitA, hitB);
  assert.equal(hitA.hit, true);
  assert.equal(fx.lifeWrites, 1);

  const beforeReconnectSeq = selectedA.seq;
  a.disconnect();
  await wait(1200);
  const reconnected = await connect(server.url);
  const snapshot = await hello(reconnected, 'a', origin);
  assert.equal(snapshot.ufos.length, 1);
  assert.equal(snapshot.ufos[0].ufoId, ufoA.ufoId);
  assert.ok(snapshot.ufos[0].seq > beforeReconnectSeq);
  assert.ok(snapshot.ufos[0].targetUserId);

  let destroyCount = 0;
  let shotsAfterDeath = 0;
  b.on('ufo:destroy', () => { destroyCount += 1; });
  // Use a freshly versioned server position and overlap the test player with it.
  // This tests the authoritative damage/death path without a random movement tick
  // turning the assertion into a near-miss.
  const latest = await matching(reconnected, 'ufo:update', (event) =>
    event.ufoId === ufoA.ufoId);
  const from = { lat: latest.lat, lng: latest.lng };
  reconnected.emit('presence:update', { ...from, heading: 0 });
  await wait(40);
  await ack(reconnected, 'bullet:spawn', {
    clientShotId: 'kill-ufo', cardId: 'projectile-card', from,
    heading: 0, speed: 180, alcance: 350, dano: 250,
  });
  await matching(b, 'ufo:destroy', (event) => event.ufoId === ufoA.ufoId);
  b.on('ufo:projectile:spawn', () => { shotsAfterDeath += 1; });
  await wait(1300);
  assert.equal(destroyCount, 1);
  assert.equal(shotsAfterDeath, 0);
  const afterDeath = await hello(reconnected, 'a', origin);
  assert.equal(afterDeath.ufos.length, 0);
  b.disconnect(); reconnected.disconnect();
});

test('one server turret hit damages an UFO once with two clients', async (t) => {
  const fx = fixtures({ ufoLife: 100 });
  fx.life.set('observer', 0);
  const server = await start(fx.dependencies);
  t.after(() => server.close());
  const origin = { lat: 41.65671, lng: -0.8785 };
  const owner = await connect(server.url);
  const observer = await connect(server.url);
  await hello(owner, 'owner', origin);
  await hello(observer, 'observer', origin);
  const spawned = once(owner, 'ufo:spawn');
  await triggerUfo(owner, origin, 'turret-ufo-trigger');
  const ufo = await spawned;
  const shotOwner = matching(owner, 'turret:shot', (event) =>
    event.targetUfoId === ufo.ufoId, 5000);
  const shotObserver = matching(observer, 'turret:shot', (event) =>
    event.targetUfoId === ufo.ufoId, 5000);
  const update = matching(owner, 'ufo:update', (event) => event.vida === 75, 5000);
  const placed = await ack(owner, 'turret:place', {
    cardId: 'turret-card', ...origin,
  });
  assert.equal(placed.ok, true);
  const [aShot, bShot, damaged] = await Promise.all([
    shotOwner, shotObserver, update,
  ]);
  assert.deepEqual(aShot, bShot);
  assert.equal(aShot.targetUfoId, ufo.ufoId);
  assert.equal(damaged.vida, 75);
  await wait(200);
  assert.equal(damaged.vida, 75);
  owner.disconnect(); observer.disconnect();
});

test('legacy UFO hurt endpoint rejects normal users before touching data', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'ufo-route-test-secret';
  t.after(() => { process.env.JWT_SECRET = previousSecret; });
  const originalFindById = User.findById;
  User.findById = () => ({
    select: () => ({
      lean: async () => ({
        _id: '507f191e810c19729de860ea',
        role: 'cliente',
        firebaseUid: null,
        email: 'legacy@example.test',
        nickname: 'Legacy',
      }),
    }),
  });
  t.after(() => { User.findById = originalFindById; });
  const app = express();
  app.use(express.json());
  app.use('/api/ufo', ufoRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const token = jwt.sign({ id: '507f191e810c19729de860ea', role: 'admin' }, process.env.JWT_SECRET);
  const url = `http://127.0.0.1:${server.address().port}/api/ufo/not-a-db-id/hurt`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ damage: 9999 }),
    });
    assert.equal(response.status, 403);
  }
});
