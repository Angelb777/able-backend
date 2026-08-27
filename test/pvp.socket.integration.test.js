const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');
const registerPvp = require('../sockets/pvp.socket');
const geo = require('../utils/geo');
const jwt = require('jsonwebtoken');
const socialRealtime = require('../api/services/socialRealtime');

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
            'card-long': {
              alcance: 100,
              dano: 125,
            },
            'card-short': {
              alcance: 6,
              dano: 25,
            },
            'card-turret-zero': {
              tipoArma: 'Arrastre',
              alcance: 0,
              dano: 0,
              vida: 200,
              cadenciaDisparo: 1,
              duracion: 60,
              turretRenderType: 'flame_spritesheet',
              imagenesMovimiento: ['/uploads/cards/turret-classic.png'],
              turretIdleSpritesheet: {
                url: '/uploads/cards/turret-idle.png', columns: 4, rows: 1,
                frames: 4, frameTime: 0.1, fps: 10, loop: true,
                readOrder: 'row-major',
              },
              turretDeathSpritesheet: {
                url: '/uploads/cards/turret-death.png', columns: 4, rows: 1,
                frames: 4, frameTime: 0.1, fps: 10, loop: false,
                readOrder: 'row-major',
              },
            },
            'card-turret-expiring': {
              tipoArma: 'Arrastre', alcance: 100, dano: 10, vida: 50,
              cadenciaDisparo: 10, duracion: 1,
              turretRenderType: 'flame_spritesheet',
              imagenesMovimiento: ['/uploads/cards/turret-expiring.png'],
              turretIdleSpritesheet: {
                url: '/uploads/cards/turret-expiring-idle.png', columns: 2, rows: 1,
                frames: 2, frameTime: 0.1, fps: 10, loop: true,
              },
              turretDeathSpritesheet: {
                url: '/uploads/cards/turret-expiring-death.png', columns: 2, rows: 1,
                frames: 2, frameTime: 0.1, fps: 10, loop: false,
              },
            },
            'card-life': {
              tipoArma: 'Vida',
              vidaQueDa: 150,
              tiempoEspera: 40,
            },
            'card-mine': {
              tipoArma: 'Trampa',
              radioActivacion: 8,
              dano: 90,
              duracion: 300,
              tiempoEspera: 5,
          usoUnico: false,
              imagenPortada: '/uploads/cards/mine.webp',
              imagenesActivacion: ['/uploads/cards/mine-explosion.webp'],
              imagenesExplosionTrampa: [
                '/uploads/cards/mine-explosion-final.webp',
              ],
            },
            'card-mine-expiring': {
              tipoArma: 'Trampa',
              radioActivacion: 5,
              dano: 25,
              duracion: 1,
              usoUnico: true,
            },
            'card-mine-owner': {
              tipoArma: 'Trampa',
              radioActivacion: 5,
              dano: 25,
              duracion: 300,
              tiempoEspera: 5,
              usoUnico: true,
              imagenesExplosionTrampa: ['/uploads/cards/owner-explosion.webp'],
            },
            'card-airstrike': {
              tipoArma: 'Invocacion',
              radioExplosion: 15,
              dano: 200,
              tiempoHastaAtaque: 1,
              tiempoEspera: 5,
              imagenesAvion: ['/uploads/cards/plane.webp'],
              imagenesBomba: ['/uploads/cards/bomb.webp'],
              imagenesExplosionInvocacion: [
                '/uploads/cards/airstrike-explosion.webp',
              ],
            },
          };
          const card = cards[cardId];
          return card
            ? {
                _id: cardId,
                tipoArma: card.tipoArma || 'Proyectil',
                tiempoEspera: 0,
                ...card,
              }
            : null;
        },
      };
    },
  };
  const fakeTurretModel = {
    find() {
      return { lean: async () => [] };
    },
    async create(data) {
      const stored = { _id: 'turret-test-1', ...data };
      return {
        ...stored,
        toObject: () => ({ ...stored }),
      };
    },
    async updateOne() {},
    async deleteOne() {},
  };
  const deletedMines = [];
  let mineSequence = 0;
  const fakeMineModel = {
    find() {
      return { lean: async () => [] };
    },
    async create(data) {
      mineSequence++;
      const stored = { _id: `mine-test-${mineSequence}`, ...data };
      return {
        ...stored,
        toObject: () => ({ ...stored }),
      };
    },
    async deleteOne({ _id }) {
      deletedMines.push(String(_id));
    },
  };
  const deletedAirstrikes = [];
  const fakeAirstrikeModel = {
    find() {
      return { lean: async () => [] };
    },
    async create(data) {
      const stored = { _id: 'airstrike-test-1', ...data };
      return {
        ...stored,
        toObject: () => ({ ...stored }),
      };
    },
    async updateOne() {},
    async deleteOne({ _id }) {
      deletedAirstrikes.push(String(_id));
    },
  };
  const cardsByUser = new Map([
    [
      '507f1f77bcf86cd799439011',
      new Set([
        'card-mine',
        'card-mine-expiring',
        'card-mine-owner',
        'card-airstrike',
      ]),
    ],
    ['507f191e810c19729de860ea', new Set(['card-life'])],
  ]);
  const fakeUserModel = {
    findById(id) {
      const query = {
        select: () => query,
        lean: async () => ({ _id: String(id), gameModeEnabled: true }),
      };
      return query;
    },
    findOne(query) {
      return {
        lean: async () => {
          const ownedCards = cardsByUser.get(String(query._id));
          const cardId = String(query.cartas || '');
          return ownedCards?.has(cardId) && query.mazo === query.cartas
            ? { _id: String(query._id) }
            : null;
        },
      };
    },
    findOneAndUpdate(query, update) {
      return {
        lean: async () => {
          const userId = String(query._id);
          const ownedCards = cardsByUser.get(userId);
          const cardId = String(query.cartas || '');
          if (!ownedCards?.has(cardId) || query.mazo !== query.cartas) {
            return null;
          }
          ownedCards.delete(cardId);
          return { _id: userId, cartas: [...ownedCards], mazo: [...ownedCards] };
        },
      };
    },
    async updateOne({ _id }, update) {
      const ownedCards = cardsByUser.get(String(_id)) || new Set();
      for (const cardId of update.$addToSet?.cartas
        ? [update.$addToSet.cartas]
        : []) {
        ownedCards.add(String(cardId));
      }
      cardsByUser.set(String(_id), ownedCards);
    },
  };
  const fakeUfoModel = {
    find() {
      return { lean: async () => [] };
    },
  };

  const httpServer = http.createServer();
  const io = new Server(httpServer, { transports: ['websocket'] });
  registerPvp(io, {
    CardModel: fakeCardModel,
    LifeModel: fakeLifeModel,
    TurretModel: fakeTurretModel,
    MineModel: fakeMineModel,
    AirstrikeModel: fakeAirstrikeModel,
    UserModel: fakeUserModel,
    UfoModel: fakeUfoModel,
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
    nickname: 'Alice',
  });
  assert.equal(helloA.ok, true);
  assert.deepEqual(helloA.players, []);

  const spawnOnA = waitForEvent(playerA, 'presence:spawn');
  const playerB = await connectClient(url);
  sockets.push(playerB);
  const initialTarget = geo.computeOffset(
    { lat: 41.656715, lng: -0.8785 }, 60, 0
  );
  const helloB = await emitWithAck(playerB, 'presence:hello', {
    userId: '507f191e810c19729de860ea',
    lat: initialTarget.lat,
    lng: initialTarget.lng,
    heading: 0,
    skinUrl: 'https://example.test/skin-b.png',
    nickname: 'Bob',
  });
  const spawnedB = await spawnOnA;
  assert.equal(helloB.ok, true);
  assert.equal(helloB.players.length, 1);
  assert.equal(helloB.players[0].userId, '507f1f77bcf86cd799439011');
  assert.equal(helloB.players[0].nickname, 'Alice');
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
  assert.equal(movedA.nickname, 'Alice');
  assert.equal(movedA.skinUrl, 'https://example.test/skin-a.png');

  const skinMoveOnB = waitForEvent(playerB, 'presence:move');
  playerA.emit('presence:update', {
    lat: 41.65671,
    lng: -0.8785,
    heading: 5,
    skinUrl: 'https://example.test/skin-a-new.png',
    nickname: 'Alice',
  });
  const skinMovedA = await skinMoveOnB;
  assert.equal(skinMovedA.skinUrl, 'https://example.test/skin-a-new.png');

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
    cardId: 'card-long',
    from: { lat: 41.656715, lng: -0.8785 },
    heading: 0,
    speed: 180,
    alcance: 100,
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
  assert.deepEqual(spawnedBullet.from, { lat: 41.656715, lng: -0.8785 });
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

  let duplicateSpawnsOnB = 0;
  const onDuplicateSpawn = () => duplicateSpawnsOnB++;
  playerB.on('bullet:spawn', onDuplicateSpawn);
  const duplicateAck = await emitWithAck(playerA, 'bullet:spawn', {
    clientShotId: 'shot-a-1',
    cardId: 'card-long',
    from: { lat: 41.656715, lng: -0.8785 },
    heading: 0,
    speed: 180,
    alcance: 100,
    dano: 125,
  });
  await new Promise((resolve) => setTimeout(resolve, 75));
  playerB.off('bullet:spawn', onDuplicateSpawn);
  assert.equal(duplicateAck.ok, true);
  assert.equal(duplicateAck.duplicate, true);
  assert.equal(duplicateAck.bulletId, bulletAck.bulletId);
  assert.equal(duplicateSpawnsOnB, 0);
  assert.equal(lifeByUser.get('507f191e810c19729de860ea'), 875);

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
    cardId: 'card-long',
    from: { lat: 41.65671, lng: -0.8785 },
    heading: 90,
    speed: 180,
    alcance: 100,
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
      ) - 100
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
    cardId: 'card-long',
    from: origin,
    heading: 0,
    speed: 180,
    alcance: 100,
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

  const directExplosionOnA = waitForEvent(playerA, 'bullet:explode');
  const directAck = await emitWithAck(playerA, 'bullet:spawn', {
    clientShotId: 'shot-a-close-protected',
    cardId: 'card-long',
    from: origin,
    heading: 0,
    speed: 180,
    alcance: 100,
    dano: 125,
    spriteUrl: 'https://example.test/bullet.png',
    explosionFrames: ['https://example.test/explosion.png'],
  });
  const directExplosion = await directExplosionOnA;
  assert.equal(directExplosion.bulletId, directAck.bulletId);
  assert.equal(directExplosion.reason, 'range');
  assert.equal(directExplosion.hitUserId, null);
  assert.equal(lifeByUser.get('507f191e810c19729de860ea'), 875);
  assert.ok(
    Math.abs(
      geo.distanceMeters(
        origin,
        { lat: directExplosion.lat, lng: directExplosion.lng }
      ) - 100
    ) < 0.3
  );

  lifeByUser.set('507f191e810c19729de860ea', 940);
  const syncedLifeOnA = waitForEvent(playerA, 'life:update');
  const syncedLifeOnB = waitForEvent(playerB, 'life:update');
  const lifeSyncAck = await emitWithAck(playerB, 'life:sync', {});
  const [syncedLifeA, syncedLifeB] = await Promise.all([
    syncedLifeOnA,
    syncedLifeOnB,
  ]);
  assert.equal(lifeSyncAck.ok, true);
  assert.equal(lifeSyncAck.vida, 940);
  assert.equal(syncedLifeA.vida, 940);
  assert.deepEqual(syncedLifeA, syncedLifeB);

  const healedLifeOnA = waitForEvent(playerA, 'life:update');
  const healedLifeOnB = waitForEvent(playerB, 'life:update');
  const lifeCardAck = await emitWithAck(playerB, 'card:use-life', {
    cardId: 'card-life',
  });
  const [healedLifeA, healedLifeB] = await Promise.all([
    healedLifeOnA,
    healedLifeOnB,
  ]);
  assert.equal(lifeCardAck.ok, true);
  assert.equal(lifeCardAck.vida, 1000);
  assert.equal(lifeCardAck.vidaRecuperada, 60);
  assert.equal(healedLifeA.reason, 'life-card');
  assert.equal(healedLifeA.vida, 1000);
  assert.deepEqual(healedLifeA, healedLifeB);
  assert.equal(lifeByUser.get('507f191e810c19729de860ea'), 1000);
  assert.equal(cardsByUser.get('507f191e810c19729de860ea').size, 1);

  lifeByUser.set('507f191e810c19729de860ea', 900);
  const reusedLifeCardAck = await emitWithAck(playerB, 'card:use-life', {
    cardId: 'card-life',
  });
  assert.equal(reusedLifeCardAck.ok, false);
  assert.match(reusedLifeCardAck.error, /tiempo de espera/i);
  assert.equal(cardsByUser.get('507f191e810c19729de860ea').size, 1);

  let mineTriggers = 0;
  playerA.on('mine:trigger', () => mineTriggers++);
  const north10 = geo.computeOffset(origin, 10, 0);
  const mineSpawnOnA = waitForEvent(playerA, 'mine:spawn');
  const mineSpawnOnB = waitForEvent(playerB, 'mine:spawn');
  const minePlaceAck = await emitWithAck(playerA, 'mine:place', {
    cardId: 'card-mine',
    lat: north10.lat,
    lng: north10.lng,
  });
  const [spawnedMineA, spawnedMineB] = await Promise.all([
    mineSpawnOnA,
    mineSpawnOnB,
  ]);
  assert.equal(minePlaceAck.ok, true);
  assert.equal(spawnedMineA.mineId, 'mine-test-1');
  assert.equal(spawnedMineA.seq, 1);
  assert.deepEqual(spawnedMineA, spawnedMineB);
  assert.equal(
    spawnedMineA.imagenMapa,
    '/uploads/cards/mine-explosion.webp'
  );
  assert.deepEqual(spawnedMineA.imagenesExplosion, [
    '/uploads/cards/mine-explosion-final.webp',
  ]);
  assert.equal(
    cardsByUser.get('507f1f77bcf86cd799439011').has('card-mine'),
    true
  );

  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(mineTriggers, 0);

  const mineCooldownAck = await emitWithAck(playerA, 'mine:place', {
    cardId: 'card-mine',
    lat: north10.lat,
    lng: north10.lng,
  });
  assert.equal(mineCooldownAck.ok, false);
  assert.match(mineCooldownAck.error, /tiempo de espera/i);

  const mineTriggerOnA = waitForEvent(playerA, 'mine:trigger');
  const mineTriggerOnB = waitForEvent(playerB, 'mine:trigger');
  const mineLifeOnA = waitForEvent(playerA, 'life:update');
  const mineLifeOnB = waitForEvent(playerB, 'life:update');
  const mineMoveOnA = waitForEvent(playerA, 'presence:move');
  playerB.emit('presence:update', {
    lat: north10.lat,
    lng: north10.lng,
    heading: 0,
  });
  await mineMoveOnA;
  const [triggeredMineA, triggeredMineB, mineLifeA, mineLifeB] =
    await Promise.all([
      mineTriggerOnA,
      mineTriggerOnB,
      mineLifeOnA,
      mineLifeOnB,
    ]);
  assert.equal(triggeredMineA.targetUserId, '507f191e810c19729de860ea');
  assert.equal(triggeredMineA.removed, true);
  assert.ok(triggeredMineA.seq > spawnedMineA.seq);
  assert.deepEqual(triggeredMineA, triggeredMineB);
  assert.deepEqual(triggeredMineA.imagenesExplosion, [
    '/uploads/cards/mine-explosion-final.webp',
  ]);
  assert.equal(mineLifeA.vida, 910);
  assert.equal(mineLifeA.reason, 'mine');
  assert.deepEqual(mineLifeA, mineLifeB);
  assert.deepEqual(deletedMines, ['mine-test-1']);

  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(mineTriggers, 1);

  const returnNorthOnA = waitForEvent(playerA, 'presence:move');
  playerB.emit('presence:update', {
    lat: north20.lat,
    lng: north20.lng,
    heading: 0,
  });
  await returnNorthOnA;

  const ownerMineTrigger = waitForEvent(playerA, 'mine:trigger');
  const ownerMineLife = waitForEvent(playerA, 'life:update');
  const ownerMineAck = await emitWithAck(playerA, 'mine:place', {
    cardId: 'card-mine-owner',
    lat: origin.lat,
    lng: origin.lng,
  });
  assert.equal(ownerMineAck.ok, true);
  const [triggeredOwnerMine, ownerLife] = await Promise.all([
    ownerMineTrigger,
    ownerMineLife,
  ]);
  assert.equal(triggeredOwnerMine.targetUserId, '507f1f77bcf86cd799439011');
  assert.deepEqual(triggeredOwnerMine.imagenesExplosion, [
    '/uploads/cards/owner-explosion.webp',
  ]);
  assert.equal(ownerLife.userId, '507f1f77bcf86cd799439011');
  assert.equal(ownerLife.vida, 975);

  const expiringMineDestroy = waitForEvent(playerA, 'mine:destroy', 2500);
  const mineFar = geo.computeOffset(origin, 100, 90);
  const expiringMineAck = await emitWithAck(playerA, 'mine:place', {
    cardId: 'card-mine-expiring',
    lat: mineFar.lat,
    lng: mineFar.lng,
  });
  assert.equal(expiringMineAck.ok, true);
  const expiredMine = await expiringMineDestroy;
  assert.equal(expiredMine.mineId, 'mine-test-3');
  assert.equal(expiredMine.reason, 'expired');
  assert.equal(expiredMine.seq, 2);

  const airstrikeSpawnA = waitForEvent(playerA, 'airstrike:spawn');
  const airstrikeSpawnB = waitForEvent(playerB, 'airstrike:spawn');
  const airstrikeLaunchA = waitForEvent(playerA, 'airstrike:launch', 2500);
  const airstrikeLaunchB = waitForEvent(playerB, 'airstrike:launch', 2500);
  const airstrikeImpactA = waitForEvent(playerA, 'airstrike:impact', 9000);
  const airstrikeImpactB = waitForEvent(playerB, 'airstrike:impact', 9000);
  const airstrikePlacedAt = Date.now();
  const airstrikeAck = await emitWithAck(playerA, 'airstrike:place', {
    cardId: 'card-airstrike',
    lat: north10.lat,
    lng: north10.lng,
  });
  const [spawnedAirstrikeA, spawnedAirstrikeB] = await Promise.all([
    airstrikeSpawnA,
    airstrikeSpawnB,
  ]);
  assert.equal(airstrikeAck.ok, true);
  assert.equal(spawnedAirstrikeA.airstrikeId, 'airstrike-test-1');
  assert.equal(spawnedAirstrikeA.seq, 1);
  assert.deepEqual(spawnedAirstrikeA, spawnedAirstrikeB);
  assert.equal(
    cardsByUser.get('507f1f77bcf86cd799439011').has('card-airstrike'),
    true
  );

  const airstrikeCooldownAck = await emitWithAck(
    playerA,
    'airstrike:place',
    {
      cardId: 'card-airstrike',
      lat: north10.lat,
      lng: north10.lng,
    }
  );
  assert.equal(airstrikeCooldownAck.ok, false);
  assert.match(airstrikeCooldownAck.error, /tiempo de espera/i);

  const [launchedAirstrikeA, launchedAirstrikeB] = await Promise.all([
    airstrikeLaunchA,
    airstrikeLaunchB,
  ]);
  assert.ok(Date.now() - airstrikePlacedAt >= 800);
  assert.deepEqual(launchedAirstrikeA, launchedAirstrikeB);
  assert.ok(launchedAirstrikeA.seq > spawnedAirstrikeA.seq);
  assert.deepEqual(launchedAirstrikeA.imagenesAvion, [
    '/uploads/cards/plane.webp',
  ]);
  assert.deepEqual(launchedAirstrikeA.imagenesBomba, [
    '/uploads/cards/bomb.webp',
  ]);
  assert.equal(launchedAirstrikeA.planeDurationMs, 6000);
  assert.equal(launchedAirstrikeA.bombDropDelayMs, 4000);
  assert.equal(launchedAirstrikeA.bombDurationMs, 2000);

  const [impactedAirstrikeA, impactedAirstrikeB] = await Promise.all([
    airstrikeImpactA,
    airstrikeImpactB,
  ]);
  assert.deepEqual(impactedAirstrikeA, impactedAirstrikeB);
  assert.ok(impactedAirstrikeA.seq > launchedAirstrikeA.seq);
  assert.deepEqual(impactedAirstrikeA.imagenesExplosion, [
    '/uploads/cards/airstrike-explosion.webp',
  ]);
  assert.deepEqual(
    impactedAirstrikeA.hits.map((hit) => hit.userId).sort(),
    ['507f191e810c19729de860ea', '507f1f77bcf86cd799439011'].sort()
  );
  assert.equal(lifeByUser.get('507f1f77bcf86cd799439011'), 775);
  assert.equal(lifeByUser.get('507f191e810c19729de860ea'), 710);
  assert.deepEqual(deletedAirstrikes, ['airstrike-test-1']);

  const turretSpawnOnB = waitForEvent(playerB, 'turret:spawn');
  const turretShotOnA = waitForEvent(playerA, 'turret:shot', 3000);
  const turretPlaceAck = await emitWithAck(playerA, 'turret:place', {
    cardId: 'card-turret-zero',
    lat: origin.lat,
    lng: origin.lng,
  });
  const spawnedTurret = await turretSpawnOnB;
  assert.equal(turretPlaceAck.ok, true);
  assert.equal(turretPlaceAck.turret.alcance, 100);
  assert.equal(turretPlaceAck.turret.dano, 10);
  assert.equal(spawnedTurret.alcance, 100);
  assert.equal(spawnedTurret.dano, 10);
  assert.equal(spawnedTurret.seq, 1);
  assert.equal(spawnedTurret.renderType, 'flame_spritesheet');
  assert.equal(spawnedTurret.idleSpritesheet.loop, true);
  assert.deepEqual(spawnedTurret.imagenesMovimiento, ['/uploads/cards/turret-classic.png']);

  const turretShot = await turretShotOnA;
  assert.equal(turretShot.turretId, 'turret-test-1');
  assert.equal(turretShot.targetUserId, '507f191e810c19729de860ea');
  assert.equal(turretShot.dano, 10);
  assert.equal(spawnedTurret.idleSpritesheet.url, '/uploads/cards/turret-idle.png');

  const east30 = geo.computeOffset(origin, 30, 90);
  const ownerMoveOnB = waitForEvent(playerB, 'presence:move');
  playerA.emit('presence:update', {
    lat: east30.lat,
    lng: east30.lng,
    heading: 0,
  });
  await ownerMoveOnB;

  const turretDamageOnB = waitForEvent(playerB, 'turret:update');
  const turretHitExplosionOnB = waitForEvent(playerB, 'bullet:explode');
  const turretHitAck = await emitWithAck(playerB, 'bullet:spawn', {
    clientShotId: 'shot-b-turret',
    cardId: 'card-projectile',
    from: north20,
    heading: 180,
    speed: 180,
    alcance: 45,
    dano: 125,
    spriteUrl: 'https://example.test/bullet.png',
    explosionFrames: ['https://example.test/explosion.png'],
  });
  const [damagedTurret, turretHitExplosion] = await Promise.all([
    turretDamageOnB,
    turretHitExplosionOnB,
  ]);
  assert.equal(turretHitAck.ok, true);
  assert.equal(damagedTurret.turretId, 'turret-test-1');
  assert.equal(damagedTurret.vida, 75);
  assert.ok(damagedTurret.seq > spawnedTurret.seq);
  assert.equal(turretHitExplosion.reason, 'turret');
  assert.equal(turretHitExplosion.hitTurretId, 'turret-test-1');
  assert.ok(
    Math.abs(
      geo.distanceMeters(origin, {
        lat: turretHitExplosion.lat,
        lng: turretHitExplosion.lng,
      }) - 8
    ) < 0.3
  );

  const turretDestroyOnB = waitForEvent(playerB, 'turret:destroy');
  const turretFinalExplosionOnB = waitForEvent(playerB, 'bullet:explode');
  await emitWithAck(playerB, 'bullet:spawn', {
    clientShotId: 'shot-b-destroy-turret',
    cardId: 'card-projectile',
    from: north20,
    heading: 180,
    speed: 180,
    alcance: 45,
    dano: 125,
    spriteUrl: 'https://example.test/bullet.png',
    explosionFrames: ['https://example.test/explosion.png'],
  });
  const [destroyedTurret] = await Promise.all([
    turretDestroyOnB,
    turretFinalExplosionOnB,
  ]);
  assert.equal(destroyedTurret.reason, 'destroyed');
  assert.ok(destroyedTurret.seq > damagedTurret.seq);
  assert.equal(destroyedTurret.playDeathAnimation, true);
  assert.equal(destroyedTurret.deathSpritesheet.loop, false);

  const ownerReturnOnB = waitForEvent(playerB, 'presence:move');
  playerA.emit('presence:update', {
    lat: origin.lat,
    lng: origin.lng,
    heading: 0,
  });
  await ownerReturnOnB;

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
  assert.equal(shortSpawn.startDelayMs, 0);
  assert.equal(shortExplosion.reason, 'range');
  assert.ok(Date.now() - shortSpawnReceivedAt < 200);
  assert.ok(shortExplosion.lat < origin.lat);
  assert.ok(
    Math.abs(
      geo.distanceMeters(
        origin,
        { lat: shortExplosion.lat, lng: shortExplosion.lng }
      ) - 6
    ) < 0.25
  );

  let expiredDestroyEvents = 0;
  playerB.on('turret:destroy', (event) => {
    if (event.cardId === 'card-turret-expiring') expiredDestroyEvents++;
  });
  const expiringSpawnOnB = waitForEvent(playerB, 'turret:spawn');
  const expiredDestroyOnB = waitForEvent(playerB, 'turret:destroy', 2500);
  const expiringAck = await emitWithAck(playerA, 'turret:place', {
    cardId: 'card-turret-expiring',
    lat: origin.lat,
    lng: origin.lng,
  });
  const [expiringSpawn, expiredTurret] = await Promise.all([
    expiringSpawnOnB,
    expiredDestroyOnB,
  ]);
  assert.equal(expiringAck.ok, true);
  assert.equal(expiringSpawn.renderType, 'flame_spritesheet');
  assert.equal(expiredTurret.reason, 'expired');
  assert.equal(expiredTurret.playDeathAnimation, false);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(expiredDestroyEvents, 1);

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
    nickname: 'Bob',
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

