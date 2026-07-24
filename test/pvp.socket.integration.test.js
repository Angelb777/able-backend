const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');
const registerPvp = require('../sockets/pvp.socket');
const geo = require('../utils/geo');

const waitForEvent = (socket, event, timeoutMs = 2000) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timeout waiting for ${event}`));
    }, timeoutMs);
    const handler = (data) => {
      clearTimeout(timeout);
      resolve(data);
    };
    socket.once(event, handler);
  });

const emitWithAck = (socket, event, payload, timeoutMs = 2000) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timeout waiting for ACK ${event}`)),
      timeoutMs
    );
    socket.emit(event, payload, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });

const connectClient = (url) =>
  new Promise((resolve, reject) => {
    const socket = createClient(`${url}/pvp`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });

test('two players share presence, movement, one hit, life and explosions', async (t) => {
  const lifeByUser = new Map();
  const fakeLifeModel = {
    findOne({ userId }) {
      return {
        lean: async () =>
          lifeByUser.has(userId) ? { vida: lifeByUser.get(userId) } : null,
      };
    },
    async updateOne({ userId }, update) {
      lifeByUser.set(userId, update.$set.vida);
      return { acknowledged: true };
    },
  };
  const fakeCardModel = {
    findById(cardId) {
      return {
        lean: async () => {
          const cards = {
            'card-projectile': {
              alcance: 45,
              dano: 125,
            },
            'card-short': {
              alcance: 6,
              dano: 25,
            },
          };
          const card = cards[cardId];
          return card
            ? {
                _id: cardId,
                tipoArma: 'Proyectil',
                tiempoEspera: 0,
                ...card,
              }
            : null;
        },
      };
    },
  };

  const httpServer = http.createServer();
  const io = new Server(httpServer, { transports: ['websocket'] });
  registerPvp(io, {
    CardModel: fakeCardModel,
    LifeModel: fakeLifeModel,
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  const url = `http://127.0.0.1:${address.port}`;

  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    await new Promise((resolve) => io.close(resolve));
    if (httpServer.listening) {
      await new Promise((resolve) => httpServer.close(resolve));
    }
  });

  const playerA = await connectClient(url);
  sockets.push(playerA);
  const helloA = await emitWithAck(playerA, 'presence:hello', {
    userId: '507f1f77bcf86cd799439011',
    lat: 41.6567,
    lng: -0.8785,
    heading: 0,
    skinUrl: 'https://example.test/skin-a.png',
    nombre: 'Alice',
  });
  assert.equal(helloA.ok, true);
  assert.deepEqual(helloA.players, []);

  const spawnOnA = waitForEvent(playerA, 'presence:spawn');
  const playerB = await connectClient(url);
  sockets.push(playerB);
  const helloB = await emitWithAck(playerB, 'presence:hello', {
    userId: '507f191e810c19729de860ea',
    lat: 41.6567,
    lng: -0.8785,
    heading: 0,
    skinUrl: 'https://example.test/skin-b.png',
    nombre: 'Bob',
  });
  const spawnedB = await spawnOnA;
  assert.equal(helloB.ok, true);
  assert.equal(helloB.players.length, 1);
  assert.equal(helloB.players[0].userId, '507f1f77bcf86cd799439011');
  assert.equal(helloB.players[0].nombre, 'Alice');
  assert.equal(helloB.players[0].vida, 1000);
  assert.equal(spawnedB.userId, '507f191e810c19729de860ea');
  assert.equal(spawnedB.skinUrl, 'https://example.test/skin-b.png');

  const moveOnB = waitForEvent(playerB, 'presence:move');
  playerA.emit('presence:update', {
    lat: 41.65671,
    lng: -0.8785,
    heading: 5,
  });
  const movedA = await moveOnB;
  assert.equal(movedA.userId, '507f1f77bcf86cd799439011');
  assert.equal(movedA.nombre, 'Alice');
  assert.equal(movedA.skinUrl, 'https://example.test/skin-a.png');

  let lifeEventsA = 0;
  let lifeEventsB = 0;
  let explosionsA = 0;
  let explosionsB = 0;
  playerA.on('life:update', () => lifeEventsA++);
  playerB.on('life:update', () => lifeEventsB++);
  playerA.on('bullet:explode', () => explosionsA++);
  playerB.on('bullet:explode', () => explosionsB++);

  const bulletOnB = waitForEvent(playerB, 'bullet:spawn');
  const lifeOnA = waitForEvent(playerA, 'life:update');
  const lifeOnB = waitForEvent(playerB, 'life:update');
  const explosionOnA = waitForEvent(playerA, 'bullet:explode');
  const explosionOnB = waitForEvent(playerB, 'bullet:explode');
  const bulletAck = await emitWithAck(playerA, 'bullet:spawn', {
    clientShotId: 'shot-a-1',
    cardId: 'card-projectile',
    from: { lat: 41.65671, lng: -0.8785 },
    heading: 0,
    speed: 180,
    alcance: 45,
    dano: 125,
    spriteUrl: 'https://example.test/bullet.png',
    explosionFrames: ['https://example.test/explosion.png'],
  });
  const spawnedBullet = await bulletOnB;
  const [lifeA, lifeB, explodedA, explodedB] = await Promise.all([
    lifeOnA,
    lifeOnB,
    explosionOnA,
    explosionOnB,
  ]);

  assert.equal(bulletAck.ok, true);
  assert.equal(spawnedBullet.bulletId, bulletAck.bulletId);
  assert.equal(spawnedBullet.clientShotId, 'shot-a-1');
  assert.equal(spawnedBullet.byUserId, '507f1f77bcf86cd799439011');
  assert.deepEqual(spawnedBullet.explosionFrames, [
    'https://example.test/explosion.png',
  ]);
  assert.equal(lifeA.bulletId, bulletAck.bulletId);
  assert.deepEqual(lifeA, lifeB);
  assert.equal(lifeA.userId, '507f191e810c19729de860ea');
  assert.equal(lifeA.vida, 875);
  assert.equal(lifeByUser.get('507f191e810c19729de860ea'), 875);
  assert.equal(explodedA.bulletId, bulletAck.bulletId);
  assert.deepEqual(explodedA, explodedB);
  assert.equal(explodedA.reason, 'hit');
  assert.equal(explodedA.hitUserId, '507f191e810c19729de860ea');

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(lifeEventsA, 1);
  assert.equal(lifeEventsB, 1);
  assert.equal(explosionsA, 1);
  assert.equal(explosionsB, 1);

  const moveFarOnA = waitForEvent(playerA, 'presence:move');
  playerB.emit('presence:update', {
    lat: 41.6667,
    lng: -0.8785,
    heading: 0,
  });
  await moveFarOnA;

  const rangeExplosionOnA = waitForEvent(playerA, 'bullet:explode');
  const rangeAck = await emitWithAck(playerA, 'bullet:spawn', {
    clientShotId: 'shot-a-2',
    cardId: 'card-projectile',
    from: { lat: 41.65671, lng: -0.8785 },
    heading: 90,
    speed: 180,
    alcance: 45,
    dano: 125,
    spriteUrl: 'https://example.test/bullet.png',
    explosionFrames: ['https://example.test/explosion.png'],
  });
  const rangeExplosion = await rangeExplosionOnA;
  assert.equal(rangeAck.ok, true);
  assert.equal(rangeExplosion.bulletId, rangeAck.bulletId);
  assert.equal(rangeExplosion.reason, 'range');
  assert.ok(rangeExplosion.lng > -0.8785);
  assert.ok(
    Math.abs(
      geo.distanceMeters(
        { lat: 41.65671, lng: -0.8785 },
        { lat: rangeExplosion.lat, lng: rangeExplosion.lng }
      ) - 45
    ) < 0.25
  );
  assert.equal(lifeByUser.get('507f191e810c19729de860ea'), 875);

  const origin = { lat: 41.65671, lng: -0.8785 };
  const north20 = geo.computeOffset(origin, 20, 0);
  const besidePath = geo.computeOffset(north20, 9.5, 90);
  const nearMissMove = waitForEvent(playerA, 'presence:move');
  playerB.emit('presence:update', {
    lat: besidePath.lat,
    lng: besidePath.lng,
    heading: 0,
  });
  await nearMissMove;

  const nearMissExplosionOnA = waitForEvent(playerA, 'bullet:explode');
  const nearMissAck = await emitWithAck(playerA, 'bullet:spawn', {
    clientShotId: 'shot-a-near-miss',
    cardId: 'card-projectile',
    from: origin,
    heading: 0,
    speed: 180,
    alcance: 45,
    dano: 125,
    spriteUrl: 'https://example.test/bullet.png',
    explosionFrames: ['https://example.test/explosion.png'],
  });
  const nearMissExplosion = await nearMissExplosionOnA;
  assert.equal(nearMissExplosion.bulletId, nearMissAck.bulletId);
  assert.equal(nearMissExplosion.reason, 'range');
  assert.equal(lifeByUser.get('507f191e810c19729de860ea'), 875);

  const directHitMove = waitForEvent(playerA, 'presence:move');
  playerB.emit('presence:update', {
    lat: north20.lat,
    lng: north20.lng,
    heading: 0,
  });
  await directHitMove;

  const directLifeOnA = waitForEvent(playerA, 'life:update');
  const directExplosionOnA = waitForEvent(playerA, 'bullet:explode');
  const directAck = await emitWithAck(playerA, 'bullet:spawn', {
    clientShotId: 'shot-a-direct-hit',
    cardId: 'card-projectile',
    from: origin,
    heading: 0,
    speed: 180,
    alcance: 45,
    dano: 125,
    spriteUrl: 'https://example.test/bullet.png',
    explosionFrames: ['https://example.test/explosion.png'],
  });
  const [directLife, directExplosion] = await Promise.all([
    directLifeOnA,
    directExplosionOnA,
  ]);
  assert.equal(directLife.bulletId, directAck.bulletId);
  assert.equal(directLife.vida, 750);
  assert.equal(directExplosion.reason, 'hit');
  assert.equal(directExplosion.hitUserId, '507f191e810c19729de860ea');
  assert.ok(
    Math.abs(
      geo.distanceMeters(
        origin,
        { lat: directExplosion.lat, lng: directExplosion.lng }
      ) - 12
    ) < 0.3
  );

  const farAway = geo.computeOffset(origin, 1000, 90);
  const shortMove = waitForEvent(playerA, 'presence:move');
  playerB.emit('presence:update', {
    lat: farAway.lat,
    lng: farAway.lng,
    heading: 0,
  });
  await shortMove;

  const shortSpawnOnB = waitForEvent(playerB, 'bullet:spawn');
  const shortExplosionOnB = waitForEvent(playerB, 'bullet:explode');
  const shortAck = await emitWithAck(playerA, 'bullet:spawn', {
    clientShotId: 'shot-a-short',
    cardId: 'card-short',
    from: origin,
    heading: 180,
    speed: 180,
    alcance: 6,
    dano: 25,
    spriteUrl: 'https://example.test/bullet.png',
    explosionFrames: ['https://example.test/explosion.png'],
  });
  const shortSpawn = await shortSpawnOnB;
  const shortSpawnReceivedAt = Date.now();
  const shortExplosion = await shortExplosionOnB;
  assert.equal(shortSpawn.bulletId, shortAck.bulletId);
  assert.equal(shortSpawn.startDelayMs, 180);
  assert.equal(shortExplosion.reason, 'range');
  assert.ok(Date.now() - shortSpawnReceivedAt >= 140);
  assert.ok(shortExplosion.lat < origin.lat);
  assert.ok(
    Math.abs(
      geo.distanceMeters(
        origin,
        { lat: shortExplosion.lat, lng: shortExplosion.lng }
      ) - 6
    ) < 0.25
  );

  let leaveEventsOnA = 0;
  playerA.on('presence:leave', () => leaveEventsOnA++);
  const duplicateSpawnOnA = waitForEvent(playerA, 'presence:spawn');
  const duplicateB = await connectClient(url);
  sockets.push(duplicateB);
  const duplicateHello = await emitWithAck(duplicateB, 'presence:hello', {
    userId: '507f191e810c19729de860ea',
    lat: 41.6667,
    lng: -0.8785,
    heading: 0,
    skinUrl: 'https://example.test/skin-b.png',
    nombre: 'Bob',
  });
  await duplicateSpawnOnA;
  assert.equal(duplicateHello.ok, true);
  assert.equal(duplicateHello.players.length, 1);
  assert.equal(
    duplicateHello.players[0].userId,
    '507f1f77bcf86cd799439011'
  );

  playerB.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(leaveEventsOnA, 0);

  const leaveOnA = waitForEvent(playerA, 'presence:leave');
  duplicateB.disconnect();
  const leftB = await leaveOnA;
  assert.equal(leftB.userId, '507f191e810c19729de860ea');
  assert.equal(leaveEventsOnA, 1);
});
