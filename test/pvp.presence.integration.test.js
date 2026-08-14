const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');
const registerPvp = require('../sockets/pvp.socket');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const once = (socket, event, timeoutMs = 1000) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`timeout ${event}`)), timeoutMs);
  socket.once(event, (data) => { clearTimeout(timeout); resolve(data); });
});
const ack = (socket, event, payload) => new Promise((resolve) => {
  socket.emit(event, payload, resolve);
});

const emptyModel = { find: () => ({ lean: async () => [] }) };
const lifeByUser = new Map();
const dependencies = (grace = 40) => ({
  requireAuth: false,
  presenceDisconnectGraceMs: grace,
  CardModel: {
    findById: () => ({ lean: async () => ({
      tipoArma: 'Proyectil', alcance: 100, dano: 100, tiempoEspera: 0,
    }) }),
  },
  LifeModel: {
    findOne: ({ userId }) => ({ lean: async () => ({ vida: lifeByUser.get(userId) ?? 1000 }) }),
    updateOne: async () => ({ acknowledged: true }),
  },
  TurretModel: emptyModel,
  MineModel: emptyModel,
  AirstrikeModel: emptyModel,
  UfoModel: emptyModel,
  UserModel: {
    findById: (id) => {
      const query = {
        select: () => query,
        populate: () => query,
        lean: async () => ({ _id: id, nickname: `user-${id}`, skinSeleccionada: null }),
      };
      return query;
    },
    findOneAndUpdate: () => ({ lean: async () => null }),
    updateOne: async () => ({}),
  },
});

async function startServer(grace = 40) {
  const httpServer = http.createServer();
  const io = new Server(httpServer);
  registerPvp(io, dependencies(grace));
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  return {
    io,
    httpServer,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => io.close(resolve));
      await new Promise((resolve) => httpServer.close(resolve));
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

const hello = (socket, userId, lat = 41.65) => ack(socket, 'presence:hello', {
  userId, lat, lng: -0.88, heading: 359,
});

test('snapshot, server sequence, clean leave and abrupt timeout are coherent', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const a = await connect(server.url);
  const aHello = await hello(a, 'a');
  assert.equal(aHello.players.length, 0);

  const spawnA = once(a, 'presence:spawn');
  const b = await connect(server.url);
  const bHello = await hello(b, 'b');
  assert.equal(bHello.players.length, 1);
  assert.equal(bHello.players[0].userId, 'a');
  assert.ok(Number.isSafeInteger(bHello.players[0].seq));
  assert.ok(Number.isSafeInteger(bHello.serverTimestamp));
  await spawnA;

  const moves = [];
  b.on('presence:move', (event) => moves.push(event));
  a.emit('presence:update', { clientSeq: 1, lat: 41.651, lng: -0.88, heading: 1 });
  a.emit('presence:update', { clientSeq: 3, lat: 41.653, lng: -0.88, heading: 3 });
  a.emit('presence:update', { clientSeq: 2, lat: 41.652, lng: -0.88, heading: 2 });
  await wait(50);
  assert.equal(moves.length, 2);
  assert.equal(moves.at(-1).lat, 41.653);
  assert.ok(moves[1].seq > moves[0].seq);

  const cleanLeave = once(b, 'presence:leave');
  a.disconnect();
  assert.equal((await cleanLeave).userId, 'a');

  const c = await connect(server.url);
  await hello(c, 'c');
  const timeoutLeave = once(b, 'presence:leave');
  c.io.engine.close();
  const timedOut = await timeoutLeave;
  assert.equal(timedOut.userId, 'c');
  assert.equal(timedOut.reason, 'disconnect-timeout');
  b.disconnect();
});

test('reconnect and two sockets preserve one logical presence', async (t) => {
  const server = await startServer(100);
  t.after(() => server.close());
  const observer = await connect(server.url);
  await hello(observer, 'observer');
  const first = await connect(server.url);
  await hello(first, 'same', 41.651);

  const replacement = await connect(server.url);
  const replacementHello = await hello(replacement, 'same', 41.659);
  assert.deepEqual(replacementHello.players.map((p) => p.userId), ['observer']);

  const moves = [];
  observer.on('presence:move', (event) => moves.push(event));
  first.emit('presence:update', { clientSeq: 1, lat: 40, lng: -0.88, heading: 90 });
  replacement.emit('presence:update', { clientSeq: 1, lat: 41.66, lng: -0.88, heading: 2 });
  await wait(40);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].lat, 41.66);

  replacement.disconnect();
  await wait(20);
  const promotedMove = once(observer, 'presence:move');
  first.emit('presence:update', { clientSeq: 2, lat: 41.661, lng: -0.88, heading: 4 });
  assert.equal((await promotedMove).lat, 41.661);

  const newcomer = await connect(server.url);
  const snapshot = await hello(newcomer, 'newcomer');
  assert.equal(snapshot.players.filter((p) => p.userId === 'same').length, 1);

  observer.emit('presence:update', {
    clientSeq: 1, lat: 41.66154, lng: -0.88, heading: 180,
  });
  await wait(20);
  let bulletSpawns = 0;
  let lifeUpdates = 0;
  observer.on('bullet:spawn', () => { bulletSpawns += 1; });
  observer.on('life:update', (event) => {
    if (event.userId === 'observer') lifeUpdates += 1;
  });
  const shotPayload = {
    clientShotId: 'after-reconnect-shot', cardId: 'projectile',
    from: { lat: 41.661, lng: -0.88 }, heading: 0,
    speed: 180, alcance: 100, dano: 100,
  };
  const shot = await ack(first, 'bullet:spawn', shotPayload);
  const duplicate = await ack(first, 'bullet:spawn', shotPayload);
  assert.equal(shot.ok, true);
  assert.equal(duplicate.duplicate, true);
  // 180 ms de retardo inicial + ~333 ms de vuelo hasta el objetivo a 60 m.
  await wait(650);
  assert.equal(bulletSpawns, 1);
  assert.equal(lifeUpdates, 1);
  first.disconnect(); observer.disconnect(); newcomer.disconnect();
});

test('life updates carry a strictly increasing server version', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const a = await connect(server.url);
  await hello(a, 'life-user');
  const versions = [];
  a.on('life:update', (event) => versions.push(event.lifeSeq));
  await ack(a, 'life:sync', {});
  await ack(a, 'life:sync', {});
  assert.equal(versions.length, 2);
  assert.ok(versions[1] > versions[0]);
  a.disconnect();
});

test('repeated reconnects keep one presence and one event per update', async (t) => {
  const server = await startServer(100);
  t.after(() => server.close());
  const observer = await connect(server.url);
  await hello(observer, 'observer');
  let current = null;
  let spawnCount = 0;
  let moveCount = 0;
  observer.on('presence:spawn', (event) => {
    if (event.userId === 'repeat') spawnCount += 1;
  });
  observer.on('presence:move', (event) => {
    if (event.userId === 'repeat') moveCount += 1;
  });
  for (let cycle = 0; cycle < 3; cycle++) {
    const next = await connect(server.url);
    await hello(next, 'repeat', 41.65 + cycle * 0.001);
    current?.disconnect();
    current = next;
  }
  current.emit('presence:update', {
    clientSeq: 1, lat: 41.66, lng: -0.88, heading: 2,
  });
  await wait(40);
  assert.equal(spawnCount, 3);
  assert.equal(moveCount, 1);
  const newcomer = await connect(server.url);
  const snapshot = await hello(newcomer, 'newcomer');
  assert.equal(snapshot.players.filter((p) => p.userId === 'repeat').length, 1);
  current.disconnect(); observer.disconnect(); newcomer.disconnect();
});