test('ufo starts after client home opens, is shared and awards its killer', async (t) => {
  const awarded = new Map();
  const fakeLifeModel = {
    findOne() {
      return { lean: async () => null };
    },
    async updateOne() {},
  };
  const fakeCardModel = {
    findById() {
      return {
        lean: async () => ({
          _id: 'card-ufo',
          tipoArma: 'Proyectil',
          alcance: 350,
          dano: 60,
          tiempoEspera: 0,
        }),
      };
    },
  };
  const fakeTurretModel = {
    find() {
      return { lean: async () => [] };
    },
    async updateOne() {},
    async deleteOne() {},
  };
  const fakeMineModel = {
    find() {
      return { lean: async () => [] };
    },
    async deleteOne() {},
  };
  const fakeAirstrikeModel = {
    find() {
      return { lean: async () => [] };
    },
    async updateOne() {},
    async deleteOne() {},
  };
  const fakeUserModel = {
    findById(id) {
      const query = {
        select: () => query,
        lean: async () => ({ _id: String(id), gameModeEnabled: true }),
      };
      return query;
    },
    findOneAndUpdate() {
      return { lean: async () => null };
    },
    async updateOne({ _id }, update) {
      awarded.set(_id, (awarded.get(_id) || 0) + (update.$inc?.stepcoins || 0));
    },
  };
  const fakeUfoModel = {
    find() {
      return {
        lean: async () => [{
          _id: 'ufo-shared',
          nombre: 'OVNI compartido',
          imagenOvni: '/uploads/ufo/ufo.webp',
          imagenBala: '/uploads/ufo/bullet.webp',
          vida: 50,
          velocidadBala: 100,
          velocidadMovimiento: 1,
          tiempoAparicion: 0.1,
          duracionPantalla: 10,
          stepcoinsPremio: 77,
          segundosEntreDisparos: 3,
          danoBala: 10,
        }],
      };
    },
  };

  const httpServer = http.createServer();
  const io = new Server(httpServer, { transports: ['websocket'] });
  registerPvp(io, {
    CardModel: fakeCardModel,
    LifeModel: fakeLifeModel,
    TurretModel: fakeTurretModel,
    MineModel: fakeMineModel,
    AirstrikeModel: fakeAirstrikeModel,
    UserModel: fakeUserModel,
    UfoModel: fakeUfoModel,
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}`;
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    await new Promise((resolve) => io.close(resolve));
    if (httpServer.listening) {
      await new Promise((resolve) => httpServer.close(resolve));
    }
  });

  const origin = { lat: 41.65671, lng: -0.8785 };
  const observerPosition = geo.computeOffset(origin, 300, 90);
  const shooter = await connectClient(url);
  const observer = await connectClient(url);
  sockets.push(shooter, observer);
  const ufoOnShooter = waitForEvent(shooter, 'ufo:spawn');
  const ufoOnObserver = waitForEvent(observer, 'ufo:spawn');
  await emitWithAck(shooter, 'presence:hello', {
    userId: '507f1f77bcf86cd799439011',
    ...origin,
  });
  await emitWithAck(observer, 'presence:hello', {
    userId: '507f191e810c19729de860ea',
    ...observerPosition,
  });

  const [spawnedForShooter, spawnedForObserver] = await Promise.all([
    ufoOnShooter,
    ufoOnObserver,
  ]);
  assert.deepEqual(spawnedForShooter, spawnedForObserver);
  assert.equal(spawnedForShooter.ufoId, 'ufo-shared');

  const toRadians = (value) => value * Math.PI / 180;
  const lat1 = toRadians(origin.lat);
  const lat2 = toRadians(spawnedForShooter.lat);
  const deltaLng = toRadians(spawnedForShooter.lng - origin.lng);
  const heading = (
    Math.atan2(
      Math.sin(deltaLng) * Math.cos(lat2),
      Math.cos(lat1) * Math.sin(lat2) -
        Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng)
    ) * 180 / Math.PI + 360
  ) % 360;
  const ufoDistance = geo.distanceMeters(origin, {
    lat: spawnedForShooter.lat,
    lng: spawnedForShooter.lng,
  });
  assert.ok(ufoDistance >= 150 && ufoDistance <= 260);
  const destroyOnShooter = waitForEvent(shooter, 'ufo:destroy');
  const destroyOnObserver = waitForEvent(observer, 'ufo:destroy');
  const explosionOnShooter = waitForEvent(shooter, 'bullet:explode');
  const killAck = await emitWithAck(shooter, 'bullet:spawn', {
    clientShotId: 'ufo-kill-shot',
    cardId: 'card-ufo',
    from: origin,
    heading,
    speed: 180,
    alcance: 350,
    dano: 60,
    spriteUrl: '/uploads/cards/bullet.webp',
    explosionFrames: ['/uploads/cards/explosion.webp'],
  });
  const [destroyed, destroyedForObserver, explosion] = await Promise.all([
    destroyOnShooter,
    destroyOnObserver,
    explosionOnShooter,
  ]);
  assert.equal(killAck.ok, true);
  assert.deepEqual(destroyed, destroyedForObserver);
  assert.equal(destroyed.ufoId, 'ufo-shared');
  assert.equal(destroyed.winnerUserId, '507f1f77bcf86cd799439011');
  assert.equal(destroyed.stepcoinsPremio, 77);
  assert.equal(explosion.reason, 'ufo');
  assert.equal(explosion.hitUfoId, 'ufo-shared');
  assert.equal(awarded.get('507f1f77bcf86cd799439011'), 77);
});

test('shared clan protects immediately and damage resumes after last shared clan is left', async (t) => {
  const lifeByUser = new Map();
  let sharedClan = true;
  let persistedDamage = 0;
  let bountyClaims = 0;
  const fakeLifeModel = {
    findOne({ userId }) {
      return { lean: async () => ({ vida: lifeByUser.get(String(userId)) ?? 1000 }) };
    },
    async updateOne({ userId }, update) {
      persistedDamage++;
      lifeByUser.set(String(userId), update.$set.vida);
    },
  };
  const fakeCardModel = {
    findById() {
      return {
        lean: async () => ({
          _id: 'card-projectile',
          tipoArma: 'Proyectil',
          alcance: 100,
          dano: 100,
          tiempoEspera: 0,
        }),
      };
    },
  };
  const emptyPersistentModel = {
    find() { return { lean: async () => [] }; },
    async updateOne() {},
    async deleteOne() {},
  };
  const fakeUserModel = {
    findById(id) {
      const query = {
        select: () => query,
        lean: async () => ({ _id: String(id), gameModeEnabled: true }),
      };
      return query;
    },
    findOneAndUpdate() { return { lean: async () => null }; },
    async updateOne() {},
  };
  const fakeUfoModel = { find() { return { lean: async () => [] }; } };
  const fakeClanMembershipService = {
    getClanIds: async () => new Set(sharedClan ? ['clan-shared'] : []),
    shareActiveClan: async () => sharedClan,
    events: { on() {} },
  };
  const fakeBountyService = {
    totalForTarget: async () => 0,
    claimForKill: async () => {
      bountyClaims++;
      return { paid: 0, claimed: 0 };
    },
  };

  const httpServer = http.createServer();
  const io = new Server(httpServer, { transports: ['websocket'] });
  registerPvp(io, {
    CardModel: fakeCardModel,
    LifeModel: fakeLifeModel,
    TurretModel: emptyPersistentModel,
    MineModel: emptyPersistentModel,
    AirstrikeModel: emptyPersistentModel,
    UserModel: fakeUserModel,
    UfoModel: fakeUfoModel,
    ClanMembershipService: fakeClanMembershipService,
    BountyService: fakeBountyService,
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}`;
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    await new Promise((resolve) => io.close(resolve));
    if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));
  });

  const origin = { lat: 41.65671, lng: -0.8785 };
  const targetPosition = geo.computeOffset(origin, 60, 0);
  const attacker = await connectClient(url);
  const target = await connectClient(url);
  sockets.push(attacker, target);
  await emitWithAck(attacker, 'presence:hello', {
    userId: '507f1f77bcf86cd799439011',
    ...origin,
  });
  await emitWithAck(target, 'presence:hello', {
    userId: '507f191e810c19729de860ea',
    ...targetPosition,
  });

  let lifeUpdates = 0;
  target.on('life:update', () => lifeUpdates++);
  const protectedEvent = waitForEvent(target, 'life:protected');
  const protectedExplosion = waitForEvent(target, 'bullet:explode');
  await emitWithAck(attacker, 'bullet:spawn', {
    clientShotId: 'protected-shot',
    cardId: 'card-projectile',
    from: origin,
    heading: 0,
    speed: 180,
    alcance: 100,
    dano: 100,
    spriteUrl: '',
    explosionFrames: [],
  });
  const [protection, explosion] = await Promise.all([protectedEvent, protectedExplosion]);
  assert.equal(protection.targetUserId, '507f191e810c19729de860ea');
  assert.equal(explosion.reason, 'protected');
  assert.equal(persistedDamage, 0);
  assert.equal(lifeUpdates, 0);
  assert.equal(bountyClaims, 0);

  sharedClan = false;
  const lifeUpdate = waitForEvent(target, 'life:update');
  await emitWithAck(attacker, 'bullet:spawn', {
    clientShotId: 'unprotected-shot',
    cardId: 'card-projectile',
    from: origin,
    heading: 0,
    speed: 180,
    alcance: 100,
    dano: 100,
    spriteUrl: '',
    explosionFrames: [],
  });
  const damage = await lifeUpdate;
  assert.equal(damage.vida, 900);
  assert.equal(persistedDamage, 1);
});

