// sockets/pvp.socket.js
const geo  = require('../utils/geo');              // <- OK si utils está en la raíz del repo
const Card = require('../api/models/Card');
const UserLife = require('../api/models/UserLife');

module.exports = function(io, dependencies = {}) {
  const CardModel = dependencies.CardModel || Card;
  const LifeModel = dependencies.LifeModel || UserLife;
  const nsp = io.of('/pvp');
  const instanceId =
    process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || `pid-${process.pid}`;

  // Estado en memoria (MVP)
  const players = new Map(); // socketId -> { userId, lat, lng, heading, skinUrl, nombre, zoneId, lastShotByCard:{}, vida }
  const bullets = new Map(); // bulletId -> { byUserId, zoneId, lat, lng, heading, speed, alcance, dano, spriteUrl, createdAt }
  const roomIndex = new Map(); // zoneId -> Set<socketId>

  const log = (message, details = {}) => {
    console.log(`[PVP][${instanceId}] ${message}`, details);
  };

  const playersForUser = (userId) =>
    [...players.values()].filter((player) => player.userId === userId);

  // Tick de balas (server-authoritative)
  const TICK_MS = 50;
  const BULLET_START_DELAY_MS = 180;
  const PLAYER_HIT_RADIUS_M = 8;

  // Devuelve el primer punto en el que el segmento de la bala entra en el
  // radio del jugador. La aproximación plana es precisa para estos recorridos
  // cortos y evita saltarse skins entre ticks.
  const segmentCircleIntersection = (from, to, center, radiusM) => {
    const meanLatRad = ((from.lat + to.lat + center.lat) / 3) * Math.PI / 180;
    const metersPerDegreeLat = 111320;
    const metersPerDegreeLng = metersPerDegreeLat * Math.cos(meanLatRad);
    const segmentX = (to.lng - from.lng) * metersPerDegreeLng;
    const segmentY = (to.lat - from.lat) * metersPerDegreeLat;
    const centerX = (center.lng - from.lng) * metersPerDegreeLng;
    const centerY = (center.lat - from.lat) * metersPerDegreeLat;
    const a = segmentX * segmentX + segmentY * segmentY;
    const c = centerX * centerX + centerY * centerY - radiusM * radiusM;

    if (c <= 0) return { lat: from.lat, lng: from.lng, t: 0 };
    if (a === 0) return null;

    const b = -2 * (segmentX * centerX + segmentY * centerY);
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return null;

    const t = (-b - Math.sqrt(discriminant)) / (2 * a);
    if (t < 0 || t > 1) return null;
    return {
      lat: from.lat + (to.lat - from.lat) * t,
      lng: from.lng + (to.lng - from.lng) * t,
      t,
    };
  };

  const emitBulletExplosion = (bulletId, bullet, reason, hitUserId = null) => {
    nsp.to(bullet.zoneId).emit('bullet:explode', {
      bulletId,
      clientShotId: bullet.clientShotId,
      byUserId: bullet.byUserId,
      hitUserId,
      reason,
      lat: bullet.lat,
      lng: bullet.lng,
      spriteUrl: bullet.spriteUrl,
      explosionFrames: bullet.explosionFrames,
    });
  };

  const bulletTimer = setInterval(() => {
    for (const [id, b] of bullets) {
      if (Date.now() < b.startsAt) continue;

      const previous = { lat: b.lat, lng: b.lng };
      const remainingM = Math.max(0, b.alcance - (b.recorrido || 0));
      const stepM = Math.min(b.speed * (TICK_MS / 1000), remainingM);
      const next = geo.computeOffset(previous, stepM, b.heading);

      // colisiones con jugadores de su sala
      const socketsInZone = roomIndex.get(b.zoneId) || new Set();
      let hit = false;
      for (const sid of socketsInZone) {
        const p = players.get(sid);
        if (!p || p.userId === b.byUserId) continue;

        const impact = segmentCircleIntersection(
          previous,
          next,
          { lat: p.lat, lng: p.lng },
          PLAYER_HIT_RADIUS_M
        );
        if (impact) {
          b.lat = impact.lat;
          b.lng = impact.lng;
          b.recorrido = (b.recorrido || 0) + stepM * impact.t;
          const dist = geo.distanceMeters(
            { lat: b.lat, lng: b.lng },
            { lat: p.lat, lng: p.lng }
          );
          const nuevaVida = Math.max(0, (p.vida ?? 1000) - b.dano);
          for (const sameUser of playersForUser(p.userId)) {
            sameUser.vida = nuevaVida;
          }
          LifeModel.updateOne(
            { userId: p.userId },
            { $set: { vida: nuevaVida }, $setOnInsert: { yaPenalizado: false } },
            { upsert: true }
          ).catch((error) => {
            console.error(`[PVP][${instanceId}] life persist error`, {
              bulletId: id,
              userId: p.userId,
              error: error.message,
            });
          });

          nsp.to(b.zoneId).emit('life:update', {
            bulletId: id,
            byUserId: b.byUserId,
            userId: p.userId,
            vida: nuevaVida,
            dano: b.dano,
          });
          emitBulletExplosion(id, b, 'hit', p.userId);
          bullets.delete(id);
          hit = true;
          log('bullet hit', {
            bulletId: id,
            clientShotId: b.clientShotId,
            byUserId: b.byUserId,
            hitUserId: p.userId,
            damage: b.dano,
            life: nuevaVida,
            distanceMeters: Number(dist.toFixed(2)),
            hitRadiusMeters: PLAYER_HIT_RADIUS_M,
            traveledMeters: Number(b.recorrido.toFixed(2)),
          });
          break;
        }
      }
      if (hit) continue;

      b.lat = next.lat;
      b.lng = next.lng;
      b.recorrido = (b.recorrido || 0) + stepM;

      // fin de alcance
      if ((b.recorrido || 0) >= b.alcance) {
        emitBulletExplosion(id, b, 'range');
        bullets.delete(id);
        log('bullet range completed', {
          bulletId: id,
          clientShotId: b.clientShotId,
          byUserId: b.byUserId,
          alcance: b.alcance,
        });
      }
    }
  }, TICK_MS);
  bulletTimer.unref?.();

  // Helpers
  function toZoneId(lat, lng) {
    // Celda ~120 m. Ajusta DECIMALES para agrupar menos/más jugadores.
    return 'GLOBAL_TEST_ROOM';
  }

  // Validar spawn de bala contra su carta (anti-cheat)
  async function validateBullet(byUserId, cardId, intento) {
    const card = await CardModel.findById(cardId).lean();
    if (!card) throw new Error('Carta no existe');
    if (card.tipoArma !== 'Proyectil') throw new Error('Carta no es Proyectil');

    // Alcance / Daño / Velocidad máximos
    if (intento.alcance > (card.alcance||0) + 5) throw new Error('Alcance inválido');
    if (intento.dano    > (card.dano||0) + 1)    throw new Error('Daño inválido');
    if (intento.speed   > 180)                   throw new Error('Velocidad inválida'); // cap servidor

    // Cooldown por carta
    const shooter = [...players.values()].find(p => p.userId === byUserId);
    const cd = (card.tiempoEspera||0) * 1000;
    const lastMap = shooter?.lastShotByCard || {};
    const last = lastMap[cardId] || 0;
    if (Date.now() - last < cd) throw new Error('Cooldown');

    if (shooter) {
      shooter.lastShotByCard = { ...lastMap, [cardId]: Date.now() };
    }
    return {
      alcance: card.alcance || 0,
      dano: card.dano || 0,
      cooldownMs: cd,
    };
  }

  nsp.on('connection', (socket) => {
    log('socket connected', {
      socketId: socket.id,
      namespace: '/pvp',
      totalSockets: nsp.sockets.size,
    });
    // 1) Spawn/presencia inicial
    socket.on('presence:hello', async (payload, cb) => {
      try {
        const {
          userId: rawUserId,
          lat,
          lng,
          heading,
          skinUrl = '',
          nombre = 'Jugador',
        } = payload || {};
        const userId = rawUserId?.toString().trim();
        if (!userId || typeof lat!=='number' || typeof lng!=='number') {
          log('presence rejected', {
            socketId: socket.id,
            userId,
            lat,
            lng,
            error: 'payload inválido',
          });
          return cb?.({ ok:false, error:'payload inválido' });
        }

        const zoneId = toZoneId(lat, lng);
        const previous = players.get(socket.id);
        if (previous) {
          socket.leave(previous.zoneId);
          roomIndex.get(previous.zoneId)?.delete(socket.id);
        }
        socket.join(zoneId);
        if (!roomIndex.has(zoneId)) roomIndex.set(zoneId, new Set());
        roomIndex.get(zoneId).add(socket.id);

        const lifeDoc = await LifeModel.findOne({ userId }).lean().catch((error) => {
          console.error(`[PVP][${instanceId}] life read error`, {
            socketId: socket.id,
            userId,
            error: error.message,
          });
          return null;
        });
        const vida = lifeDoc?.vida ?? 1000;

        players.set(socket.id, {
          userId,
          lat,
          lng,
          heading: typeof heading === 'number' ? heading : 0,
          skinUrl,
          nombre,
          zoneId,
          lastShotByCard: previous?.lastShotByCard || {},
          vida,
        });

        // Enviar al que entra el estado de la sala (jugadores ya presentes)
        const othersByUserId = new Map();
        for (const sid of roomIndex.get(zoneId)) {
          if (sid === socket.id) continue;
          const p = players.get(sid);
          if (p && p.userId !== userId) {
            othersByUserId.set(p.userId, {
              userId:p.userId,
              lat:p.lat,
              lng:p.lng,
              heading:p.heading,
              skinUrl:p.skinUrl,
              nombre:p.nombre,
              vida:p.vida??1000,
            });
          }
        }
        const others = [...othersByUserId.values()];
        cb?.({ ok:true, players: others, instanceId });
        log('presence registered', {
          socketId: socket.id,
          userId,
          zoneId,
          lat,
          lng,
          skinUrl,
          nombre,
          vida,
          roomSockets: roomIndex.get(zoneId).size,
          playersReturned: others.map((p) => p.userId),
        });

        // Notificar a los demás tu spawn
        socket.to(zoneId).emit('presence:spawn', { userId, lat, lng, heading, skinUrl, nombre, vida });
      } catch (e) {
        console.error(`[PVP][${instanceId}] presence hello error`, {
          socketId: socket.id,
          error: e.message,
        });
        cb?.({ ok:false, error: e.message });
      }
    });

    // 2) Movimiento/presencia contínua
    socket.on('presence:update', (payload) => {
      const p = players.get(socket.id);
      if (!p) return;

      const { lat, lng, heading } = payload || {};
      if (typeof lat!=='number' || typeof lng!=='number') return;

      const newZone = toZoneId(lat, lng);
      if (newZone !== p.zoneId) {
        socket.leave(p.zoneId);
        roomIndex.get(p.zoneId)?.delete(socket.id);

        socket.join(newZone);
        if (!roomIndex.has(newZone)) roomIndex.set(newZone, new Set());
        roomIndex.get(newZone).add(socket.id);

        p.zoneId = newZone;
      }

      p.lat = lat;
      p.lng = lng;
      if (typeof heading === 'number') p.heading = heading;
      nsp.to(p.zoneId).emit('presence:move', {
        userId: p.userId,
        lat,
        lng,
        heading: p.heading,
        skinUrl: p.skinUrl,
        nombre: p.nombre,
        vida: p.vida,
      });
      log('presence move', {
        socketId: socket.id,
        userId: p.userId,
        lat,
        lng,
        heading: p.heading,
      });
    });

    // 3) Disparo
    socket.on('bullet:spawn', async (payload, cb) => {
      try {
        const p = players.get(socket.id);
        if (!p) throw new Error('No player');

        const {
          clientShotId,
          cardId,
          from,
          heading,
          speed,
          alcance,
          dano,
          spriteUrl,
          explosionFrames,
        } = payload || {};
        if (
          !cardId ||
          !from ||
          typeof from.lat !== 'number' ||
          typeof from.lng !== 'number' ||
          typeof heading !== 'number' ||
          typeof speed !== 'number' ||
          typeof alcance !== 'number' ||
          typeof dano !== 'number'
        ) {
          throw new Error('Payload de bala inválido');
        }
        // Rango de spawn razonable (anti-teleport del origen)
        if (geo.distanceMeters({lat:p.lat,lng:p.lng}, from) > 25) throw new Error('Origen inválido');

        const validated = await validateBullet(p.userId, cardId, {
          alcance,
          dano,
          speed,
        });

        // Crear bala server-side
        const bulletId = `${p.userId}-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
        const authoritativeFrom = { lat: p.lat, lng: p.lng };
        const authoritativeHeading = ((heading % 360) + 360) % 360;
        const authoritativeSpeed = Math.min(Math.max(speed, 0), 180);
        const normalizedExplosionFrames = Array.isArray(explosionFrames)
          ? explosionFrames.filter((frame) => typeof frame === 'string' && frame.trim())
          : [];
        bullets.set(bulletId, {
          clientShotId,
          byUserId: p.userId,
          zoneId: p.zoneId,
          lat: authoritativeFrom.lat,
          lng: authoritativeFrom.lng,
          heading: authoritativeHeading,
          speed: authoritativeSpeed,
          alcance: validated.alcance,
          dano: validated.dano,
          spriteUrl,
          explosionFrames: normalizedExplosionFrames,
          createdAt: Date.now(),
          startsAt: Date.now() + BULLET_START_DELAY_MS,
        });

        // Avisar a la sala para que los clientes la dibujen en local
        nsp.to(p.zoneId).emit('bullet:spawn', {
          bulletId, byUserId: p.userId,
          clientShotId,
          from: authoritativeFrom,
          heading: authoritativeHeading,
          speed: authoritativeSpeed,
          alcance: validated.alcance,
          dano: validated.dano,
          spriteUrl,
          explosionFrames: normalizedExplosionFrames,
          startDelayMs: BULLET_START_DELAY_MS,
        });

        cb?.({
          ok:true,
          bulletId,
          clientShotId,
          alcance: validated.alcance,
          dano: validated.dano,
          startDelayMs: BULLET_START_DELAY_MS,
        });
        log('bullet spawned', {
          socketId: socket.id,
          bulletId,
          clientShotId,
          byUserId: p.userId,
          from: authoritativeFrom,
          heading: authoritativeHeading,
          speed: authoritativeSpeed,
          alcance: validated.alcance,
          dano: validated.dano,
          startDelayMs: BULLET_START_DELAY_MS,
        });
      } catch (e) {
        console.error(`[PVP][${instanceId}] bullet rejected`, {
          socketId: socket.id,
          userId: players.get(socket.id)?.userId,
          clientShotId: payload?.clientShotId,
          error: e.message,
        });
        cb?.({ ok:false, error: e.message });
      }
    });

    // 4) Desconexión
    socket.on('disconnect', (reason) => {
      const p = players.get(socket.id);
      if (!p) {
        log('socket disconnected before presence', {
          socketId: socket.id,
          reason,
        });
        return;
      }

      roomIndex.get(p.zoneId)?.delete(socket.id);
      players.delete(socket.id);
      const stillConnected = playersForUser(p.userId).length > 0;
      if (!stillConnected) {
        nsp.to(p.zoneId).emit('presence:leave', { userId: p.userId });
      }
      if (roomIndex.get(p.zoneId)?.size === 0) {
        roomIndex.delete(p.zoneId);
      }
      log('socket disconnected', {
        socketId: socket.id,
        userId: p.userId,
        reason,
        leaveEmitted: !stillConnected,
        remainingPlayers: players.size,
      });
    });
  });
};
