// sockets/pvp.socket.js
const geo  = require('../utils/geo');              // <- OK si utils está en la raíz del repo
const Card = require('../api/models/Card');
const UserLife = require('../api/models/UserLife');
const Turret = require('../api/models/Turret');
const Mine = require('../api/models/Mine');
const Airstrike = require('../api/models/Airstrike');
const User = require('../api/models/User');
const Ufo = require('../api/models/Ufo');
const { resolveBearerToken } = require('../api/services/authIdentity');
const clanMembershipCache = require('../api/services/clanMembershipCache');
const bountyService = require('../api/services/bountyService');
const socialRealtime = require('../api/services/socialRealtime');
const {
  effectiveCard,
  upgradeLevelForUser,
} = require('../api/services/cardUpgrades');

module.exports = function(io, dependencies = {}) {
  const hasInjectedDependencies = Object.keys(dependencies).length > 0;
  const CardModel = dependencies.CardModel || Card;
  const LifeModel = dependencies.LifeModel || UserLife;
  const TurretModel = dependencies.TurretModel || Turret;
  const MineModel = dependencies.MineModel || Mine;
  const AirstrikeModel = dependencies.AirstrikeModel || Airstrike;
  const UserModel = dependencies.UserModel || User;
  const UfoModel = dependencies.UfoModel || Ufo;
  const resolveSocketIdentity = dependencies.resolveAuthToken ||
    ((token) => resolveBearerToken(token, { UserModel }));
  const ClanMembershipService = dependencies.ClanMembershipService ||
    (hasInjectedDependencies
      ? {
          getClanIds: async () => new Set(),
          shareActiveClan: async () => false,
          events: { on() {} },
        }
      : clanMembershipCache);
  const BountyService = dependencies.BountyService ||
    (hasInjectedDependencies
      ? {
          totalForTarget: async () => 0,
          claimForKill: async () => ({ paid: 0, claimed: 0 }),
        }
      : bountyService);
  const nsp = io.of('/pvp');
  const requireSocketAuth = dependencies.requireAuth ?? !hasInjectedDependencies;
  const instanceId =
    process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || `pid-${process.pid}`;

  // Estado en memoria (MVP)
  const players = new Map(); // socketId -> { userId, lat, lng, heading, skinUrl, nombre, zoneId, lastShotByCard:{}, vida }
  const bullets = new Map(); // bulletId -> { byUserId, zoneId, lat, lng, heading, speed, alcance, dano, spriteUrl, createdAt }
  const acceptedClientShots = new Map(); // userId:clientShotId -> ack
  const roomIndex = new Map(); // zoneId -> Set<socketId>
  // Una cuenta puede mantener varios sockets, pero solo uno publica presencia.
  // El ultimo presence:hello valido pasa a ser el socket primario.
  const primarySocketByUser = new Map();
  const lastPresenceByUser = new Map();
  const pendingPresenceLeaves = new Map();
  const presenceSequenceByUser = new Map();
  const lifeSequenceByUser = new Map();
  let snapshotVersion = 0;
  const presenceDisconnectGraceMs =
    dependencies.presenceDisconnectGraceMs ?? 15000;
  const turrets = new Map();
  const mines = new Map();
  const airstrikes = new Map();
  const activeUfos = new Map();
  const activeUfoProjectiles = new Map();
  const processedUfoDamageEvents = new Set();
  const scheduledUfoZones = new Set();
  const pendingUfoTimers = new Map();
  const TURRET_BULLET_SPEED = 80;
  const DEFAULT_TURRET_RANGE_M = 100;
  const DEFAULT_TURRET_DAMAGE = 10;
  const UFO_SPAWN_MIN_DISTANCE_M = 150;
  const UFO_SPAWN_MAX_DISTANCE_M = 260;
  const UFO_ROAM_MAX_DISTANCE_M = 300;
  const UFO_ROAM_RETURN_DISTANCE_M = 220;
  const MAX_PLAYER_LIFE = 1000;
  const publicSkinPayload = (rawSkin) => {
    if (!rawSkin) return null;
    const skin = typeof rawSkin.toObject === 'function'
      ? rawSkin.toObject()
      : rawSkin;
    return {
      _id: String(skin._id || skin.id || ''),
      renderType: skin.renderType || 'classic',
      renderVersion: Number(skin.renderVersion) || 1,
      scripts: skin.scripts || {},
      spritesheets: skin.spritesheets || {},
    };
  };
  const classicSkinUrl = (skin) => {
    if (!skin || skin.renderType === 'flame_spritesheet') return '';
    const idle = skin.scripts?.parado;
    return Array.isArray(idle) && typeof idle[0] === 'string' ? idle[0] : '';
  };
  const loadAuthoritativeIdentityAndSkin = async (userId) => {
    let query = UserModel.findById(userId).select('nickname skinSeleccionada gameModeEnabled');
    if (typeof query.populate === 'function') {
      query = query.populate({
        path: 'skinSeleccionada',
        select: 'renderType renderVersion scripts spritesheets',
      });
    }
    const user = await query.lean();
    const skinDefinition = publicSkinPayload(user?.skinSeleccionada);
    return {
      user,
      skinDefinition,
      skinId: skinDefinition?._id || '',
      skinUrl: classicSkinUrl(skinDefinition),
    };
  };
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
    renderType: t.renderType === 'flame_spritesheet' && t.idleSpritesheet?.url
      ? 'flame_spritesheet'
      : 'classic',
    idleSpritesheet: t.idleSpritesheet || null,
    deathSpritesheet: t.deathSpritesheet || null,
    seq: Number(t.seq) || 1,
    serverTimestamp: Date.now(),
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
    seq: Number(mine.seq) || 1,
    serverTimestamp: Date.now(),
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
      seq: Number(airstrike.seq) || 1,
      serverTimestamp: Date.now(),
    };
  };
  const turretsReady = TurretModel.find({ expiresAt: { $gt: new Date() }, vida: { $gt: 0 } }).lean()
    .then((items) => items.forEach((t) => {
      normalizeTurretCombatStats(t);
      t.seq = Math.max(1, Number(t.seq) || 1);
      turrets.set(String(t._id), t);
    }))
    .catch((error) => console.error('[PVP] turret restore error', error));
  const minesReady = MineModel.find({ expiresAt: { $gt: new Date() } }).lean()
    .then((items) => items.forEach((mine) => {
      mine.seq = Math.max(1, Number(mine.seq) || 1);
      mine.playersInside = new Set();
      mines.set(String(mine._id), mine);
    }))
    .catch((error) => console.error('[PVP] mine restore error', error));
  const airstrikesReady = AirstrikeModel.find({
    impactAt: { $gt: new Date() },
  }).lean()
    .then((items) => items.forEach((airstrike) => {
      airstrike.seq = Math.max(1, Number(airstrike.seq) || 1);
      airstrikes.set(String(airstrike._id), airstrike);
    }))
    .catch((error) => console.error('[PVP] airstrike restore error', error));

  const log = (message, details = {}) => {
    console.log(`[PVP][${instanceId}] ${message}`, details);
  };

  const playersForUser = (userId) => {
    const primarySocketId = primarySocketByUser.get(String(userId));
    return [...players.entries()]
      .filter(([, player]) => player.userId === String(userId))
      .sort(([a], [b]) => (a === primarySocketId ? -1 : b === primarySocketId ? 1 : 0))
      .map(([, player]) => player);
  };
  const assertGameModeEnabled = async (userId) => {
    const user = await UserModel.findById(userId)
      .select('_id gameModeEnabled')
      .lean();
    if (!user || user.gameModeEnabled === false) {
      throw new Error('Modo Juego desactivado');
    }
  };
  const nextPresenceSeq = (userId) => {
    const next = (presenceSequenceByUser.get(String(userId)) || 0) + 1;
    presenceSequenceByUser.set(String(userId), next);
    snapshotVersion += 1;
    return next;
  };
  const nextLifeSeq = (userId) => {
    const next = (lifeSequenceByUser.get(String(userId)) || 0) + 1;
    lifeSequenceByUser.set(String(userId), next);
    return next;
  };
  const presenceMetadata = (player, seq = player.seq) => ({
    seq,
    lifeSeq: lifeSequenceByUser.get(String(player.userId)) || 0,
    serverTimestamp: Date.now(),
    lastSeen: player.lastSeen,
    presenceSessionId: player.presenceSessionId,
  });
  const lifeMetadata = (userId) => ({
    lifeSeq: nextLifeSeq(userId),
    serverTimestamp: Date.now(),
  });

  const updateSocialPresence = async (userIds) => {
    for (const userId of userIds) {
      const clanIds = [...await ClanMembershipService.getClanIds(userId)];
      for (const player of playersForUser(String(userId))) player.clanIds = clanIds;
      const player = playersForUser(String(userId))[0];
      if (player) {
        nsp.to(player.zoneId).emit('presence:social', {
          userId: String(userId),
          clanIds,
        });
      }
    }
  };
  ClanMembershipService.events.on('invalidated', (userIds) => {
    updateSocialPresence(userIds).catch((error) => {
      console.error(`[PVP][${instanceId}] social presence refresh error`, error);
    });
  });
  socialRealtime.events.on('nickname-changed', ({ userId, nickname }) => {
    for (const player of playersForUser(String(userId))) {
      player.nickname = nickname;
      nsp.to(player.zoneId).emit('presence:identity', {
        userId: String(userId),
        nickname,
      });
    }
  });
  socialRealtime.events.on('game-mode-changed', ({ userId, gameModeEnabled }) => {
    const normalizedUserId = String(userId);
    if (gameModeEnabled !== false) return;
    for (const [bulletId, bullet] of bullets) {
      if (bullet.byUserId !== normalizedUserId) continue;
      emitBulletExplosion(bulletId, bullet, 'game-mode-disabled');
      bullets.delete(bulletId);
    }
    for (const [projectileId, projectile] of activeUfoProjectiles) {
      if (projectile.targetUserId !== normalizedUserId) continue;
      activeUfoProjectiles.delete(projectileId);
      nsp.to(projectile.zoneId).emit('ufo:projectile:cancel', {
        projectileId,
        targetUserId: normalizedUserId,
      });
    }
    for (const [socketId, player] of players) {
      if (player.userId !== normalizedUserId) continue;
      player.gameModeEnabled = false;
      nsp.sockets.get(socketId)?.disconnect(true);
    }
  });

  async function applyPlayerDamage({
    attackerUserId,
    target,
    damage,
    zoneId,
    source,
    killEventId,
    eventData = {},
  }) {
    if (target.gameModeEnabled === false) {
      return { protected: true, ignored: true, vida: target.vida ?? MAX_PLAYER_LIFE, killed: false };
    }
    const attackerId = String(attackerUserId || '');
    const targetUserId = String(target.userId || '');
    try {
      await assertGameModeEnabled(targetUserId);
    } catch (_) {
      target.gameModeEnabled = false;
      return { protected: true, ignored: true, vida: target.vida ?? MAX_PLAYER_LIFE, killed: false };
    }
    if (attackerId && attackerId !== targetUserId &&
        await ClanMembershipService.shareActiveClan(attackerId, targetUserId)) {
      nsp.to(zoneId).emit('life:protected', {
        attackerUserId: attackerId,
        targetUserId,
        source,
        ...eventData,
      });
      return { protected: true, vida: target.vida ?? MAX_PLAYER_LIFE, killed: false };
    }

    const previousLife = target.vida ?? MAX_PLAYER_LIFE;
    const nuevaVida = Math.max(0, previousLife - damage);
    for (const sameUser of playersForUser(targetUserId)) sameUser.vida = nuevaVida;
    await LifeModel.updateOne(
      { userId: targetUserId },
      { $set: { vida: nuevaVida }, $setOnInsert: { yaPenalizado: false } },
      { upsert: true }
    );
    nsp.to(zoneId).emit('life:update', {
      userId: targetUserId,
      vida: nuevaVida,
      dano: damage,
      byUserId: attackerId || null,
      reason: source,
      ...lifeMetadata(targetUserId),
      ...eventData,
    });

    const killed = previousLife > 0 && nuevaVida === 0;
    if (killed && attackerId && attackerId !== targetUserId) {
      const bounty = await BountyService.claimForKill({
        attackerUserId: attackerId,
        targetUserId,
        killEventId,
        source,
      }).catch((error) => {
        console.error(`[PVP][${instanceId}] bounty claim error`, { killEventId, error: error.message });
        return { paid: 0, claimed: 0, error: true };
      });
      nsp.to(zoneId).emit('combat:death', {
        killEventId,
        attackerUserId: attackerId,
        targetUserId,
        source,
        bountyPaid: bounty.paid || 0,
      });
    }
    return { protected: false, vida: nuevaVida, killed };
  }

  // Tick de balas (server-authoritative)
  const TICK_MS = 50;
  const BULLET_START_DELAY_MS = 180;
  const PLAYER_HIT_RADIUS_M = 8;
  const ANIMATED_PLAYER_HIT_RADIUS_M = 16;
  const DIRECT_PROJECTILE_SAFE_DISTANCE_M = 50;
  // El icono del OVNI se dibuja a 90 px y ocupa bastante más superficie
  // visual que un jugador. Un radio propio evita que un disparo que lo roza
  // claramente en pantalla se considere un fallo en el servidor.
  const UFO_HIT_RADIUS_M = 30;

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
      explosionRenderType: bullet.explosionRenderType,
      explosionSpritesheet: bullet.explosionSpritesheet,
    });
  };

  const ufoPayload = (state) => ({
    ufoId: state.ufoId,
    lat: state.lat,
    lng: state.lng,
    vida: state.vida,
    state: state.state || 'active',
    targetUserId: state.targetUserId || null,
    nextShotAt: state.nextShotAt
      ? new Date(state.nextShotAt).toISOString()
      : null,
    seq: state.seq || 1,
    serverTimestamp: Date.now(),
    expiresAt: new Date(state.expiresAt).toISOString(),
    ufo: state.ufo,
  });

  const ufoProjectilePayload = (projectile, now = Date.now()) => {
    const durationMs = Math.max(1, projectile.impactAt - projectile.createdAt);
    const progress = Math.max(
      0,
      Math.min(1, (now - projectile.createdAt) / durationMs)
    );
    return {
      projectileId: projectile.projectileId,
      ufoId: projectile.ufoId,
      targetUserId: projectile.targetUserId,
      from: projectile.from,
      to: projectile.to,
      visualFrom: {
        lat: projectile.from.lat +
          (projectile.to.lat - projectile.from.lat) * progress,
        lng: projectile.from.lng +
          (projectile.to.lng - projectile.from.lng) * progress,
      },
      speed: projectile.speed,
      dano: projectile.dano,
      spriteUrl: projectile.spriteUrl,
      rotationOffset: projectile.rotationOffset || 0,
      createdAt: new Date(projectile.createdAt).toISOString(),
      impactAt: new Date(projectile.impactAt).toISOString(),
      serverTimestamp: now,
    };
  };

  const bumpUfo = (state, nextState) => {
    state.seq = (state.seq || 0) + 1;
    if (nextState) state.state = nextState;
    return state.seq;
  };

  const cancelUfoProjectiles = (state, reason) => {
    for (const [projectileId, projectile] of activeUfoProjectiles) {
      if (projectile.ufoId !== state.ufoId ||
          projectile.zoneId !== state.zoneId) continue;
      activeUfoProjectiles.delete(projectileId);
      nsp.to(state.zoneId).emit('ufo:projectile:cancel', {
        projectileId,
        ufoId: state.ufoId,
        reason,
        serverTimestamp: Date.now(),
      });
    }
  };

  const destroyUfo = ({ state, reason, winnerUserId = null }) => {
    if (!state || state.dead || !activeUfos.has(state.key)) return false;
    state.dead = true;
    state.vida = 0;
    bumpUfo(state, reason === 'destroyed' ? 'dead' : 'expired');
    activeUfos.delete(state.key);
    cancelUfoProjectiles(state, reason);
    const premio = reason === 'destroyed'
      ? Math.max(0, Number(state.ufo.stepcoinsPremio) || 0)
      : 0;
    if (winnerUserId && premio > 0) {
      UserModel.updateOne(
        { _id: winnerUserId },
        { $inc: { stepcoins: premio } }
      ).catch(() => {});
    }
    nsp.to(state.zoneId).emit('ufo:destroy', {
      ...ufoPayload(state),
      winnerUserId,
      stepcoinsPremio: premio,
      reason,
    });
    return true;
  };

  const applyUfoDamage = ({
    state,
    damage,
    attackerUserId,
    damageEventId,
  }) => {
    if (!state || state.dead || !activeUfos.has(state.key)) {
      return { applied: false, dead: true, vida: 0 };
    }
    const eventId = String(damageEventId || '');
    if (!eventId || processedUfoDamageEvents.has(eventId)) {
      return { applied: false, duplicate: true, vida: state.vida };
    }
    processedUfoDamageEvents.add(eventId);
    const forget = setTimeout(
      () => processedUfoDamageEvents.delete(eventId),
      60000
    );
    forget.unref?.();
    state.vida = Math.max(0, state.vida - Math.max(0, Number(damage) || 0));
    if (state.vida === 0) {
      destroyUfo({
        state,
        reason: 'destroyed',
        winnerUserId: attackerUserId || null,
      });
      return { applied: true, dead: true, vida: 0 };
    }
    bumpUfo(state, 'active');
    nsp.to(state.zoneId).emit('ufo:update', ufoPayload(state));
    return { applied: true, dead: false, vida: state.vida };
  };

  const primaryAlivePlayersInZone = (zoneId) => {
    const result = [];
    for (const [socketId, player] of players) {
      if (player.gameModeEnabled === false ||
          primarySocketByUser.get(player.userId) !== socketId ||
          player.zoneId !== zoneId || (player.vida ?? 0) <= 0) continue;
      result.push(player);
    }
    return result;
  };

  const selectUfoTarget = (state) => primaryAlivePlayersInZone(state.zoneId)
    .sort((a, b) => {
      const distance = geo.distanceMeters(state, a) -
        geo.distanceMeters(state, b);
      return distance || String(a.userId).localeCompare(String(b.userId));
    })[0] || null;

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
          UFO_SPAWN_MIN_DISTANCE_M +
            Math.random() *
              (UFO_SPAWN_MAX_DISTANCE_M - UFO_SPAWN_MIN_DISTANCE_M),
          Math.random() * 360
        );
        const state = {
          key,
          ufoId,
          zoneId,
          lat: position.lat,
          lng: position.lng,
          anchor: { ...origin },
          vida: Math.max(1, Number(configured.vida) || 300),
          state: 'active',
          targetUserId: null,
          seq: 1,
          nextShotAt: Date.now() +
            Math.max(1, Number(configured.segundosEntreDisparos) || 3) * 1000,
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

  const bulletTimer = setInterval(async () => {
    for (const [id, b] of bullets) {
      if (Date.now() < b.startsAt || b.processing) continue;

      const previous = { lat: b.lat, lng: b.lng };
      const remainingM = Math.max(0, b.alcance - (b.recorrido || 0));
      const stepM = Math.min(b.speed * (TICK_MS / 1000), remainingM);
      const next = geo.computeOffset(previous, stepM, b.heading);

      // Resuelve todos los candidatos del segmento y conserva solo el primero.
      // Así una bala nunca atraviesa una torre/OVNI para impactar algo posterior.
      const candidates = [];
      const seenUsers = new Set();
      const socketsInZone = roomIndex.get(b.zoneId) || new Set();
      const shooter = playersForUser(b.byUserId)[0];
      for (const sid of socketsInZone) {
        const player = players.get(sid);
        if (!player || player.gameModeEnabled === false ||
            player.userId === b.byUserId ||
            seenUsers.has(player.userId)) continue;
        seenUsers.add(player.userId);
        // La zona segura solo afecta a proyectiles directos entre jugadores.
        // Torres, minas, ataques aereos y NPCs mantienen sus reglas actuales.
        if (shooter &&
            geo.distanceMeters(shooter, player) <=
              DIRECT_PROJECTILE_SAFE_DISTANCE_M) continue;
        const impact = segmentCircleIntersection(
          previous,
          next,
          player,
          player.skinDefinition?.renderType === 'flame_spritesheet'
            ? ANIMATED_PLAYER_HIT_RADIUS_M
            : PLAYER_HIT_RADIUS_M
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
          b.processing = true;
          try {
            const damageResult = await applyPlayerDamage({
              attackerUserId: b.byUserId,
              target,
              damage: b.dano,
              zoneId: b.zoneId,
              source: 'bullet',
              killEventId: `bullet:${id}`,
              eventData: { bulletId: id },
            });
            emitBulletExplosion(
              id,
              b,
              damageResult.protected ? 'protected' : 'hit',
              { userId: target.userId }
            );
          } catch (error) {
            console.error(`[PVP][${instanceId}] bullet damage error`, {
              bulletId: id,
              userId: target.userId,
              error: error.message,
            });
            emitBulletExplosion(id, b, 'error', { userId: target.userId });
          }
        } else if (collision.type === 'turret') {
          target.vida = Math.max(0, target.vida - b.dano);
          target.seq = (Number(target.seq) || 1) + 1;
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
              playDeathAnimation: target.renderType === 'flame_spritesheet' &&
                Boolean(target.deathSpritesheet?.url),
            });
          }
        } else {
          applyUfoDamage({
            state: target,
            damage: b.dano,
            attackerUserId: b.byUserId,
            damageEventId: `bullet:${id}:ufo:${target.ufoId}`,
          });
          emitBulletExplosion(id, b, 'ufo', { ufoId: target.ufoId });
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
        destroyUfo({ state, reason: 'expired' });
        continue;
      }
      const movementSpeed = Math.min(
        12,
        Math.max(0.5, Number(state.ufo.velocidadMovimiento) || 0.5)
      );
      let next = geo.computeOffset(
        state,
        movementSpeed,
        Math.random() * 360
      );
      if (geo.distanceMeters(next, state.anchor) > UFO_ROAM_MAX_DISTANCE_M) {
        next = geo.computeOffset(
          state.anchor,
          UFO_ROAM_RETURN_DISTANCE_M,
          Math.random() * 360
        );
      }
      state.lat = next.lat;
      state.lng = next.lng;
      const target = selectUfoTarget(state);
      const nextTargetUserId = target?.userId || null;
      if (nextTargetUserId !== state.targetUserId) {
        state.targetUserId = nextTargetUserId;
        bumpUfo(state, target ? 'targeting' : 'active');
        nsp.to(state.zoneId).emit('ufo:target', ufoPayload(state));
      }
      bumpUfo(state, state.targetUserId ? 'targeting' : 'active');
      nsp.to(state.zoneId).emit('ufo:update', ufoPayload(state));

      if (!target || now < state.nextShotAt || state.dead) continue;
      const speed = Math.max(1, Number(state.ufo.velocidadBala) || 1);
      const from = { lat: state.lat, lng: state.lng };
      const to = { lat: target.lat, lng: target.lng };
      const distance = geo.distanceMeters(from, to);
      const projectileId =
        `ufo-${state.ufoId}-${now}-${Math.random().toString(36).slice(2, 7)}`;
      const projectile = {
        projectileId,
        ufoId: state.ufoId,
        zoneId: state.zoneId,
        targetUserId: target.userId,
        from,
        to,
        speed,
        dano: Math.max(0, Number(state.ufo.danoBala) || 0),
        spriteUrl: state.ufo.imagenBala || '',
        rotationOffset: Number(state.ufo.rotationOffset) || 0,
        createdAt: now,
        impactAt: now + Math.max(1, distance / speed * 1000),
      };
      state.nextShotAt = now +
        Math.max(1, Number(state.ufo.segundosEntreDisparos) || 3) * 1000;
      activeUfoProjectiles.set(projectileId, projectile);
      nsp.to(state.zoneId).emit(
        'ufo:projectile:spawn',
        ufoProjectilePayload(projectile, now)
      );
    }
  }, 1000);
  ufoTimer.unref?.();

  const ufoProjectileTimer = setInterval(async () => {
    const now = Date.now();
    for (const [projectileId, projectile] of activeUfoProjectiles) {
      if (projectile.impactAt > now) continue;
      activeUfoProjectiles.delete(projectileId);
      const state = [...activeUfos.values()].find((candidate) =>
        candidate.ufoId === projectile.ufoId &&
        candidate.zoneId === projectile.zoneId && !candidate.dead);
      if (!state) continue;
      const target = playersForUser(projectile.targetUserId)[0];
      const hit = Boolean(
        target && target.gameModeEnabled !== false && (target.vida ?? 0) > 0 &&
        target.zoneId === projectile.zoneId &&
        geo.distanceMeters(target, projectile.to) <= 15
      );
      let result = null;
      if (hit) {
        result = await applyPlayerDamage({
          attackerUserId: '',
          target,
          damage: projectile.dano,
          zoneId: projectile.zoneId,
          source: 'ufo',
          killEventId: `ufo:${projectileId}`,
          eventData: {
            projectileId,
            ufoId: projectile.ufoId,
          },
        }).catch((error) => {
          console.error(`[PVP][${instanceId}] ufo damage error`, error);
          return null;
        });
      }
      nsp.to(projectile.zoneId).emit('ufo:projectile:impact', {
        ...ufoProjectilePayload(projectile, now),
        hit,
        vida: result?.vida ?? target?.vida ?? null,
        lat: projectile.to.lat,
        lng: projectile.to.lng,
      });
    }
  }, 50);
  ufoProjectileTimer.unref?.();

  const turretTimer = setInterval(async () => {
    const now = Date.now();
    for (const [turretId, turret] of turrets) {
      if (new Date(turret.expiresAt).getTime() <= now || turret.vida <= 0) {
        turret.seq = (Number(turret.seq) || 1) + 1;
        turrets.delete(turretId);
        await TurretModel.deleteOne({ _id: turretId }).catch(() => {});
        nsp.to(turret.zoneId).emit('turret:destroy', {
          ...turretPayload(turret),
          reason: 'expired',
          playDeathAnimation: false,
        });
        continue;
      }
      if (new Date(turret.nextShotAt).getTime() > now) continue;
      try {
        await assertGameModeEnabled(String(turret.ownerUserId));
      } catch (_) {
        continue;
      }
      const candidates = primaryAlivePlayersInZone(turret.zoneId).filter((p) =>
        p.userId !== String(turret.ownerUserId) &&
        geo.distanceMeters(turret, p) <= turret.alcance);
      candidates.sort((a, b) => geo.distanceMeters(turret, a) - geo.distanceMeters(turret, b));
      const playerTarget = candidates[0];
      const ufoCandidates = [...activeUfos.values()]
        .filter((state) => state.zoneId === turret.zoneId && !state.dead &&
          geo.distanceMeters(turret, state) <= turret.alcance)
        .sort((a, b) => geo.distanceMeters(turret, a) - geo.distanceMeters(turret, b));
      const ufoTarget = playerTarget ? null : ufoCandidates[0];
      const target = playerTarget || ufoTarget;
      if (!target) continue;
      turret.nextShotAt = new Date(now + turret.cadenciaDisparo * 1000);
      await TurretModel.updateOne({ _id: turretId }, { $set: { nextShotAt: turret.nextShotAt } }).catch(() => {});
      const shotId = `turret-${turretId}-${now}`;
      const distance = geo.distanceMeters(turret, target);
      nsp.to(turret.zoneId).emit('turret:shot', {
        shotId, turretId, ownerUserId: String(turret.ownerUserId),
        targetUserId: playerTarget?.userId || null,
        targetUfoId: ufoTarget?.ufoId || null,
        from: { lat: turret.lat, lng: turret.lng }, to: { lat: target.lat, lng: target.lng },
        speed: TURRET_BULLET_SPEED, dano: turret.dano,
        spriteUrl: turret.imagenesDisparo?.[0] || '', serverTimestamp: now,
      });
      setTimeout(async () => {
        if (!turrets.has(turretId)) return;
        if (ufoTarget) {
          const currentUfo = activeUfos.get(ufoTarget.key);
          if (!currentUfo || currentUfo.dead ||
              geo.distanceMeters(currentUfo, { lat: target.lat, lng: target.lng }) >
                UFO_HIT_RADIUS_M) return;
          applyUfoDamage({
            state: currentUfo,
            damage: turret.dano,
            attackerUserId: String(turret.ownerUserId),
            damageEventId: `turret:${shotId}:ufo:${currentUfo.ufoId}`,
          });
          nsp.to(turret.zoneId).emit('turret:shot:explode', {
            shotId,
            turretId,
            targetUfoId: currentUfo.ufoId,
            lat: target.lat,
            lng: target.lng,
          });
          return;
        }
        const current = playersForUser(target.userId)[0];
        if (!current || geo.distanceMeters(current, { lat: target.lat, lng: target.lng }) > PLAYER_HIT_RADIUS_M) return;
        const result = await applyPlayerDamage({
          attackerUserId: String(turret.ownerUserId),
          target: current,
          damage: turret.dano,
          zoneId: turret.zoneId,
          source: 'turret',
          killEventId: `turret:${shotId}`,
          eventData: { byTurretId: turretId, shotId },
        }).catch((error) => {
          console.error(`[PVP][${instanceId}] turret damage error`, error);
          return null;
        });
        nsp.to(turret.zoneId).emit('turret:shot:explode', { shotId, turretId, lat: target.lat, lng: target.lng });
        if (result?.killed) {
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
        mine.seq = (Number(mine.seq) || 1) + 1;
        mines.delete(mineId);
        await MineModel.deleteOne({ _id: mineId }).catch(() => {});
        nsp.to(mine.zoneId).emit('mine:destroy', {
          ...minePayload(mine),
          reason: 'expired',
        });
        continue;
      }
      if (mine.processing) continue;

      const candidatesByUser = new Map();
      for (const player of players.values()) {
        if (player.gameModeEnabled === false ||
            player.zoneId !== mine.zoneId || (player.vida ?? 0) <= 0) {
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
      if (!targetEntry) {
        mine.playersInside = currentlyInside;
        continue;
      }

      try {
        await assertGameModeEnabled(String(mine.ownerUserId));
      } catch (_) {
        continue;
      }
      mine.playersInside = currentlyInside;

      const target = candidatesByUser.get(targetEntry);
      if (!target) continue;
      mine.processing = true;

      const damageResult = await applyPlayerDamage({
        attackerUserId: String(mine.ownerUserId),
        target,
        damage: mine.dano,
        zoneId: mine.zoneId,
        source: 'mine',
        killEventId: `mine:${mineId}:${target.userId}`,
        eventData: { byMineId: mineId },
      }).catch((error) => {
        console.error(`[PVP][${instanceId}] mine damage error`, error);
        return { protected: false, vida: target.vida ?? MAX_PLAYER_LIFE };
      });

      // Una mina siempre se destruye al detonar.
      const removeAfterTrigger = true;
      mine.seq = (Number(mine.seq) || 1) + 1;
      mines.delete(mineId);
      await MineModel.deleteOne({ _id: mineId }).catch(() => {});

      nsp.to(mine.zoneId).emit('mine:trigger', {
        ...minePayload(mine),
        targetUserId: target.userId,
        vida: damageResult.vida,
        protected: damageResult.protected,
        removed: removeAfterTrigger,
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
        airstrike.seq = (Number(airstrike.seq) || 1) + 1;
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
      let ownerCanAttack = true;
      try {
        await assertGameModeEnabled(String(airstrike.ownerUserId));
      } catch (_) {
        ownerCanAttack = false;
      }
      airstrike.seq = (Number(airstrike.seq) || 1) + 1;
      airstrikes.delete(airstrikeId);
      await AirstrikeModel.deleteOne({ _id: airstrikeId }).catch(() => {});

      if (!ownerCanAttack) {
        nsp.to(airstrike.zoneId).emit('airstrike:impact', {
          ...airstrikePayload(airstrike),
          hits: [],
          cancelled: true,
        });
        continue;
      }

      const targetsByUser = new Map();
      for (const player of players.values()) {
        if (player.gameModeEnabled === false ||
            player.zoneId !== airstrike.zoneId ||
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
        const damageResult = await applyPlayerDamage({
          attackerUserId: String(airstrike.ownerUserId),
          target,
          damage: airstrike.dano,
          zoneId: airstrike.zoneId,
          source: 'airstrike',
          killEventId: `airstrike:${airstrikeId}:${target.userId}`,
          eventData: { byAirstrikeId: airstrikeId },
        }).catch((error) => {
          console.error(`[PVP][${instanceId}] airstrike damage error`, error);
          return { protected: false, vida: target.vida ?? MAX_PLAYER_LIFE };
        });
        hits.push({
          userId: target.userId,
          vida: damageResult.vida,
          protected: damageResult.protected,
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
    const baseCard = await CardModel.findById(cardId).lean();
    if (!baseCard) throw new Error('Carta no existe');
    if (baseCard.tipoArma !== 'Proyectil') throw new Error('Carta no es Proyectil');
    let owner = null;
    if (requireSocketAuth) {
      owner = await UserModel.findOne({
        _id: byUserId,
        cartas: cardId,
        mazo: cardId,
      }).select('_id cardUpgrades').lean();
      if (!owner) throw new Error('La carta no está disponible en tu mazo');
    }

    // Alcance / Daño / Velocidad máximos
    const card = effectiveCard(
      baseCard,
      upgradeLevelForUser(owner, cardId),
    );
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
      spriteUrl: card.projectileRenderType === 'flame_spritesheet'
        ? card.projectileSpritesheet?.url
        : card.imagenesArma?.[0],
      explosionFrames: Array.isArray(card.imagenesExplosion) ? card.imagenesExplosion : [],
      projectileRenderType: card.projectileRenderType || 'classic',
      explosionRenderType: card.explosionRenderType || 'classic',
      projectileSpritesheet: card.projectileSpritesheet || null,
      explosionSpritesheet: card.explosionSpritesheet || null,
    };
  }

  nsp.use(async (socket, next) => {
    if (!requireSocketAuth) return next();
    const raw = String(
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization ||
      ''
    );
    const token = raw.startsWith('Bearer ') ? raw.slice(7) : raw;
    if (!token) return next(new Error('Token PVP no proporcionado'));
    try {
      const identity = await resolveSocketIdentity(token);
      if (!identity?.id) return next(new Error('Token PVP sin usuario'));
      socket.data.authUserId = String(identity.id);
      // El rol procede del documento MongoDB, nunca del handshake del cliente.
      socket.data.authRole = identity.role;
      socket.data.authType = identity.authType;
      next();
    } catch (_error) {
      next(new Error('Token PVP inválido'));
    }
  });

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
          nickname: requestedNickname = 'Jugador',
        } = payload || {};
        const requestedUserId = rawUserId?.toString().trim();
        const userId = socket.data.authUserId || requestedUserId;
        if (socket.data.authUserId && requestedUserId && requestedUserId !== socket.data.authUserId) {
          return cb?.({ ok: false, error: 'El userId no coincide con el token' });
        }
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

        let authoritativeNickname = requestedNickname;
        let authoritativeSkinUrl = typeof skinUrl === 'string' ? skinUrl.trim() : '';
        let skinDefinition = null;
        let skinId = '';
        let gameModeEnabled = true;
        if (socket.data.authUserId) {
          const authoritative = await loadAuthoritativeIdentityAndSkin(userId);
          const user = authoritative.user;
          if (!user) return cb?.({ ok: false, error: 'Usuario no encontrado' });
          if (!user.nickname) {
            return cb?.({ ok: false, error: 'Debes elegir un nickname', code: 'NICKNAME_REQUIRED' });
          }
          gameModeEnabled = user.gameModeEnabled !== false;
          if (!gameModeEnabled) {
            return cb?.({ ok: false, error: 'Modo Juego desactivado', code: 'GAME_MODE_DISABLED' });
          }
          authoritativeNickname = user.nickname;
          authoritativeSkinUrl = authoritative.skinUrl;
          skinDefinition = authoritative.skinDefinition;
          skinId = authoritative.skinId;
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
        const clanIds = [...await ClanMembershipService.getClanIds(userId)];
        const bountyTotal = await BountyService.totalForTarget(userId).catch(() => 0);

        const now = Date.now();
        const previousPrimarySocketId = primarySocketByUser.get(userId);
        const previousPrimary = previousPrimarySocketId
          ? players.get(previousPrimarySocketId)
          : null;
        const pendingLeave = pendingPresenceLeaves.get(userId);
        if (pendingLeave) {
          clearTimeout(pendingLeave);
          pendingPresenceLeaves.delete(userId);
        }
        if (previousPrimary) previousPrimary.isPresencePrimary = false;
        const seq = nextPresenceSeq(userId);
        const presenceSessionId = `${socket.id}:${seq}`;
        const playerState = {
          userId,
          lat,
          lng,
          heading: typeof heading === 'number' ? heading : 0,
          skinUrl: authoritativeSkinUrl,
          skinId,
          skinDefinition,
          nickname: authoritativeNickname,
          zoneId,
          lastShotByCard: previous?.lastShotByCard || {},
          vida,
          clanIds,
          bountyTotal,
          seq,
          lastSeen: now,
          connectedAt: now,
          lastClientSeq: 0,
          presenceSessionId,
          isPresencePrimary: true,
          gameModeEnabled,
        };
        players.set(socket.id, playerState);
        primarySocketByUser.set(userId, socket.id);
        lastPresenceByUser.set(userId, playerState);
        // Los sockets secundarios conservan recepcion de eventos, pero comparten
        // la misma posicion logica para no crear dos blancos del mismo usuario.
        for (const sameUser of playersForUser(userId)) {
          if (sameUser === playerState) continue;
          sameUser.lat = lat;
          sameUser.lng = lng;
          sameUser.heading = playerState.heading;
          sameUser.vida = vida;
        }
        socialRealtime.register(userId, socket);

        // Enviar al que entra el estado de la sala (jugadores ya presentes)
        const othersByUserId = new Map();
        for (const p of lastPresenceByUser.values()) {
          if (p.zoneId === zoneId && p.userId !== userId) {
            othersByUserId.set(p.userId, {
              userId:p.userId,
              lat:p.lat,
              lng:p.lng,
              heading:p.heading,
              skinUrl:p.skinUrl,
              skinId:p.skinId || '',
              skinDefinition:p.skinDefinition || null,
              nickname:p.nickname,
              vida:p.vida??1000,
              clanIds:p.clanIds || [],
              bountyTotal:p.bountyTotal || 0,
              ...presenceMetadata(p),
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
        const roomUfoProjectiles = [...activeUfoProjectiles.values()]
          .filter((projectile) => projectile.zoneId === zoneId)
          .map((projectile) => ufoProjectilePayload(projectile));
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
          ufoProjectiles: roomUfoProjectiles,
          claimedStepcoins,
          clanIds,
          bountyTotal,
          instanceId,
          snapshotVersion,
          serverTimestamp: Date.now(),
        });
        log('presence registered', {
          socketId: socket.id,
          userId,
          zoneId,
          lat,
          lng,
          skinUrl: authoritativeSkinUrl,
          nickname: authoritativeNickname,
          vida,
          roomSockets: roomIndex.get(zoneId).size,
          playersReturned: others.map((p) => p.userId),
        });

        // Notificar a los demás tu spawn
        socket.to(zoneId).emit('presence:spawn', {
          userId,
          lat,
          lng,
          heading,
          skinUrl: authoritativeSkinUrl,
          skinId,
          skinDefinition,
          nickname: authoritativeNickname,
          vida,
          clanIds,
          bountyTotal,
          ...presenceMetadata(playerState),
        });
      } catch (e) {
        console.error(`[PVP][${instanceId}] presence hello error`, {
          socketId: socket.id,
          error: e.message,
        });
        cb?.({ ok:false, error: e.message });
      }
    });

    // 2) Movimiento/presencia contínua
    socket.on('presence:update', async (payload) => {
      const p = players.get(socket.id);
      if (!p) return;

      if (primarySocketByUser.get(p.userId) !== socket.id) return;
      const {
        lat,
        lng,
        heading,
        skinUrl,
        skinId: requestedSkinId,
        clientSeq,
      } = payload || {};
      if (typeof lat!=='number' || typeof lng!=='number') return;
      if (Number.isSafeInteger(clientSeq)) {
        if (clientSeq <= p.lastClientSeq) return;
        p.lastClientSeq = clientSeq;
      }

      const normalizedRequestedSkinId = String(requestedSkinId || '');
      if (socket.data.authUserId && normalizedRequestedSkinId !== String(p.skinId || '')) {
        try {
          const authoritative = await loadAuthoritativeIdentityAndSkin(p.userId);
          p.skinUrl = authoritative.skinUrl;
          p.skinId = authoritative.skinId;
          p.skinDefinition = authoritative.skinDefinition;
          p.lastSeen = Date.now();
          p.seq = nextPresenceSeq(p.userId);
          lastPresenceByUser.set(p.userId, p);
          nsp.to(p.zoneId).emit('presence:skin', {
            userId: p.userId,
            skinUrl: p.skinUrl,
            skinId: p.skinId,
            skinDefinition: p.skinDefinition,
            ...presenceMetadata(p),
          });
        } catch (error) {
          console.error(`[PVP][${instanceId}] skin refresh error`, {
            socketId: socket.id,
            userId: p.userId,
            error: error.message,
          });
        }
      }

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
      p.lastSeen = Date.now();
      p.seq = nextPresenceSeq(p.userId);
      lastPresenceByUser.set(p.userId, p);
      for (const sameUser of playersForUser(p.userId)) {
        if (sameUser === p) continue;
        sameUser.lat = p.lat;
        sameUser.lng = p.lng;
        sameUser.heading = p.heading;
        sameUser.vida = p.vida;
      }
      if (!socket.data.authUserId && typeof skinUrl === 'string') {
        p.skinUrl = skinUrl.trim();
      }
      nsp.to(p.zoneId).emit('presence:move', {
        userId: p.userId,
        lat,
        lng,
        heading: p.heading,
        skinUrl: p.skinUrl,
        skinId: p.skinId || '',
        skinDefinition: p.skinDefinition || null,
        nickname: p.nickname,
        vida: p.vida,
        clanIds: p.clanIds || [],
        bountyTotal: p.bountyTotal || 0,
        ...presenceMetadata(p),
      });
      log('presence move', {
        socketId: socket.id,
        userId: p.userId,
        lat,
        lng,
        heading: p.heading,
        skinUrl: p.skinUrl,
        nickname: p.nickname,
      });
    });

    socket.on('presence:heartbeat', (payload, cb) => {
      const p = players.get(socket.id);
      if (!p || primarySocketByUser.get(p.userId) !== socket.id) {
        return cb?.({ ok: false, secondary: Boolean(p) });
      }
      const clientSeq = payload?.clientSeq;
      if (Number.isSafeInteger(clientSeq)) {
        if (clientSeq <= p.lastClientSeq) {
          return cb?.({ ok: true, ignored: true, seq: p.seq });
        }
        p.lastClientSeq = clientSeq;
      }
      p.lastSeen = Date.now();
      lastPresenceByUser.set(p.userId, p);
      cb?.({
        ok: true,
        ...presenceMetadata(p),
      });
    });

    // Los clientes nunca informan daño ni impactos de OVNI. Se responde de
    // forma explícita para que consumidores antiguos no reintenten en bucle.
    socket.on('ufo:hurt', (_payload, cb) => {
      cb?.({ ok: false, error: 'UFO combat is server-authoritative' });
    });
    socket.on('ufo:impact', (_payload, cb) => {
      cb?.({ ok: false, error: 'UFO impacts are server-authoritative' });
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
          ...lifeMetadata(p.userId),
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
        await assertGameModeEnabled(p.userId);
        const baseCard = await CardModel.findById(cardId).lean();
        if (!baseCard || baseCard.tipoArma !== 'Vida') {
          throw new Error('Carta de Vida inválida');
        }

        // Compatibilidad con cartas Vida creadas antes de persistir vidaQueDa.
        const user = await UserModel.findOne({
          _id: p.userId,
          cartas: cardId,
          mazo: cardId,
        }).lean();
        if (!user) {
          throw new Error('La carta ya no está disponible en tu mazo');
        }

        const card = effectiveCard(
          baseCard,
          upgradeLevelForUser(user, cardId),
        );
        const configuredHealing = Number(card.vidaQueDa || card.vida);
        if (!Number.isFinite(configuredHealing) || configuredHealing <= 0) {
          throw new Error('La carta no tiene una curación válida');
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
          ...lifeMetadata(p.userId),
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
        await assertGameModeEnabled(p.userId);
        const card = await CardModel.findById(cardId).lean();
        if (!card || card.tipoArma !== 'Trampa') {
          throw new Error('Carta de Mina inválida');
        }
        if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
            geo.distanceMeters(p, { lat, lng }) > 500) {
          throw new Error('Posición de mina inválida');
        }

        const radioActivacion = Number(card.radioActivacion);
        let dano = Number(card.dano);
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
        dano = Number(effectiveCard(
          card,
          upgradeLevelForUser(user, cardId),
        ).dano);

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
        mine.seq = 1;
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
        await assertGameModeEnabled(p.userId);
        const card = await CardModel.findById(cardId).lean();
        if (!card || card.tipoArma !== 'Invocacion') {
          throw new Error('Carta de Ataque Aéreo inválida');
        }
        if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
            geo.distanceMeters(p, { lat, lng }) > 1000) {
          throw new Error('Posición de ataque inválida');
        }

        const radioExplosion = Number(card.radioExplosion);
        let dano = Number(card.dano);
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
        dano = Number(effectiveCard(
          card,
          upgradeLevelForUser(user, cardId),
        ).dano);

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
        airstrike.seq = 1;
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
        await assertGameModeEnabled(p.userId);
        const cardId = String(payload?.cardId || '');
        const baseCard = await CardModel.findById(cardId).lean();
        if (!baseCard || baseCard.tipoArma !== 'Arrastre') throw new Error('Carta de arrastre inválida');
        let owner = null;
        if (requireSocketAuth) {
          owner = await UserModel.findOne({
            _id: p.userId,
            cartas: cardId,
            mazo: cardId,
          }).lean();
          if (!owner) throw new Error('La carta no está disponible en tu mazo');
        }
        const card = effectiveCard(
          baseCard,
          upgradeLevelForUser(owner, cardId),
        );
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
          renderType: card.turretRenderType || 'classic',
          idleSpritesheet: card.turretIdleSpritesheet || undefined,
          deathSpritesheet: card.turretDeathSpritesheet || undefined,
        });
        const plain = turret.toObject();
        plain.seq = 1;
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
        await assertGameModeEnabled(p.userId);

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
        if (!Number.isFinite(from.lat) || !Number.isFinite(from.lng) ||
            from.lat < -90 || from.lat > 90 || from.lng < -180 || from.lng > 180 ||
            !Number.isFinite(heading)) {
          throw new Error('Coordenadas de bala invalidas');
        }
        const normalizedClientShotId = String(clientShotId || '').trim();
        if (!normalizedClientShotId || normalizedClientShotId.length > 160) {
          throw new Error('clientShotId invalido');
        }
        const shotKey = `${p.userId}:${normalizedClientShotId}`;
        const accepted = acceptedClientShots.get(shotKey);
        if (accepted) {
          cb?.({ ...accepted, duplicate: true });
          return;
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
        const authoritativeFrom = { lat: from.lat, lng: from.lng };
        const authoritativeHeading = ((heading % 360) + 360) % 360;
        const authoritativeSpeed = Math.min(Math.max(speed, 0), 180);
        const authoritativeExplosionFrames = Array.isArray(validated.explosionFrames) && validated.explosionFrames.length
          ? validated.explosionFrames
          : explosionFrames;
        const normalizedExplosionFrames = Array.isArray(authoritativeExplosionFrames)
          ? authoritativeExplosionFrames.filter((frame) => typeof frame === 'string' && frame.trim())
          : [];
        bullets.set(bulletId, {
          clientShotId: normalizedClientShotId,
          byUserId: p.userId,
          zoneId: p.zoneId,
          lat: authoritativeFrom.lat,
          lng: authoritativeFrom.lng,
          heading: authoritativeHeading,
          speed: authoritativeSpeed,
          alcance: validated.alcance,
          dano: validated.dano,
          spriteUrl: validated.spriteUrl || spriteUrl,
          explosionFrames: normalizedExplosionFrames,
          projectileRenderType: validated.projectileRenderType,
          explosionRenderType: validated.explosionRenderType,
          projectileSpritesheet: validated.projectileSpritesheet,
          explosionSpritesheet: validated.explosionSpritesheet,
          createdAt: Date.now(),
          startsAt: Date.now() + BULLET_START_DELAY_MS,
        });
        scheduleUfosAfterFirstShot(p.zoneId, authoritativeFrom).catch((error) => {
          console.error(`[PVP][${instanceId}] ufo schedule error`, error);
        });

        // Avisar a la sala para que los clientes la dibujen en local
        nsp.to(p.zoneId).emit('bullet:spawn', {
          bulletId, byUserId: p.userId,
          clientShotId: normalizedClientShotId,
          from: authoritativeFrom,
          heading: authoritativeHeading,
          speed: authoritativeSpeed,
          alcance: validated.alcance,
          dano: validated.dano,
          spriteUrl: validated.spriteUrl || spriteUrl,
          explosionFrames: normalizedExplosionFrames,
          projectileRenderType: validated.projectileRenderType,
          explosionRenderType: validated.explosionRenderType,
          projectileSpritesheet: validated.projectileSpritesheet,
          explosionSpritesheet: validated.explosionSpritesheet,
          startDelayMs: BULLET_START_DELAY_MS,
        });

        const acceptedAck = {
          ok:true,
          bulletId,
          clientShotId: normalizedClientShotId,
          alcance: validated.alcance,
          dano: validated.dano,
          startDelayMs: BULLET_START_DELAY_MS,
        };
        acceptedClientShots.set(shotKey, acceptedAck);
        const forgetShot = setTimeout(
          () => acceptedClientShots.delete(shotKey),
          60000,
        );
        forgetShot.unref?.();
        cb?.(acceptedAck);
        log('bullet spawned', {
          socketId: socket.id,
          bulletId,
          clientShotId: normalizedClientShotId,
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
      socialRealtime.unregister(p.userId, socket);
      const wasPrimary = primarySocketByUser.get(p.userId) === socket.id;
      let leaveEmitted = false;
      if (wasPrimary) {
        const replacementEntry = [...players.entries()]
          .filter(([, candidate]) => candidate.userId === p.userId)
          .sort(([, a], [, b]) => b.connectedAt - a.connectedAt)[0];
        if (replacementEntry) {
          const [replacementSocketId, replacement] = replacementEntry;
          replacement.isPresencePrimary = true;
          replacement.seq = nextPresenceSeq(p.userId);
          replacement.lastSeen = Date.now();
          replacement.presenceSessionId = `${replacementSocketId}:${replacement.seq}`;
          primarySocketByUser.set(p.userId, replacementSocketId);
          lastPresenceByUser.set(p.userId, replacement);
          nsp.to(replacement.zoneId).emit('presence:spawn', {
            userId: replacement.userId,
            lat: replacement.lat,
            lng: replacement.lng,
            heading: replacement.heading,
            skinUrl: replacement.skinUrl,
            skinId: replacement.skinId || '',
            skinDefinition: replacement.skinDefinition || null,
            nickname: replacement.nickname,
            vida: replacement.vida,
            clanIds: replacement.clanIds || [],
            bountyTotal: replacement.bountyTotal || 0,
            ...presenceMetadata(replacement),
          });
        } else {
          primarySocketByUser.delete(p.userId);
          const oldTimer = pendingPresenceLeaves.get(p.userId);
          if (oldTimer) clearTimeout(oldTimer);
          const leaveDelayMs = reason === 'client namespace disconnect'
            ? 0
            : presenceDisconnectGraceMs;
          const leaveTimer = setTimeout(() => {
            pendingPresenceLeaves.delete(p.userId);
            if (primarySocketByUser.has(p.userId)) return;
            const seq = nextPresenceSeq(p.userId);
            lastPresenceByUser.delete(p.userId);
            nsp.to(p.zoneId).emit('presence:leave', {
              userId: p.userId,
              seq,
              serverTimestamp: Date.now(),
              lastSeen: p.lastSeen,
              presenceSessionId: p.presenceSessionId,
              reason: 'disconnect-timeout',
            });
          }, leaveDelayMs);
          leaveTimer.unref?.();
          pendingPresenceLeaves.set(p.userId, leaveTimer);
        }
      }
      if (roomIndex.get(p.zoneId)?.size === 0) {
        roomIndex.delete(p.zoneId);
        for (const timer of pendingUfoTimers.get(p.zoneId) || []) {
          clearTimeout(timer);
        }
        pendingUfoTimers.delete(p.zoneId);
        scheduledUfoZones.delete(p.zoneId);
        for (const [key, ufo] of activeUfos) {
          if (ufo.zoneId === p.zoneId) {
            ufo.dead = true;
            activeUfos.delete(key);
            cancelUfoProjectiles(ufo, 'room-empty');
          }
        }
      }
      log('socket disconnected', {
        socketId: socket.id,
        userId: p.userId,
        reason,
        leaveEmitted,
        leaveScheduled: wasPrimary && !primarySocketByUser.has(p.userId),
        remainingPlayers: players.size,
      });
    });
  });
};
