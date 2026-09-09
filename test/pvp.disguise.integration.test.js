const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');
const registerPvp = require('../sockets/pvp.socket');

const query = (value) => {
  const result = {
    select: () => result,
    populate: () => result,
    sort: () => result,
    lean: async () => value,
  };
  return result;
};

const emitWithAck = (socket, event, payload) => new Promise((resolve) => {
  socket.emit(event, payload, resolve);
});

test('Disfraz changes the authoritative skin and cannot be stacked', async (t) => {
  const emptyPersistentModel = {
    find: () => query([]),
  };
  const userId = '507f1f77bcf86cd799439011';
  const httpServer = http.createServer();
  const io = new Server(httpServer, { transports: ['websocket'] });
  registerPvp(io, {
    CardModel: {
      findById: (id) => query(id === 'animated-disguise-card'
        ? {
            _id: id,
            tipoArma: 'Disfraz',
            disguiseRenderType: 'flame_spritesheet',
            disguiseSpritesheet: {
              url: '/uploads/cards/police-walk.png',
              columns: 3,
              rows: 1,
              frames: 3,
              fps: 12,
              frameTime: 1 / 12,
              loop: true,
              frameOrder: [0, 1, 2],
            },
            duracionDisfraz: 20,
            tiempoEspera: 10,
            identidadAparente: 'police',
          }
        : {
            _id: 'disguise-card',
            tipoArma: 'Disfraz',
            disguiseRenderType: 'classic',
            disguiseImage: '/uploads/cards/police-disguise.png',
            duracionDisfraz: 30,
            tiempoEspera: 60,
            identidadAparente: 'police',
          }),
    },
    UserModel: {
      findById: (id) => query({ _id: String(id), gameModeEnabled: true }),
      findOne: () => query({ _id: userId }),
      findOneAndUpdate: () => query(null),
    },
    LifeModel: {
      findOne: () => query({ vida: 1000 }),
    },
    TurretModel: emptyPersistentModel,
    MineModel: emptyPersistentModel,
    AirstrikeModel: emptyPersistentModel,
    UfoModel: emptyPersistentModel,
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  const socket = createClient(`http://127.0.0.1:${address.port}/pvp`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  t.after(async () => {
    socket.disconnect();
    await new Promise((resolve) => io.close(resolve));
    if (httpServer.listening) {
      await new Promise((resolve) => httpServer.close(resolve));
    }
  });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  const hello = await emitWithAck(socket, 'presence:hello', {
    userId,
    lat: 41.6567,
    lng: -0.8785,
    nickname: 'Infiltrado',
    skinUrl: '/uploads/skins/original.png',
  });
  assert.equal(hello.ok, true);

  const activated = await emitWithAck(socket, 'card:use-disguise', {
    cardId: 'disguise-card',
  });
  assert.equal(activated.ok, true);
  assert.equal(activated.skinId, 'disguise-disguise-card');
  assert.equal(activated.skinUrl, '/uploads/cards/police-disguise.png');
  assert.equal(activated.skinDefinition.renderType, 'classic');
  assert.equal(activated.skinDefinition.portada, '/uploads/cards/police-disguise.png');
  assert.equal(activated.apparentFaction, 'police');
  assert.equal(activated.durationSeconds, 30);
  assert.equal(activated.cooldownMs, 60000);

  const stacked = await emitWithAck(socket, 'card:use-disguise', {
    cardId: 'disguise-card',
  });
  assert.equal(stacked.ok, false);
  assert.match(stacked.error, /disfraz activo/i);

  const animatedSocket = createClient(`http://127.0.0.1:${address.port}/pvp`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  t.after(() => animatedSocket.disconnect());
  await new Promise((resolve, reject) => {
    animatedSocket.once('connect', resolve);
    animatedSocket.once('connect_error', reject);
  });
  const animatedUserId = '507f191e810c19729de860ea';
  const animatedHello = await emitWithAck(animatedSocket, 'presence:hello', {
    userId: animatedUserId,
    lat: 41.6568,
    lng: -0.8785,
    nickname: 'Policía animado',
    skinUrl: '/uploads/skins/original.png',
  });
  assert.equal(animatedHello.ok, true);
  const animated = await emitWithAck(animatedSocket, 'card:use-disguise', {
    cardId: 'animated-disguise-card',
  });
  assert.equal(animated.ok, true);
  assert.equal(animated.skinUrl, '');
  assert.equal(animated.skinDefinition.renderType, 'flame_spritesheet');
  assert.equal(animated.skinDefinition.portada, '/uploads/cards/police-walk.png');
  assert.equal(animated.skinDefinition.spritesheets.idle.frames, 1);
  assert.deepEqual(animated.skinDefinition.spritesheets.idle.frameOrder, [0]);
  assert.equal(animated.skinDefinition.spritesheets.walk.frames, 3);
});