test('PVP socket rejects missing tokens and manipulated presence identities', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'pvp-test-secret';
  const fakeLifeModel = {
    findOne() { return { lean: async () => ({ vida: 1000 }) }; },
    async updateOne() {},
  };
  const emptyPersistentModel = {
    find() { return { lean: async () => [] }; },
    async updateOne() {},
    async deleteOne() {},
  };
  let authoritativeNickname = 'Alice';
  const disabledGameModeUserId = '507f191e810c19729de860ec';
  let authoritativeSkin = {
    _id: '68a000000000000000000001',
    renderType: 'classic',
    renderVersion: 1,
    scripts: { parado: ['/uploads/skins/classic.png'] },
    spritesheets: {},
  };
  const fakeUserModel = {
    findById(userId) {
      const query = {
        select() { return query; },
        populate() { return query; },
        lean: async () => ({
          _id: userId,
          nickname: authoritativeNickname,
          skinSeleccionada: authoritativeSkin,
          gameModeEnabled: String(userId) !== disabledGameModeUserId,
        }),
      };
      return query;
    },
    findOneAndUpdate() { return { lean: async () => null }; },
    async updateOne() {},
  };
  const httpServer = http.createServer();
  const io = new Server(httpServer, { transports: ['websocket'] });
  registerPvp(io, {
    requireAuth: true,
    resolveAuthToken: async (token) => {
      if (token === 'firebase-id-token') {
        return {
          id: '507f1f77bcf86cd799439011',
          role: 'cliente',
          authType: 'firebase',
        };
      }
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      return { id: decoded.id, role: 'cliente', authType: 'test' };
    },
    CardModel: { findById() { return { lean: async () => null }; } },
    LifeModel: fakeLifeModel,
    TurretModel: emptyPersistentModel,
    MineModel: emptyPersistentModel,
    AirstrikeModel: emptyPersistentModel,
    UserModel: fakeUserModel,
    UfoModel: { find() { return { lean: async () => [] }; } },
    ClanMembershipService: {
      getClanIds: async () => new Set(),
      shareActiveClan: async () => false,
      events: { on() {} },
    },
    BountyService: {
      totalForTarget: async () => 0,
      claimForKill: async () => ({ paid: 0 }),
    },
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}`;
  const sockets = [];
  t.after(async () => {
    if (previousSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    for (const socket of sockets) socket.disconnect();
    await new Promise((resolve) => io.close(resolve));
    if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));
  });

  const missingTokenError = await new Promise((resolve) => {
    const socket = createClient(`${url}/pvp`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    sockets.push(socket);
    socket.once('connect_error', resolve);
  });
  assert.match(missingTokenError.message, /token/i);

  const authenticatedUserId = '507f1f77bcf86cd799439011';
  const token = 'firebase-id-token';
  const socket = await new Promise((resolve, reject) => {
    const client = createClient(`${url}/pvp`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { token },
    });
    sockets.push(client);
    client.once('connect', () => resolve(client));
    client.once('connect_error', reject);
  });
  const rejected = await emitWithAck(socket, 'presence:hello', {
    userId: '507f191e810c19729de860ea',
    lat: 41.65671,
    lng: -0.8785,
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /token/i);

  const observerId = '507f191e810c19729de860ea';
  const observerToken = jwt.sign({ id: observerId, role: 'cliente' }, process.env.JWT_SECRET);
  const observer = await new Promise((resolve, reject) => {
    const client = createClient(`${url}/pvp`, {
      transports: ['websocket'], forceNew: true, reconnection: false,
      auth: { token: observerToken },
    });
    sockets.push(client);
    client.once('connect', () => resolve(client));
    client.once('connect_error', reject);
  });
  await emitWithAck(observer, 'presence:hello', {
    userId: observerId, lat: 41.65671, lng: -0.8785,
  });

  const spawn = waitForEvent(observer, 'presence:spawn');
  const accepted = await emitWithAck(socket, 'presence:hello', {
    userId: authenticatedUserId,
    lat: 41.65671,
    lng: -0.8785,
    nickname: 'NombreFalsificado',
  });
  assert.equal(accepted.ok, true);
  const spawnedPlayer = await spawn;
  assert.equal(spawnedPlayer.nickname, 'Alice', 'server ignores the client nickname');
  assert.equal(spawnedPlayer.skinUrl, '/uploads/skins/classic.png');

  authoritativeSkin = {
    _id: '68a000000000000000000002',
    renderType: 'flame_spritesheet',
    renderVersion: 2,
    scripts: {},
    spritesheets: {
      idle: {
        url: '/uploads/skins/idle.png',
        columns: 4,
        rows: 1,
        frames: 4,
        fps: 8,
        loop: true,
      },
    },
  };
  const skinUpdate = waitForEvent(observer, 'presence:skin');
  socket.emit('presence:update', {
    lat: 41.65671,
    lng: -0.8785,
    heading: 90,
    skinId: authoritativeSkin._id,
    skinUrl: '',
  });
  const changedSkin = await skinUpdate;
  assert.equal(changedSkin.skinUrl, '');
  assert.equal(changedSkin.skinId, authoritativeSkin._id);
  assert.equal(changedSkin.skinDefinition.renderType, 'flame_spritesheet');
  assert.equal(changedSkin.skinDefinition.spritesheets.idle.columns, 4);

  const identityUpdate = waitForEvent(observer, 'presence:identity');
  socialRealtime.nicknameChanged(authenticatedUserId, 'AliceNueva');
  assert.deepEqual(await identityUpdate, {
    userId: authenticatedUserId,
    nickname: 'AliceNueva',
  });

  const disabledToken = jwt.sign(
    { id: disabledGameModeUserId, role: 'cliente' },
    process.env.JWT_SECRET,
  );
  const disabledSocket = await new Promise((resolve, reject) => {
    const client = createClient(`${url}/pvp`, {
      transports: ['websocket'], forceNew: true, reconnection: false,
      auth: { token: disabledToken },
    });
    sockets.push(client);
    client.once('connect', () => resolve(client));
    client.once('connect_error', reject);
  });
  const disabledPresence = await emitWithAck(disabledSocket, 'presence:hello', {
    userId: disabledGameModeUserId, lat: 41.65671, lng: -0.8785,
  });
  assert.equal(disabledPresence.ok, false);
  assert.equal(disabledPresence.code, 'GAME_MODE_DISABLED');

  authoritativeNickname = '';
  const pendingId = '507f191e810c19729de860eb';
  const pendingToken = jwt.sign({ id: pendingId, role: 'cliente' }, process.env.JWT_SECRET);
  const pendingSocket = await new Promise((resolve, reject) => {
    const client = createClient(`${url}/pvp`, {
      transports: ['websocket'], forceNew: true, reconnection: false,
      auth: { token: pendingToken },
    });
    sockets.push(client);
    client.once('connect', () => resolve(client));
    client.once('connect_error', reject);
  });
  const pendingPresence = await emitWithAck(pendingSocket, 'presence:hello', {
    userId: pendingId, lat: 41.65671, lng: -0.8785,
  });
  assert.equal(pendingPresence.ok, false);
  assert.equal(pendingPresence.code, 'NICKNAME_REQUIRED');
});
