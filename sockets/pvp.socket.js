// sockets/pvp.socket.js
const geo  = require('../utils/geo');              // <- OK si utils está en la raíz del repo
const Card = require('../api/models/Card');
const UserLife = require('../api/models/UserLife');
const Turret = require('../api/models/Turret');
const Mine = require('../api/models/Mine');
const Airstrike = require('../api/models/Airstrike');
const User = require('../api/models/User');
const Ufo = require('../api/models/Ufo');

module.exports = function(io, dependencies = {}) {
  const CardModel = dependencies.CardModel || Card;
  const LifeModel = dependencies.LifeModel || UserLife;
  const TurretModel = dependencies.TurretModel || Turret;
  const MineModel = dependencies.MineModel || Mine;
  const AirstrikeModel = dependencies.AirstrikeModel || Airstrike;
  const UserModel = dependencies.UserModel || User;
  const UfoModel = dependencies.UfoModel || Ufo;
  const nsp = io.of('/pvp');
  const instanceId =
    process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || `pid-${process.pid}`;

  // Estado en memoria (MVP)
  const players = new Map(); // socketId -> { userId, lat, lng, heading, skinUrl, nombre, zoneId, lastShotByCard:{}, vida }
  const bullets = new Map(); // bulletId -> { byUserId, zoneId, lat, lng, heading, speed, alcance, dano, spriteUrl, createdAt }
  const roomIndex = new Map(); // zoneId -> Set<socketId>
  const turrets = new Map();
  const mines = new Map();
  const airstrikes = new Map();
  const activeUfos = new Map();
  const scheduledUfoZones = new Set();
  const pendingUfoTimers = new Map();
  const TURRET_BULLET_SPEED = 80;
  const DEFAULT_TURRET_RANGE_M = 100;
  const DEFAULT_TURRET_DAMAGE = 10;
  const MAX_PLAYER_LIFE = 1000;
  const normalizeTurretCombatStats = (turret) => {
    const alcance = Number(turret.alcance);
    const dano = Number(turret.dano);
    turret.alcance = Number.isFinite(alcance) && alcance > 0
      ? alcance
      : DEFAULT_TURRET_RANGE_M;
    turret.dano = Number.isFinite(dano) && dano > 0
      ? dano
      : DEFAULT_TURRET_DAMAGE;
    return turret;
  };
  const turretPayload = (t) => ({
    turretId: String(t._id), ownerUserId: String(t.ownerUserId), cardId: String(t.cardId),
    lat: t.lat, lng: t.lng, vida: t.vida, vidaMaxima: t.vidaMaxima,
    alcance: t.alcance, dano: t.dano, cadenciaDisparo: t.cadenciaDisparo,
    expiresAt: new Date(t.expiresAt).toISOString(),
    imagenesMovimiento: t.imagenesMovimiento || [], imagenesDisparo: t.imagenesDisparo || [],
    imagenesMuerte: t.imagenesMuerte || [],
  });
  const minePayload = (mine) => ({
    mineId: String(mine._id),
    ownerUserId: String(mine.ownerUserId),
    cardId: String(mine.cardId),
    lat: mine.lat,
    lng: mine.lng,
    radioActivacion: mine.radioActivacion,
    dano: mine.dano,
    usoUnico: mine.usoUnico !== false,
    expiresAt: new Date(mine.expiresAt).toISOString(),
    imagenMapa: mine.imagenesActivacion?.[0] || '',
    imagenesActivacion: mine.imagenesActivacion || [],
    imagenesExplosion: mine.imagenesExplosion || [],
  });
  const airstrikePayload = (airstrike) => {
    const target = { lat: airstrike.lat, lng: airstrike.lng };
    const from = geo.computeOffset(
      target,
      250,
      (airstrike.heading + 180) % 360
    );
    const to = geo.computeOffset(target, 250, airstrike.heading);
    return {
      airstrikeId: String(airstrike._id),
      ownerUserId: String(airstrike.ownerUserId),
      cardId: String(airstrike.cardId),
      lat: airstrike.lat,
      lng: airstrike.lng,
      radioExplosion: airstrike.radioExplosion,
      dano: airstrike.dano,
      attackAt: new Date(airstrike.attackAt).toISOString(),
      impactAt: new Date(airstrike.impactAt).toISOString(),
      launched: airstrike.launched === true,
      heading: airstrike.heading,
      from,
      to,
      planeDurationMs: 6000,
      bombDropDelayMs: 4000,
      bombDurationMs: 2000,
      imagenesAvion: airstrike.imagenesAvion || [],
      imagenesBomba: airstrike.imagenesBomba || [],
      imagenesExplosion: airstrike.imagenesExplosion || [],
    };
  };
  const turretsReady = TurretModel.find({ expiresAt: { $gt: new Date() }, vida: { $gt: 0 } }).lean()
    .then((items) => items.forEach((t) => {
      normalizeTurretCombatStats(t);
      turrets.set(String(t._id), t);
    }))
    .catch((error) => console.error('[PVP] turret restore error', error));
  const minesReady = MineModel.find({ expiresAt: { $gt: new Date() } }).lean()
    .then((items) => items.forEach((mine) => {
      mine.playersInside = new Set();
      mines.set(String(mine._id), mine);
    }))
    .catch((error) => console.error('[PVP] mine restore error', error));
  const airstrikesReady = AirstrikeModel.find({
    impactAt: { $gt: new Date() },
  }).lean()
    .then((items) => items.forEach((airstrike) => {
      airstrikes.set(String(airstrike._id), airstrike);
    }))
    .catch((error) => console.error('[PVP] airstrike restore error', error));

  const log = (message, details = {}) => {
    console.log(`[PVP][${instanceId}] ${message}`, details);
  };

  const playersForUser = (userId) =>
    [...players.values()].filter((player) => player.userId === userId);

  // Tick de balas (server-authoritative)
  const TICK_MS = 50;
  const BULLET_START_DELAY_MS = 180;
  const PLAYER_HIT_RADIUS_M = 8;
  // El icono del OVNI se dibuja a 180 px y ocupa bastante más superficie
  // visual que un jugador. Un radio propio evita que un disparo que lo roza
  // claramente en pantalla se considere un fallo en el servidor.
  const UFO_HIT_RADIUS_M = 60;
  const UFO_MIN_DISTANCE_M = 500;
  const UFO_MAX_DISTANCE_M = 800;

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

  const bearingDegrees = (from, to) => {
    const lat1 = from.lat * Math.PI / 180;
    const lat2 = to.lat * Math.PI / 180;
    const deltaLng = (to.lng - from.lng) * Math.PI / 180;
    const y = Math.sin(deltaLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  };

  const emitBulletExplosion = (bulletId, bullet, reason, hit = {}) => {
    nsp.to(bullet.zoneId).emit('bullet:explode', {
      bulletId,
      clientShotId: bullet.clientShotId,
      byUserId: bullet.byUserId,
      hitUserId: hit.userId || null,
      hitTurretId: hit.turretId || null,
      hitUfoId: hit.ufoId || null,
      reason,
      lat: bullet.lat,
      lng: bullet.lng,
      spriteUrl: bullet.spriteUrl,
      explosionFrames: bullet.explosionFrames,
    });
  };

  const ufoPayload = (state) => ({
    ufoId: state.ufoId,
    lat: state.lat,
    lng: state.lng,
    vida: state.vida,
    expiresAt: new Date(state.expiresAt).toISOString(),
    ufo: state.ufo,
  });

  const scheduleUfosAfterFirstShot = async (zoneId, origin) => {
    if (scheduledUfoZones.has(zoneId)) return;
    scheduledUfoZones.add(zoneId);
    const configuredUfos = await UfoModel.find().lean().catch((error) => {
      scheduledUfoZones.delete(zoneId);
      console.error(`[PVP][${instanceId}] ufo read error`, error);
      return [];
    });
    if (!scheduledUfoZones.has(zoneId)) return;
    const scheduledAt = Date.now();
    for (const configured of configuredUfos) {
      const delayMs = Math.max(0, Number(configured.tiempoAparicion) || 0) * 1000;
      const durationMs =
        Math.max(1, Number(configured.duracionPantalla) || 600) * 1000;
      const timer = setTimeout(() => {
        pendingUfoTimers.get(zoneId)?.delete(timer);
        if ((roomIndex.get(zoneId)?.size || 0) === 0) return;
        const ufoId = String(configured._id);
        const key = `${zoneId}:${ufoId}`;
        const position = geo.computeOffset(
          origin,
          UFO_MIN_DISTANCE_M +
            Math.random() * (UFO_MAX_DISTANCE_M - UFO_MIN_DISTANCE_M),
          (Number(origin.heading) || 0) + Math.random() * 60 - 30
        );
        const state = {
          key,
          ufoId,
          zoneId,
          lat: position.lat,
          lng: position.lng,
          anchor: { ...origin },
          vida: Math.max(1, Number(configured.vida) || 300),
          expiresAt: Date.now() + durationMs,
          ufo: { ...configured, _id: ufoId },
        };
        activeUfos.set(key, state);
        nsp.to(zoneId).emit('ufo:spawn', ufoPayload(state));
      }, delayMs);
      if (!pendingUfoTimers.has(zoneId)) {
        pendingUfoTimers.set(zoneId, new Set());
      }
      pendingUfoTimers.get(zoneId).add(timer);
      timer.unref?.();
    }
    log('ufos scheduled after first shot', {
      zoneId,
      count: configuredUfos.length,
      scheduledAt,
    });
  };

  const bulletTimer = setInterval(() => {
    for (const [id, b] of bullets) {
      if (Date.now() < b.startsAt) continue;

      const previous = { lat: b.lat, lng: b.lng };
      const remainingM = Math.max(0, b.alcance - (b.recorrido || 0));
      const stepM = Math.min(b.speed * (TICK_MS / 1000), remainingM);
      const next = geo.computeOffset(previous, stepM, b.heading);

      // Resuelve todos los candidatos del segmento y conserva solo el primero.
      // Así una bala nunca atraviesa una torre/OVNI para impactar algo posterior.
      const candidates = [];
      const seenUsers = new Set();
      const socketsInZone = roomIndex.get(b.zoneId) || new Set();
      for (const sid of socketsInZone) {
        const player = players.get(sid);
        if (!player || player.userId === b.byUserId ||
            seenUsers.has(player.userId)) continue;
        seenUsers.add(player.userId);
        const impact = segmentCircleIntersection(
          previous, next, player, PLAYER_HIT_RADIUS_M
        );
        if (impact) candidates.push({ type: 'player', target: player, impact });
      }
      for (const [turretId, turret] of turrets) {
        if (turret.zoneId !== b.zoneId ||
            String(turret.ownerUserId) === b.byUserId) continue;
        const impact = segmentCircleIntersection(
          previous, next, turret, PLAYER_HIT_RADIUS_M
        );
        if (impact) {
          candidates.push({ type: 'turret', target: turret, turretId, impact });
        }
      }
      for (const state of activeUfos.values()) {
        if (state.zoneId !== b.zoneId) continue;
        const impact = segmentCircleIntersection(
          previous, next, state, UFO_HIT_RADIUS_M
        );
        if (impact) candidates.push({ type: 'ufo', target: state, impact });
      }
      candidates.sort((a, c) => a.impact.t - c.impact.t);
      const collision = candidates[0];
      if (collision) {
        const { impact, target } = collision;
        b.lat = impact.lat;
        b.lng = impact.lng;
        b.recorrido = (b.recorrido || 0) + stepM * impact.t;

        if (collision.type === 'player') {
          const nuevaVida = Math.max(0, (target.vida ?? 1000) - b.dano);
          for (const sameUser of playersForUser(target.userId)) {
            sameUser.vida = nuevaVida;
          }
          LifeModel.updateOne(
            { userId: target.userId },
            { $set: { vida: nuevaVida }, $setOnInsert: { yaPenalizado: false } },
            { upsert: true }
          ).catch((error) => {
            console.error(`[PVP][${instanceId}] life persist error`, {
              bulletId: id,
              userId: target.userId,
              error: error.message,
            });
          });
          nsp.to(b.zoneId).emit('life:update', {
            bulletId: id,
            byUserId: b.byUserId,
            userId: target.userId,
            vida: nuevaVida,
            dano: b.dano,
          });
          emitBulletExplosion(id, b, 'hit', { userId: target.userId });
        } else if (collision.type === 'turret') {
          target.vida = Math.max(0, target.vida - b.dano);
          TurretModel.updateOne(
            { _id: collision.turretId },
            { $set: { vida: target.vida } }
          ).catch(() => {});
          nsp.to(target.zoneId).emit('turret:update', turretPayload(target));
          emitBulletExplosion(id, b, 'turret', {
            turretId: collision.turretId,
          });
          if (target.vida === 0) {
            turrets.delete(collision.turretId);
            TurretModel.deleteOne({ _id: collision.turretId }).catch(() => {});
            nsp.to(target.zoneId).emit('turret:destroy', {
              ...turretPayload(target),
              reason: 'destroyed',
            });
          }
        } else {
          target.vida = Math.max(0, target.vida - b.dano);
          emitBulletExplosion(id, b, 'ufo', { ufoId: target.ufoId });
          if (target.vida === 0) {
            activeUfos.delete(target.key);
            const premio = Math.max(
              0,
              Number(target.ufo.stepcoinsPremio) || 0
            );
            if (premio > 0) {
              UserModel.updateOne(
                { _id: b.byUserId },
                { $inc: { stepcoins: premio } }
              ).catch(() => {});
            }
            nsp.to(target.zoneId).emit('ufo:destroy', {
              ufoId: target.ufoId,
              winnerUserId: b.byUserId,
              stepcoinsPremio: premio,
              reason: 'destroyed',
            });
          } else {
            nsp.to(target.zoneId).emit('ufo:update', ufoPayload(target));
          }
        }
        bullets.delete(id);
        continue;
      }

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

  const ufoTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, state] of activeUfos) {
      if (state.expiresAt <= now) {
        activeUfos.delete(key);
        nsp.to(state.zoneId).emit('ufo:destroy', {
          ufoId: state.ufoId,
          reason: 'expired',
          winnerUserId: null,
          stepcoinsPremio: 0,
        });
        continue;
      }
      const movementSpeed = Math.min(
        12,
        Math.max(0.5, Number(state.ufo.velocidadMovimiento) || 0.5)
      );
      let heading = Math.random() * 360;
      let next = geo.computeOffset(
        state,
        movementSpeed,
        heading
      );
      const distanceFromAnchor = geo.distanceMeters(next, state.anchor);
      if (distanceFromAnchor > UFO_MAX_DISTANCE_M) {
        heading = bearingDegrees(state, state.anchor) +
          (Math.random() * 90 - 45);
        next = geo.computeOffset(state, movementSpeed, heading);
      } else if (distanceFromAnchor < UFO_MIN_DISTANCE_M) {
        heading = bearingDegrees(state.anchor, state) +
          (Math.random() * 90 - 45);
        next = geo.computeOffset(state, movementSpeed, heading);
      }
      state.lat = next.lat;
      state.lng = next.lng;
      nsp.to(state.zoneId).emit('ufo:update', ufoPayload(state));
    }
  }, 1000);
  ufoTimer.unref?.();

  const turretTimer = setInterval(async () => {
    const now = Date.now();
    for (const [turretId, turret] of turrets) {
      if (new Date(turret.expiresAt).getTime() <= now || turret.vida <= 0) {
        turrets.delete(turretId);
        await TurretModel.deleteOne({ _id: turretId }).catch(() => {});
        nsp.to(turret.zoneId).emit('turret:destroy', { ...turretPayload(turret), reason: 'expired' });
        continue;
      }
      if (new Date(turret.nextShotAt).getTime() > now) continue;
      const candidates = [...players.values()].filter((p) =>
        p.zoneId === turret.zoneId && p.userId !== String(turret.ownerUserId) &&
        (p.vida ?? 0) > 0 && geo.distanceMeters(turret, p) <= turret.alcance);
      candidates.sort((a, b) => geo.distanceMeters(turret, a) - geo.distanceMeters(turret, b));
      const target = candidates[0];
      if (!target) continue;
      turret.nextShotAt = new Date(now + turret.cadenciaDisparo * 1000);
      await TurretModel.updateOne({ _id: turretId }, { $set: { nextShotAt: turret.nextShotAt } }).catch(() => {});
      const shotId = `turret-${turretId}-${now}`;
      const distance = geo.distanceMeters(turret, target);
      nsp.to(turret.zoneId).emit('turret:shot', {
        shotId, turretId, ownerUserId: String(turret.ownerUserId), targetUserId: target.userId,
        from: { lat: turret.lat, lng: turret.lng }, to: { lat: target.lat, lng: target.lng },
        speed: TURRET_BULLET_SPEED, dano: turret.dano,
        spriteUrl: turret.imagenesDisparo?.[0] || '',
      });
      setTimeout(async () => {
        const current = playersForUser(target.userId)[0];
        if (!turrets.has(turretId) || !current || geo.distanceMeters(current, { lat: target.lat, lng: target.lng }) > PLAYER_HIT_RADIUS_M) return;
        const previousLife = current.vida ?? 1000;
        const nuevaVida = Math.max(0, previousLife - turret.dano);
        playersForUser(target.userId).forEach((p) => { p.vida = nuevaVida; });
        await LifeModel.updateOne({ userId: target.userId }, { $set: { vida: nuevaVida } }, { upsert: true }).catch(() => {});
        nsp.to(turret.zoneId).emit('life:update', { userId: target.userId, vida: nuevaVida, dano: turret.dano, byTurretId: turretId, byUserId: String(turret.ownerUserId) });
        nsp.to(turret.zoneId).emit('turret:shot:explode', { shotId, turretId, lat: target.lat, lng: target.lng });
        if (previousLife > 0 && nuevaVida === 0) {
          await UserModel.updateOne({ _id: turret.ownerUserId }, { $inc: { stepcoinsTorretaPendientes: turret.premioBaja || 0 } }).catch(() => {});
        }
      }, Math.max(100, distance / TURRET_BULLET_SPEED * 1000));
    }
  }, 500);
  turretTimer.unref?.();

  const mineTimer = setInterval(async () => {
    const now = Date.now();
    for (const [mineId, mine] of mines) {
      if (new Date(mine.expiresAt).getTime() <= now) {
        mines.delete(mineId);
        await MineModel.deleteOne({ _id: mineId }).catch(() => {});
        nsp.to(mine.zoneId).emit('mine:destroy', {
          mineId,
          reason: 'expired',
        });
        continue;
      }
      if (mine.processing) continue;

      const candidatesByUser = new Map();
      for (const player of players.values()) {
        if (player.zoneId !== mine.zoneId || (player.vida ?? 0) <= 0) {
          continue;
        }
        if (!candidatesByUser.has(player.userId)) {
          candidatesByUser.set(player.userId, player);
        }
      }

      const currentlyInside = new Set();
      for (const [userId, player] of candidatesByUser) {
        if (geo.distanceMeters(mine, player) <= mine.radioActivacion) {
          currentlyInside.add(userId);
        }
      }

      mine.playersInside ||= new Set();
      const targetEntry = [...currentlyInside]
        .find((userId) => !mine.playersInside.has(userId));
      mine.playersInside = currentlyInside;
      if (!targetEntry) continue;

      const target = candidatesByUser.get(targetEntry);
      if (!target) continue;
      mine.processing = true;

      const previousLife = target.vida ?? MAX_PLAYER_LIFE;
      const nuevaVida = Math.max(0, previousLife - mine.dano);
      for (const sameUser of playersForUser(target.userId)) {
        sameUser.vida = nuevaVida;
      }
      await LifeModel.updateOne(
        { userId: target.userId },
        { $set: { vida: nuevaVida } },
        { upsert: true }
      ).catch(() => {});

      // Una mina siempre se destruye al detonar.
      const removeAfterTrigger = true;
      mines.delete(mineId);
      await MineModel.deleteOne({ _id: mineId }).catch(() => {});

      nsp.to(mine.zoneId).emit('mine:trigger', {
        ...minePayload(mine),
        targetUserId: target.userId,
        vida: nuevaVida,
        removed: removeAfterTrigger,
      });
      nsp.to(mine.zoneId).emit('life:update', {
        userId: target.userId,
        vida: nuevaVida,
        dano: mine.dano,
        byMineId: mineId,
        byUserId: String(mine.ownerUserId),
        reason: 'mine',
      });
    }
  }, 250);
  mineTimer.unref?.();

  const airstrikeTimer = setInterval(async () => {
    const now = Date.now();
    for (const [airstrikeId, airstrike] of airstrikes) {
      if (!airstrike.launched &&
          new Date(airstrike.attackAt).getTime() <= now) {
        airstrike.launched = true;
        await AirstrikeModel.updateOne(
          { _id: airstrikeId },
          { $set: { launched: true } }
        ).catch(() => {});
        nsp.to(airstrike.zoneId).emit(
          'airstrike:launch',
          airstrikePayload(airstrike)
        );
      }

      if (new Date(airstrike.impactAt).getTime() > now) continue;
      airstrikes.delete(airstrikeId);
      await AirstrikeModel.deleteOne({ _id: airstrikeId }).catch(() => {});

      const targetsByUser = new Map();
      for (const player of players.values()) {
        if (player.zoneId !== airstrike.zoneId ||
            (player.vida ?? 0) <= 0 ||
            geo.distanceMeters(airstrike, player) >
              airstrike.radioExplosion) {
          continue;
        }
        if (!targetsByUser.has(player.userId)) {
          targetsByUser.set(player.userId, player);
        }
      }

      const hits = [];
      for (const target of targetsByUser.values()) {
        const nuevaVida = Math.max(
          0,
          (target.vida ?? MAX_PLAYER_LIFE) - airstrike.dano
        );
        for (const sameUser of playersForUser(target.userId)) {
          sameUser.vida = nuevaVida;
        }
        await LifeModel.updateOne(
          { userId: target.userId },
          { $set: { vida: nuevaVida } },
          { upsert: true }
        ).catch(() => {});
        hits.push({ userId: target.userId, vida: nuevaVida });
        nsp.to(airstrike.zoneId).emit('life:update', {
          userId: target.userId,
          vida: nuevaVida,
          dano: airstrike.dano,
          byAirstrikeId: airstrikeId,
          byUserId: String(airstrike.ownerUserId),
          reason: 'airstrike',
        });
      }

      nsp.to(airstrike.zoneId).emit('airstrike:impact', {
        ...airstrikePayload(airstrike),
        hits,
      });
    }
  }, 100);
  airstrikeTimer.unref?.();

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
        await turretsReady;
        await minesReady;
        await airstrikesReady;
        const roomTurrets = [...turrets.values()]
          .filter((t) => t.zoneId === zoneId)
          .map(turretPayload);
        const roomMines = [...mines.values()]
          .filter((mine) => mine.zoneId === zoneId)
          .map(minePayload);
        const roomAirstrikes = [...airstrikes.values()]
          .filter((airstrike) => airstrike.zoneId === zoneId)
          .map(airstrikePayload);
        const roomUfos = [...activeUfos.values()]
          .filter((ufo) => ufo.zoneId === zoneId)
          .map(ufoPayload);
        const claimed = await UserModel.findOneAndUpdate(
          { _id: userId, stepcoinsTorretaPendientes: { $gt: 0 } },
          [{ $set: {
            stepcoins: { $add: ['$stepcoins', '$stepcoinsTorretaPendientes'] },
            stepcoinsTorretaPendientes: 0,
          } }],
          { new: false }
        ).lean().catch(() => null);
        const claimedStepcoins = claimed?.stepcoinsTorretaPendientes || 0;
        cb?.({
          ok:true,
          players: others,
          turrets: roomTurrets,
          mines: roomMines,
          airstrikes: roomAirstrikes,
          ufos: roomUfos,
          claimedStepcoins,
          instanceId,
        });
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

      const { lat, lng, heading, skinUrl, nombre } = payload || {};
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
      if (typeof skinUrl === 'string' && skinUrl.trim()) {
        p.skinUrl = skinUrl.trim();
      }
      if (typeof nombre === 'string' && nombre.trim()) {
        p.nombre = nombre.trim();
      }
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
        skinUrl: p.skinUrl,
        nombre: p.nombre,
      });
    });

    // Resincroniza la copia de vida en memoria después de un reset REST.
    socket.on('life:sync', async (_payload, cb) => {
      const p = players.get(socket.id);
      if (!p) return cb?.({ ok: false, error: 'No player' });

      try {
        const lifeDoc = await LifeModel.findOne({ userId: p.userId }).lean();
        const vida = lifeDoc?.vida ?? 1000;
        for (const sameUser of playersForUser(p.userId)) {
          sameUser.vida = vida;
        }
        nsp.to(p.zoneId).emit('life:update', {
          userId: p.userId,
          vida,
          reason: 'sync',
        });
        cb?.({ ok: true, vida });
      } catch (error) {
        console.error(`[PVP][${instanceId}] life sync error`, {
          socketId: socket.id,
          userId: p.userId,
          error: error.message,
        });
        cb?.({ ok: false, error: error.message });
      }
    });

    // La carta de Vida es una habilidad permanente: debe estar en el mazo,
    // aplica la curación en servidor y entra en cooldown, pero no se consume.
    socket.on('card:use-life', async (payload, cb) => {
      const p = players.get(socket.id);
      if (!p) return cb?.({ ok: false, error: 'No player' });

      const cardId = String(payload?.cardId || '');
      if (!cardId) {
        return cb?.({ ok: false, error: 'Carta de Vida inválida' });
      }

      try {
        const card = await CardModel.findById(cardId).lean();
        if (!card || card.tipoArma !== 'Vida') {
          throw new Error('Carta de Vida inválida');
        }

        // Compatibilidad con cartas Vida creadas antes de persistir vidaQueDa.
        const configuredHealing = Number(card.vidaQueDa || card.vida);
        if (!Number.isFinite(configuredHealing) || configuredHealing <= 0) {
          throw new Error('La carta no tiene una curación válida');
        }

        const user = await UserModel.findOne({
          _id: p.userId,
          cartas: cardId,
          mazo: cardId,
        }).lean();
        if (!user) {
          throw new Error('La carta ya no está disponible en tu mazo');
        }

        const cooldownKey = `life:${cardId}`;
        const cooldownMs =
          Math.max(0, Number(card.tiempoEspera) || 0) * 1000;
        const lastUsedAt = p.lastShotByCard?.[cooldownKey] || 0;
        if (Date.now() - lastUsedAt < cooldownMs) {
          throw new Error('Carta en tiempo de espera');
        }

        const lifeDoc = await LifeModel.findOne({ userId: p.userId }).lean();
        const previousLife = Math.max(
          0,
          Math.min(MAX_PLAYER_LIFE, Number(lifeDoc?.vida ?? MAX_PLAYER_LIFE))
        );
        if (previousLife >= MAX_PLAYER_LIFE) {
          throw new Error('Ya tienes la vida al máximo');
        }
        const vida = Math.min(
          MAX_PLAYER_LIFE,
          previousLife + Math.floor(configuredHealing)
        );
        const vidaRecuperada = vida - previousLife;

        await LifeModel.updateOne(
          { userId: p.userId },
          { $set: { vida }, $setOnInsert: { yaPenalizado: false } },
          { upsert: true }
        );
        for (const sameUser of playersForUser(p.userId)) {
          sameUser.vida = vida;
          sameUser.lastShotByCard = {
            ...(sameUser.lastShotByCard || {}),
            [cooldownKey]: Date.now(),
          };
        }

        nsp.to(p.zoneId).emit('life:update', {
          userId: p.userId,
          vida,
          vidaRecuperada,
          cardId,
          cooldownMs,
          reason: 'life-card',
        });
        cb?.({ ok: true, vida, vidaRecuperada, cooldownMs });
      } catch (error) {
        console.error(`[PVP][${instanceId}] life card error`, {
          socketId: socket.id,
          userId: p.userId,
          cardId,
          error: error.message,
        });
        cb?.({ ok: false, error: error.message });
      }
    });

    socket.on('mine:place', async (payload, cb) => {
      const p = players.get(socket.id);
      if (!p) return cb?.({ ok: false, error: 'No player' });

      const cardId = String(payload?.cardId || '');
      const lat = Number(payload?.lat);
      const lng = Number(payload?.lng);

      try {
        const card = await CardModel.findById(cardId).lean();
        if (!card || card.tipoArma !== 'Trampa') {
          throw new Error('Carta de Mina inválida');
        }
        if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
            geo.distanceMeters(p, { lat, lng }) > 500) {
          throw new Error('Posición de mina inválida');
        }

        const radioActivacion = Number(card.radioActivacion);
        const dano = Number(card.dano);
        const duracion = Number(card.duracion);
        if (!Number.isFinite(radioActivacion) || radioActivacion <= 0 ||
            !Number.isFinite(dano) || dano <= 0 ||
            !Number.isFinite(duracion) || duracion <= 0) {
          throw new Error('La Mina no tiene una configuración válida');
        }

        const user = await UserModel.findOne({
          _id: p.userId,
          cartas: cardId,
          mazo: cardId,
        }).lean();
        if (!user) {
          throw new Error('La carta ya no está disponible en tu mazo');
        }

        const cooldownKey = `mine:${cardId}`;
        const cooldownMs =
          Math.max(0, Number(card.tiempoEspera) || 0) * 1000;
        const lastPlacedAt = p.lastShotByCard?.[cooldownKey] || 0;
        if (Date.now() - lastPlacedAt < cooldownMs) {
          throw new Error('Carta en tiempo de espera');
        }

        const mineDoc = await MineModel.create({
          ownerUserId: p.userId,
          cardId,
          lat,
          lng,
          zoneId: toZoneId(lat, lng),
          radioActivacion,
          dano: Math.floor(dano),
          usoUnico: card.usoUnico !== false,
          expiresAt: new Date(Date.now() + Math.floor(duracion) * 1000),
          imagenPortada: '',
          imagenesActivacion: card.imagenesActivacion || [],
          imagenesExplosion: card.imagenesExplosionTrampa || [],
        });
        const mine = mineDoc.toObject();
        mine.playersInside = new Set();
        mines.set(String(mine._id), mine);
        for (const sameUser of playersForUser(p.userId)) {
          sameUser.lastShotByCard = {
            ...(sameUser.lastShotByCard || {}),
            [cooldownKey]: Date.now(),
          };
        }

        const result = minePayload(mine);
        nsp.to(mine.zoneId).emit('mine:spawn', result);
        cb?.({ ok: true, mine: result, cooldownMs });
      } catch (error) {
        console.error(`[PVP][${instanceId}] mine placement error`, {
          socketId: socket.id,
          userId: p.userId,
          cardId,
          error: error.message,
        });
        cb?.({ ok: false, error: error.message });
      }
    });

    socket.on('airstrike:place', async (payload, cb) => {
      const p = players.get(socket.id);
      if (!p) return cb?.({ ok: false, error: 'No player' });

      const cardId = String(payload?.cardId || '');
      const lat = Number(payload?.lat);
      const lng = Number(payload?.lng);

      try {
        const card = await CardModel.findById(cardId).lean();
        if (!card || card.tipoArma !== 'Invocacion') {
          throw new Error('Carta de Ataque Aéreo inválida');
        }
        if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
            geo.distanceMeters(p, { lat, lng }) > 1000) {
          throw new Error('Posición de ataque inválida');
        }

        const radioExplosion = Number(card.radioExplosion);
        const dano = Number(card.dano);
        const tiempoHastaAtaque = Number(card.tiempoHastaAtaque);
        if (!Number.isFinite(radioExplosion) || radioExplosion <= 0 ||
            !Number.isFinite(dano) || dano <= 0 ||
            !Number.isFinite(tiempoHastaAtaque) || tiempoHastaAtaque <= 0) {
          throw new Error('El Ataque Aéreo no tiene una configuración válida');
        }

        const user = await UserModel.findOne({
          _id: p.userId,
          cartas: cardId,
          mazo: cardId,
        }).lean();
        if (!user) {
          throw new Error('La carta no está disponible en tu mazo');
        }

        const cooldownKey = `airstrike:${cardId}`;
        const cooldownMs =
          Math.max(0, Number(card.tiempoEspera) || 0) * 1000;
        const lastPlacedAt = p.lastShotByCard?.[cooldownKey] || 0;
        if (Date.now() - lastPlacedAt < cooldownMs) {
          throw new Error('Carta en tiempo de espera');
        }

        const now = Date.now();
        const attackAt = new Date(
          now + Math.floor(tiempoHastaAtaque * 1000)
        );
        const impactAt = new Date(attackAt.getTime() + 6000);
        const airstrikeDoc = await AirstrikeModel.create({
          ownerUserId: p.userId,
          cardId,
          lat,
          lng,
          zoneId: toZoneId(lat, lng),
          radioExplosion,
          dano: Math.floor(dano),
          attackAt,
          impactAt,
          launched: false,
          heading: Math.random() * 360,
          imagenesAvion: card.imagenesAvion?.length
            ? card.imagenesAvion
            : (card.imagenesInvocacion || []),
          imagenesBomba: card.imagenesBomba?.length
            ? card.imagenesBomba
            : (card.imagenPortada ? [card.imagenPortada] : []),
          imagenesExplosion: card.imagenesExplosionInvocacion || [],
        });
        const airstrike = airstrikeDoc.toObject();
        airstrikes.set(String(airstrike._id), airstrike);
        for (const sameUser of playersForUser(p.userId)) {
          sameUser.lastShotByCard = {
            ...(sameUser.lastShotByCard || {}),
            [cooldownKey]: now,
          };
        }

        const result = airstrikePayload(airstrike);
        nsp.to(airstrike.zoneId).emit('airstrike:spawn', result);
        cb?.({ ok: true, airstrike: result, cooldownMs });
      } catch (error) {
        console.error(`[PVP][${instanceId}] airstrike placement error`, {
          socketId: socket.id,
          userId: p.userId,
          cardId,
          error: error.message,
        });
        cb?.({ ok: false, error: error.message });
      }
    });

    socket.on('turret:place', async (payload, cb) => {
      try {
        const p = players.get(socket.id);
        if (!p) throw new Error('No player');
        const card = await CardModel.findById(payload?.cardId).lean();
        if (!card || card.tipoArma !== 'Arrastre') throw new Error('Carta de arrastre inválida');
        const lat = Number(payload?.lat);
        const lng = Number(payload?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
            geo.distanceMeters(p, { lat, lng }) > 500) throw new Error('Posición de torreta inválida');
        const now = Date.now();
        const alcanceConfigurado = Number(card.alcance);
        const danoConfigurado = Number(card.dano);
        const turret = await TurretModel.create({
          ownerUserId: p.userId, cardId: card._id, lat, lng, zoneId: toZoneId(lat, lng),
          vida: Math.max(1, card.vida || 1), vidaMaxima: Math.max(1, card.vida || 1),
          alcance: Number.isFinite(alcanceConfigurado) && alcanceConfigurado > 0
            ? alcanceConfigurado
            : DEFAULT_TURRET_RANGE_M,
          dano: Number.isFinite(danoConfigurado) && danoConfigurado > 0
            ? danoConfigurado
            : DEFAULT_TURRET_DAMAGE,
          cadenciaDisparo: Math.max(1, card.cadenciaDisparo || 10),
          premioBaja: Math.max(0, card.premioBajaTorreta || 0),
          nextShotAt: new Date(now + Math.max(1, card.cadenciaDisparo || 10) * 1000),
          expiresAt: new Date(now + Math.max(1, card.duracion || 30) * 1000),
          imagenesMovimiento: card.imagenesMovimiento?.length
            ? card.imagenesMovimiento
            : (card.imagenPortada ? [card.imagenPortada] : []),
          imagenesDisparo: card.imagenesDisparo || [],
          imagenesMuerte: card.imagenesMuerte || [],
        });
        const plain = turret.toObject();
        turrets.set(String(plain._id), plain);
        const result = turretPayload(plain);
        nsp.to(plain.zoneId).emit('turret:spawn', result);
        cb?.({ ok: true, turret: result });
      } catch (error) {
        cb?.({ ok: false, error: error.message });
      }
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
        scheduleUfosAfterFirstShot(p.zoneId, {
          ...authoritativeFrom,
          heading: Number(p.heading) || 0,
        }).catch((error) => {
          console.error(`[PVP][${instanceId}] ufo schedule error`, error);
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
        for (const timer of pendingUfoTimers.get(p.zoneId) || []) {
          clearTimeout(timer);
        }
        pendingUfoTimers.delete(p.zoneId);
        scheduledUfoZones.delete(p.zoneId);
        for (const [key, ufo] of activeUfos) {
          if (ufo.zoneId === p.zoneId) activeUfos.delete(key);
        }
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
