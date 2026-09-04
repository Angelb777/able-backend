const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');
const registerPvp = require('../sockets/pvp.socket');

const once = (socket, event) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout ${event}`)), 3000);
  socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
});
const ack = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));
const emptyModel = { find: () => ({ lean: async () => [] }) };

async function runLoad(userCount) {
  const httpServer = http.createServer();
  const io = new Server(httpServer);
  registerPvp(io, {
    requireAuth: false,
    CardModel: { findById: () => ({ lean: async () => null }) },
    LifeModel: {
      findOne: () => ({ lean: async () => ({ vida: 1000 }) }),
      updateOne: async () => ({}),
    },
    TurretModel: emptyModel, MineModel: emptyModel,
    AirstrikeModel: emptyModel, UfoModel: emptyModel,
    UserModel: {
      findById: (id) => {
        const query = {
          select: () => query, populate: () => query,
          lean: async () => ({ _id: id, nickname: `u${id}`, skinSeleccionada: null }),
        };
        return query;
      },
      findOneAndUpdate: () => ({ lean: async () => null }),
      updateOne: async () => ({}),
    },
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}/pvp`;
  const sockets = [];
  let receivedMoves = 0;
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  const cpuStart = process.cpuUsage();
  const heapStart = process.memoryUsage().heapUsed;
  for (let index = 0; index < userCount; index++) {
    const socket = createClient(url, {
      transports: ['websocket'], forceNew: true, reconnection: false,
    });
    await once(socket, 'connect');
    socket.on('presence:move', () => { receivedMoves += 1; });
    const response = await ack(socket, 'presence:hello', {
      userId: `stress-${index}`, lat: 41.65 + index * 0.000001,
      lng: -0.88, heading: 0,
    });
    assert.equal(response.ok, true);
    assert.equal(new Set(response.players.map((p) => p.userId)).size,
      response.players.length);
    sockets.push(socket);
  }
  for (let round = 1; round <= 5; round++) {
    sockets.forEach((socket, index) => socket.emit('presence:update', {
      clientSeq: round,
      lat: 41.65 + index * 0.000001 + round * 0.000001,
      lng: -0.88,
      heading: round,
    }));
  }
  const deliveryDeadline = Date.now() + 3000;
  const expectedMoves = userCount * userCount * 5;
  while (receivedMoves < expectedMoves && Date.now() < deliveryDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const cpu = process.cpuUsage(cpuStart);
  const heapDelta = process.memoryUsage().heapUsed - heapStart;
  eventLoop.disable();
  assert.equal(receivedMoves, expectedMoves);
  assert.equal(sockets.filter((socket) => !socket.connected).length, 0);
  const metrics = {
    users: userCount,
    movementEventsEmitted: userCount * 5,
    movementEventsDelivered: receivedMoves,
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    heapDeltaMb: Number((heapDelta / 1024 / 1024).toFixed(2)),
    eventLoopMeanMs: Number((eventLoop.mean / 1e6).toFixed(2)),
    eventLoopMaxMs: Number((eventLoop.max / 1e6).toFixed(2)),
    disconnected: 0,
    duplicateSnapshotIds: 0,
  };
  console.log(`STRESS_METRICS ${JSON.stringify(metrics)}`);
  sockets.forEach((socket) => socket.disconnect());
  await new Promise((resolve) => io.close(resolve));
  await new Promise((resolve) => httpServer.close(resolve));
  return metrics;
}

for (const users of [10, 25, 50]) {
  test(`presence load ${users} users`, { timeout: 30000 }, async () => {
    await runLoad(users);
  });
}
