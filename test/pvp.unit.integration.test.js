const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');
const registerPvp = require('../sockets/pvp.socket');

const once = (socket, event, timeoutMs = 3000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout ${event}`)), timeoutMs);
  socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
});
const until = (socket, event, predicate, timeoutMs = 3000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`timeout ${event}`));
    }, timeoutMs);
    const listener = (data) => {
      if (!predicate(data)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(data);
    };
    socket.on(event, listener);
  });
const ack = (socket, event, payload) =>
  new Promise((resolve) => socket.emit(event, payload, resolve));

const troopCard = {
  _id: 'troop', tipoArma: 'TROPA', numeroUnidades: 2,
  separacionUnidades: 3, distanciaMaximaColocacion: 500,
  rangoDeteccion: 100, rangoAtaque: 2, distanciaMaximaPersecucion: 150,
  vida: 100, velocidadMovimiento: 2, dano: 10, cooldownAtaque: 1,
  duracion: 60, tiempoEspera: 0,
  unitIdleSpritesheet: { url: '/idle.png' },
  unitWalkSpritesheet: { url: '/walk.png' },
  unitAttackSpritesheet: { url: '/attack.png' },
};
const mineCard = {
  _id: 'mine', tipoArma: 'Trampa', radioActivacion: 12,
  dano: 40, duracion: 60, tiempoEspera: 0, usoUnico: true,
};

async function start() {
  const httpServer = http.createServer();
  const io = new Server(httpServer, { transports: ['websocket'] });
  const cards = { troop: troopCard, mine: mineCard };
  let mineSerial = 0;
  const emptyModel = { find: () => ({ lean: async () => [] }) };
  const entityModel = {
    find: () => ({ lean: async () => [] }),
    create: async (data) => {
      const plain = { _id: `mine-${++mineSerial}`, ...data };
      return { ...plain, toObject: () => ({ ...plain }) };
    },
    updateOne: async () => ({}), deleteOne: async () => ({}),
  };
  registerPvp(io, {
    requireAuth: false,
    presenceDisconnectGraceMs: 20,
    CardModel: { findById: (id) => ({ lean: async () => cards[String(id)] || null }) },
    LifeModel: {
      findOne: () => ({ lean: async () => ({ vida: 1000 }) }),
      updateOne: async () => ({}),
    },
    TurretModel: entityModel,
    MineModel: entityModel,
    AirstrikeModel: entityModel,
    UfoModel: emptyModel,
    PoliceConfigModel: {
      defaults: () => ({ enabled: false, stars: [], units: {} }),
      findOne: () => ({ lean: async () => ({ enabled: false, stars: [], units: {} }) }),
    },
    UnitRouteProvider: { getRoute: async (from, to) => [from, to], clear() {} },
    UserModel: {
      findById: (id) => {
        const query = {
          select: () => query,
          populate: () => query,
          lean: async () => ({ _id: id, gameModeEnabled: true }),
        };
        return query;
      },
      findOne: (filter) => ({
        lean: async () => ({ _id: String(filter._id), cardUpgrades: [] }),
      }),
      findOneAndUpdate: () => ({ lean: async () => null }),
      updateOne: async () => ({}),
    },
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  return {
    io, httpServer, url: `http://127.0.0.1:${httpServer.address().port}`,
    close: async () => {
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
const hello = (socket, userId, lat, lng) =>
  ack(socket, 'presence:hello', { userId, lat, lng, heading: 0 });

test('TROPA placement is authoritative, synchronized and removed with its owner', async (t) => {
  const server = await start();
  t.after(() => server.close());
  const owner = await connect(server.url);
  const observer = await connect(server.url);
  t.after(() => { owner.disconnect(); observer.disconnect(); });
  const lat = 41.6567; const lng = -0.8785;
  await hello(owner, 'owner', lat, lng);
  await hello(observer, 'observer', lat + 0.0005, lng);

  const invalid = await ack(owner, 'unit:place', {
    cardId: 'troop', lat: lat + 0.01, lng,
  });
  assert.equal(invalid.ok, false);

  const placed = await ack(owner, 'unit:place', { cardId: 'troop', lat, lng });
  assert.equal(placed.ok, true);
  assert.equal(placed.units.length, 2);
  assert.ok(placed.units.every((unit) => unit.life === 100 && unit.state === 'idle'));

  const snapshot = await hello(observer, 'observer', lat + 0.0005, lng);
  assert.equal(snapshot.units.length, 2);

  const removed = until(observer, 'unit:destroy',
    (event) => event.ownerUserId === 'owner' && event.reason === 'owner-left');
  owner.disconnect();
  assert.equal((await removed).reason, 'owner-left');
});

test('an enemy mine detonates on a unit without becoming a unit target', async (t) => {
  const server = await start();
  t.after(() => server.close());
  const miner = await connect(server.url);
  const troopOwner = await connect(server.url);
  t.after(() => { miner.disconnect(); troopOwner.disconnect(); });
  const lat = 41.6567; const lng = -0.8785;
  await hello(miner, 'miner', lat + 0.0003, lng);
  await hello(troopOwner, 'troop-owner', lat + 0.0008, lng);

  const mine = await ack(miner, 'mine:place', { cardId: 'mine', lat, lng });
  assert.equal(mine.ok, true);
  const trigger = until(miner, 'mine:trigger', (event) => Boolean(event.targetUnitId));
  const placed = await ack(troopOwner, 'unit:place', { cardId: 'troop', lat, lng });
  assert.equal(placed.ok, true);

  const event = await trigger;
  assert.ok(placed.units.some((unit) => unit.unitId === event.targetUnitId));
  assert.equal(event.unitLife, 60);
  assert.equal(event.targetUserId, null);
});
