const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');
const registerPvp = require('../sockets/pvp.socket');

const once = (socket, event) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout ${event}`)), 5000);
  socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
});
const ack = (socket, event, payload) => new Promise((resolve) =>
  socket.emit(event, payload, resolve));
const emptyModel = { find: () => ({ lean: async () => [] }) };
const waitUntil = async (predicate, timeoutMs = 5000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

async function scenario(users, ufos) {
  const life = new Map();
  const configuredUfos = Array.from({ length: ufos }, (_, index) => ({
    _id: `stress-ufo-${index}`, nombre: `UFO ${index}`, vida: 1000,
    imagenOvni: '/ufo.webp', imagenBala: '/bullet.webp',
    velocidadBala: 10000, velocidadMovimiento: 0.5,
    tiempoAparicion: 0, duracionPantalla: 10,
    segundosEntreDisparos: 1, danoBala: 1, stepcoinsPremio: 0,
  }));
  const httpServer = http.createServer();
  const io = new Server(httpServer, { transports: ['websocket'] });
  registerPvp(io, {
    requireAuth: false,
    CardModel: { findById: () => ({ lean: async () => ({
      tipoArma: 'Proyectil', alcance: 350, dano: 1, tiempoEspera: 0,
    }) }) },
    LifeModel: {
      findOne: ({ userId }) => ({ lean: async () => ({
        vida: life.get(String(userId)) ?? 1000,
      }) }),
      updateOne: async ({ userId }, update) => {
        life.set(String(userId), update.$set.vida);
      },
    },
    TurretModel: emptyModel, MineModel: emptyModel,
    AirstrikeModel: emptyModel,
    UfoModel: { find: () => ({ lean: async () => configuredUfos }) },
    UserModel: {
      findOneAndUpdate: () => ({ lean: async () => null }),
      updateOne: async () => ({}),
    },
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}/pvp`;
  const sockets = [];
  const counts = { spawn: 0, update: 0, target: 0, shot: 0, impact: 0 };
  const shotDeliveries = new Map();
  const impactDeliveries = new Map();
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  const cpuStart = process.cpuUsage();
  const heapStart = process.memoryUsage().heapUsed;
  for (let index = 0; index < users; index++) {
    const socket = createClient(url, {
      transports: ['websocket'], forceNew: true, reconnection: false,
    });
    await once(socket, 'connect');
    for (const [event, key] of [
      ['ufo:spawn', 'spawn'], ['ufo:update', 'update'],
      ['ufo:target', 'target'],
    ]) socket.on(event, () => { counts[key] += 1; });
    socket.on('ufo:projectile:spawn', (payload) => {
      counts.shot += 1;
      shotDeliveries.set(payload.projectileId,
        (shotDeliveries.get(payload.projectileId) || 0) + 1);
    });
    socket.on('ufo:projectile:impact', (payload) => {
      counts.impact += 1;
      impactDeliveries.set(payload.projectileId,
        (impactDeliveries.get(payload.projectileId) || 0) + 1);
    });
    const response = await ack(socket, 'presence:hello', {
      userId: `stress-user-${index}`,
      lat: 41.65671 + index * 0.000001, lng: -0.8785, heading: 0,
    });
    assert.equal(new Set(response.ufos.map((ufo) => ufo.ufoId)).size,
      response.ufos.length);
    sockets.push(socket);
  }
  await ack(sockets[0], 'bullet:spawn', {
    clientShotId: `stress-trigger-${users}-${ufos}`,
    cardId: 'projectile',
    from: { lat: 41.65671, lng: -0.8785 },
    heading: 90, speed: 0, alcance: 350, dano: 1,
  });
  await waitUntil(() => counts.spawn === users * ufos);
  await waitUntil(() => counts.impact >= users * ufos, 6000);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const cpu = process.cpuUsage(cpuStart);
  const heapDelta = process.memoryUsage().heapUsed - heapStart;
  eventLoop.disable();
  assert.equal(sockets.filter((socket) => !socket.connected).length, 0);
  assert.ok([...shotDeliveries.values()].every((count) => count === users));
  assert.ok([...impactDeliveries.values()].every((count) => count === users));
  assert.deepEqual(
    [...shotDeliveries.keys()].sort(),
    [...impactDeliveries.keys()].sort(),
  );
  const metrics = {
    users, ufos,
    logicalProjectiles: shotDeliveries.size,
    socketEvents: Object.values(counts).reduce((sum, value) => sum + value, 0),
    counts,
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    heapDeltaMb: Number((heapDelta / 1024 / 1024).toFixed(2)),
    eventLoopMeanMs: Number((eventLoop.mean / 1e6).toFixed(2)),
    eventLoopMaxMs: Number((eventLoop.max / 1e6).toFixed(2)),
    disconnected: 0,
    duplicateLogicalImpacts: 0,
  };
  sockets.forEach((socket) => socket.disconnect());
  await new Promise((resolve) => io.close(resolve));
  if (httpServer.listening) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  return metrics;
}

test('UFO authority load 2/1, 10/10, 25/25 and 50/50', { timeout: 60000 }, async () => {
  const originalLog = console.log;
  console.log = () => {};
  try {
    for (const [users, ufos] of [[2, 1], [10, 10], [25, 25], [50, 50]]) {
      const metrics = await scenario(users, ufos);
      originalLog(`UFO_STRESS_METRICS ${JSON.stringify(metrics)}`);
    }
  } finally {
    console.log = originalLog;
  }
});
