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
      findById: () => query({
        _id: 'disguise-card',
        tipoArma: 'Disfraz',
        disguiseSkin: 'police-skin',
        duracionDisfraz: 30,
        tiempoEspera: 60,
        identidadAparente: 'police',
      }),
    },
    SkinModel: {
      findById: () => query({
        _id: 'police-skin',
        renderType: 'classic',
        scripts: { parado: ['/uploads/skins/police.png'] },
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
  assert.equal(activated.skinId, 'police-skin');
  assert.equal(activated.skinUrl, '/uploads/skins/police.png');
  assert.equal(activated.skinDefinition.renderType, 'classic');
  assert.equal(activated.apparentFaction, 'police');
  assert.equal(activated.durationSeconds, 30);
  assert.equal(activated.cooldownMs, 60000);

  const stacked = await emitWithAck(socket, 'card:use-disguise', {
    cardId: 'disguise-card',
  });
  assert.equal(stacked.ok, false);
  assert.match(stacked.error, /disfraz activo/i);
});
