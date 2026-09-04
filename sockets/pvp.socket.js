// sockets/pvp.socket.js
const geo  = require('../utils/geo');              // <- OK si utils está en la raíz del repo
const Card = require('../api/models/Card');
const UserLife = require('../api/models/UserLife');
const Turret = require('../api/models/Turret');
const Mine = require('../api/models/Mine');
const Airstrike = require('../api/models/Airstrike');
const User = require('../api/models/User');
const Ufo = require('../api/models/Ufo');
const PoliceConfig = require('../api/models/PoliceConfig');
const { createPoliceRuntime } = require('../api/services/policeRuntime');
const { createGroundRouteProvider } = require('../api/services/groundRouteProvider');
const { createUnitRuntime } = require('../api/services/unitRuntime');
const { resolveBearerToken } = require('../api/services/authIdentity');
const clanMembershipCache = require('../api/services/clanMembershipCache');
const bountyService = require('../api/services/bountyService');
const socialRealtime = require('../api/services/socialRealtime');
const duelWagerService = require('../api/services/duelWagerService');
const {
  publicDuelStats,
  shuffledCultureQuestions,
  newDuelId,
} = require('../api/services/duel.service');
const {
  chooseDuelGame,
  reflexDelay,
  REFLEX_LIGHT_COUNT,
  REFLEX_LIGHT_INTERVAL_MS,
} = require('../api/services/miniGameConfig');
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
  const PoliceConfigModel = dependencies.PoliceConfigModel ||
    (hasInjectedDependencies ? {
      defaults: () => ({ enabled: false, stars: [], units: {} }),
      findOne: () => ({ lean: async () => null }),
    } : PoliceConfig);
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
  const DuelWagerService = dependencies.DuelWagerService ||
    (hasInjectedDependencies
      ? {
          normalizeWager: (amount) => Math.max(0, Number(amount) || 0),
          maxWagerFor: async () => 0,
          assertWagerAvailable: async (_, amount) => ({ amount: Math.max(0, Number(amount) || 0) }),
          lockWager: async ({ amount }) => ({ amount, potTotal: amount * 2, balances: new Map() }),
          refundWager: async () => ({ balances: new Map() }),
          payPot: async ({ amount }) => ({ potTotal: amount * 2, winnerBalance: 0 }),
        }
      : duelWagerService);
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
  const duelInvites = new Map();
  const duelSessions = new Map();
  const activeDuelByUser = new Map();
  const presenceSequenceByUser = new Map();
  const lifeSequenceByUser = new Map();
  let snapshotVersion = 0;
  const presenceDisconnectGraceMs =
    dependencies.presenceDisconnectGraceMs ?? 15000;
  const duelGameChooser = dependencies.chooseDuelGame || chooseDuelGame;
  const duelStartDelayMs = dependencies.duelStartDelayMs ?? 3200;
  const memoryPreviewMs = dependencies.memoryPreviewMs ?? 2400;
  const reflexSequenceDelayMs = dependencies.reflexSequenceDelayMs;
  const turrets = new Map();
  const mines = new Map();
  const airstrikes = new Map();
  const activeUfos = new Map();
  const activeUfoProjectiles = new Map();
  const processedUfoDamageEvents = new Set();
  const scheduledUfoZones = new Set();
  const pendingUfoTimers = new Map();
  let policeRuntime = null;
  let unitRuntime = null;
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
    let query = UserModel.findById(userId).select('nickname skinSeleccionada gameModeEnabled duelStats');
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
    renderType: mine.renderType || 'classic',
    spritesheet: mine.spritesheet || null,
    explosionRenderType: mine.explosionRenderType || 'classic',
    explosionSpritesheet: mine.explosionSpritesheet || null,
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
      planeRenderType: airstrike.planeRenderType || 'classic',
      planeSpritesheet: airstrike.planeSpritesheet || null,
      bombRenderType: airstrike.bombRenderType || 'classic',
      bombSpritesheet: airstrike.bombSpritesheet || null,
      explosionRenderType: airstrike.explosionRenderType || 'classic',
      explosionSpritesheet: airstrike.explosionSpritesheet || null,
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
  const duelPresence = (player) => ({
    duelStats: publicDuelStats(player.duelStats),
  });
  const primaryPlayer = (userId) => {
    const socketId = primarySocketByUser.get(String(userId));
    return socketId ? players.get(socketId) : null;
  };
  const emitToUser = (userId, event, payload) => {
    for (const [socketId, player] of players) {
      if (String(player.userId) === String(userId)) {
        nsp.to(socketId).emit(event, payload);
      }
    }
  };
  const duelOpponent = (session, userId) =>
    session.players.find((candidate) => candidate !== String(userId));
  const updateCachedDuelStats = (userId, stats) => {
    for (const player of players.values()) {
      if (String(player.userId) === String(userId)) player.duelStats = stats;
    }
  };
  const settleDuel = async (session, loserUserId, reason) => {
    if (!session || session.status !== 'active') return;
    session.status = 'settling';
    if (session.resultTimer) clearTimeout(session.resultTimer);
    const loserId = String(loserUserId);
    const winnerId = duelOpponent(session, loserId);
    if (!winnerId) return;
    try {
      const payout = await DuelWagerService.payPot({
        duelId: session.id,
        winnerUserId: winnerId,
        loserUserId: loserId,
        amount: session.wagerPerPlayer || 0,
        reason,
      });
      await Promise.all([
        UserModel.updateOne({ _id: winnerId }, { $inc: { 'duelStats.wins': 1 } }),
        UserModel.updateOne({ _id: loserId }, { $inc: { 'duelStats.losses': 1 } }),
      ]);
      const winnerCurrent = primaryPlayer(winnerId)?.duelStats || {};
      const loserCurrent = primaryPlayer(loserId)?.duelStats || {};
      const winnerStats = publicDuelStats({
        ...winnerCurrent,
        wins: (Number(winnerCurrent.wins) || 0) + 1,
      });
      const loserStats = publicDuelStats({
        ...loserCurrent,
        losses: (Number(loserCurrent.losses) || 0) + 1,
      });
      updateCachedDuelStats(winnerId, winnerStats);
      updateCachedDuelStats(loserId, loserStats);
      const payload = {
        duelId: session.id,
        winnerUserId: winnerId,
        loserUserId: loserId,
        reason,
        wagerPerPlayer: session.wagerPerPlayer || 0,
        potTotal: payout.potTotal || 0,
        stats: { [winnerId]: winnerStats, [loserId]: loserStats },
      };
      if ((session.wagerPerPlayer || 0) > 0) {
        emitToUser(winnerId, 'duel:wager-balance', {
          duelId: session.id,
          balance: payout.winnerBalance,
          delta: payout.potTotal,
          reason: 'pot-paid',
        });
      }
      emitToUser(winnerId, 'duel:finished', payload);
      emitToUser(loserId, 'duel:finished', payload);
    } catch (error) {
      console.error(`[PVP][${instanceId}] duel settlement error`, error);
      session.status = 'active';
      return;
    }
    session.status = 'finished';
    duelSessions.delete(session.id);
    for (const userId of session.players) activeDuelByUser.delete(userId);
  };
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
    policeRuntime?.clearWanted(normalizedUserId, 'game-mode-disabled');
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
        killRewardPaid: bounty.killReward || 0,
        bountyPaid: bounty.paid || 0,
      });
    }
    if (killed) policeRuntime?.handlePlayerDeath(targetUserId);
    return { protected: false, vida: nuevaVida, killed };
  }

  const applyUnitDamageToTurret = async (
    turretId,
    damage,
    attackerUserId,
    _eventId,
  ) => {
    const turret = turrets.get(String(turretId));
    if (!turret || turret.vida <= 0) {
      return { applied: false, dead: true, vida: 0 };
    }
    turret.vida = Math.max(0, turret.vida - Math.max(0, Number(damage) || 0));
    turret.seq = (Number(turret.seq) || 1) + 1;
    await TurretModel.updateOne(
      { _id: turretId },
      { $set: { vida: turret.vida } },
    ).catch(() => {});
    if (turret.vida > 0) {
      nsp.to(turret.zoneId).emit('turret:update', turretPayload(turret));
      return { applied: true, dead: false, vida: turret.vida };
    }
    turrets.delete(String(turretId));
    await TurretModel.deleteOne({ _id: turretId }).catch(() => {});
    nsp.to(turret.zoneId).emit('turret:destroy', {
      ...turretPayload(turret),
      reason: 'destroyed',
      attackerUserId: String(attackerUserId || ''),
      playDeathAnimation: turret.renderType === 'flame_spritesheet' &&
        Boolean(turret.deathSpritesheet?.url),
    });
    return { applied: true, dead: true, vida: 0 };
  };

  const sharedGroundRouteProvider = dependencies.UnitRouteProvider ||
    dependencies.PoliceRouteProvider || createGroundRouteProvider();

  policeRuntime = createPoliceRuntime({
    nsp,
    geo,
    PoliceConfigModel,
    applyPlayerDamage,
    playersForUser,
    primaryAlivePlayersInZone: (zoneId) => primaryAlivePlayersInZone(zoneId),
    routeProvider: sharedGroundRouteProvider,
  });

  unitRuntime = createUnitRuntime({
    nsp,
    geo,
    routeProvider: sharedGroundRouteProvider,
    getPlayersInZone: (zoneId) => primaryAlivePlayersInZone(zoneId),
    getTurretsInZone: (zoneId) => [...turrets.values()]
      .filter((turret) => turret.zoneId === zoneId && turret.vida > 0),
    getPoliceUnitsInZone: (zoneId) => policeRuntime.getUnitsInZone(zoneId),
    isPoliceHostileToUser: (unitId, userId) =>
      policeRuntime.isUnitHostileToUser(unitId, userId),
    areUsersAllied: (ownerUserId, candidateOwnerUserId) =>
      ClanMembershipService.shareActiveClan(ownerUserId, candidateOwnerUserId),
    applyPlayerDamage,
    applyTurretDamage: applyUnitDamageToTurret,
    applyPoliceDamage: (unitId, damage, attackerUserId, eventId) =>
      policeRuntime.applyBulletDamage(unitId, damage, attackerUserId, eventId),
  });

  // Tick de balas (server-authoritative)
  const TICK_MS = 50;
  // El cliente ya representa el disparo inmediatamente. Iniciar también la
  // simulación autoritativa sin una espera artificial evita que ambas
  // trayectorias se separen antes del impacto.
  const BULLET_START_DELAY_MS = 0;
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
    const serverTimestamp = Date.now();
    nsp.to(bullet.zoneId).emit('bullet:explode', {
      bulletId,
      clientShotId: bullet.clientShotId,
      byUserId: bullet.byUserId,
      hitUserId: hit.userId || null,
      hitTurretId: hit.turretId || null,
      hitUfoId: hit.ufoId || null,
      hitUnitId: hit.unitId || null,
      reason,
      lat: bullet.lat,
      lng: bullet.lng,
      spriteUrl: bullet.spriteUrl,
      explosionFrames: bullet.explosionFrames,
      explosionRenderType: bullet.explosionRenderType,
      explosionSpritesheet: bullet.explosionSpritesheet,
      startsAt: bullet.startsAt,
      impactAt: serverTimestamp,
      serverTimestamp,
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
      renderType: projectile.renderType || 'classic',
      spritesheet: projectile.spritesheet || null,
      rotationOffset: projectile.rotationOffset || 0,
      createdAt: new Date(projectile.createdAt).toISOString(),
      impactAt: new Date(projectile.impactAt).toISOString(),
      serverTimestamp: now,
    };
  };

  const emitBulletImpact = (bulletId, bullet, hit = {}) => {
    const serverTimestamp = Date.now();
    nsp.to(bullet.zoneId).emit('bullet:impact', {
      bulletId,
      clientShotId: bullet.clientShotId,
      byUserId: bullet.byUserId,
      hitUserId: hit.userId || null,
      hitTurretId: hit.turretId || null,
      hitUfoId: hit.ufoId || null,
      policeUnitId: hit.policeUnitId || null,
      unitId: hit.unitId || null,
      lat: bullet.lat,
      lng: bullet.lng,
      startsAt: bullet.startsAt,
      impactAt: serverTimestamp,
      serverTimestamp,
    });
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
          !zonesAreLocal(player.zoneId, zoneId) || (player.vida ?? 0) <= 0) continue;
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

  const scheduleUfosAfterClientHome = async (zoneId, origin) => {
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
      const spawnWhenPolicePursuitEnds = () => {
        pendingUfoTimers.get(zoneId)?.delete(timer);
        if ((roomIndex.get(zoneId)?.size || 0) === 0) return;
        if (policeRuntime.hasActivePursuitInZone(zoneId)) {
          timer = setTimeout(spawnWhenPolicePursuitEnds, 1000);
          pendingUfoTimers.get(zoneId)?.add(timer);
          timer.unref?.();
          return;
        }
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
      };
      let timer = setTimeout(spawnWhenPolicePursuitEnds, delayMs);
      if (!pendingUfoTimers.has(zoneId)) {
        pendingUfoTimers.set(zoneId, new Set());
      }
      pendingUfoTimers.get(zoneId).add(timer);
      timer.unref?.();
    }
    log('ufos scheduled after client home opened', {
      zoneId,
      count: configuredUfos.length,
      scheduledAt,
    });
  };

  let bulletTickRunning = false;
  const bulletTimer = setInterval(async () => {
    if (bulletTickRunning) return;
    bulletTickRunning = true;
    const tickNow = Date.now();
    try {
      for (const [id, b] of bullets) {
        if (tickNow < b.startsAt || b.processing) continue;

        const previous = { lat: b.lat, lng: b.lng };
        const remainingM = Math.max(0, b.alcance - (b.recorrido || 0));
        const previousTickAt = Math.max(b.lastAdvancedAt || b.startsAt, b.startsAt);
        const elapsedMs = Math.max(0, tickNow - previousTickAt);
        if (elapsedMs <= 0) continue;
        b.lastAdvancedAt = tickNow;
        const stepM = Math.min(b.speed * (elapsedMs / 1000), remainingM);
      const next = geo.computeOffset(previous, stepM, b.heading);

      // Resuelve todos los candidatos del segmento y conserva solo el primero.
      // Así una bala nunca atraviesa una torre/OVNI para impactar algo posterior.
      const candidates = [];
      const seenUsers = new Set();
      const socketsInZone = new Set();
      for (const localZoneId of neighboringZoneIds(b.zoneId)) {
        for (const sid of roomIndex.get(localZoneId) || []) socketsInZone.add(sid);
      }
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
        if (!zonesAreLocal(turret.zoneId, b.zoneId) ||
            String(turret.ownerUserId) === b.byUserId) continue;
        const impact = segmentCircleIntersection(
          previous, next, turret, PLAYER_HIT_RADIUS_M
        );
        if (impact) {
          candidates.push({ type: 'turret', target: turret, turretId, impact });
        }
      }
      for (const state of activeUfos.values()) {
        if (!zonesAreLocal(state.zoneId, b.zoneId)) continue;
        const impact = segmentCircleIntersection(
          previous, next, state, UFO_HIT_RADIUS_M
        );
        if (impact) candidates.push({ type: 'ufo', target: state, impact });
      }
      for (const unit of policeRuntime.getUnitsInZone(b.zoneId)) {
        const impact = segmentCircleIntersection(
          previous,
          next,
          unit,
          Number(unit.definition.hitRadiusMeters) || PLAYER_HIT_RADIUS_M
        );
        if (impact) candidates.push({ type: 'police', target: unit, impact });
      }
      for (const unit of unitRuntime.getUnitsInZone(b.zoneId)) {
        if (unit.ownerUserId === b.byUserId ||
            await ClanMembershipService.shareActiveClan(
              b.byUserId,
              unit.ownerUserId,
            )) continue;
        const impact = segmentCircleIntersection(
          previous,
          next,
          unit,
          Number(unit.hitRadiusMeters) || PLAYER_HIT_RADIUS_M,
        );
        if (impact) candidates.push({ type: 'unit', target: unit, impact });
      }
      candidates.sort((a, c) => a.impact.t - c.impact.t);
      const collision = candidates[0];
      if (collision) {
        const { impact, target } = collision;
        b.lat = impact.lat;
        b.lng = impact.lng;
        b.recorrido = (b.recorrido || 0) + stepM * impact.t;
        emitBulletImpact(id, b, {
          userId: collision.type === 'player' ? target.userId : null,
          turretId: collision.type === 'turret' ? collision.turretId : null,
          ufoId: collision.type === 'ufo' ? target.ufoId : null,
          policeUnitId: collision.type === 'police' ? target.unitId : null,
          unitId: collision.type === 'unit' ? target.unitId : null,
        });

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
        } else if (collision.type === 'police') {
          policeRuntime.applyBulletDamage(
            target.unitId,
            b.dano,
            b.byUserId,
            `bullet:${id}:police:${target.unitId}`
          );
          emitBulletExplosion(id, b, 'police', {
            policeUnitId: target.unitId,
          });
        } else if (collision.type === 'unit') {
          unitRuntime.applyDamage(
            target.unitId,
            b.dano,
            b.byUserId,
            `bullet:${id}:unit:${target.unitId}`,
          );
          emitBulletExplosion(id, b, 'unit', { unitId: target.unitId });
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
    } finally {
      bulletTickRunning = false;
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
        renderType: state.ufo.bulletRenderType || 'classic',
        spritesheet: state.ufo.bulletSpritesheet || null,
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
        zonesAreLocal(target.zoneId, projectile.zoneId) &&
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
      const candidates = [];
      for (const player of primaryAlivePlayersInZone(turret.zoneId)) {
        if (player.userId === String(turret.ownerUserId) ||
            geo.distanceMeters(turret, player) > turret.alcance ||
            await ClanMembershipService.shareActiveClan(
              String(turret.ownerUserId),
              String(player.userId),
            )) continue;
        candidates.push(player);
      }
      candidates.sort((a, b) => geo.distanceMeters(turret, a) - geo.distanceMeters(turret, b));
      const playerTarget = candidates[0];
      const ufoCandidates = [...activeUfos.values()]
        .filter((state) => state.zoneId === turret.zoneId && !state.dead &&
          geo.distanceMeters(turret, state) <= turret.alcance)
        .sort((a, b) => geo.distanceMeters(turret, a) - geo.distanceMeters(turret, b));
      const ufoTarget = playerTarget ? null : ufoCandidates[0];
      const policeCandidates = policeRuntime.getUnitsInZone(turret.zoneId)
        .filter((unit) => unit.life > 0 &&
          policeRuntime.isUnitHostileToUser(unit.unitId, String(turret.ownerUserId)) &&
          geo.distanceMeters(turret, unit) <= turret.alcance)
        .sort((a, b) => geo.distanceMeters(turret, a) - geo.distanceMeters(turret, b));
      const policeTarget = playerTarget || ufoTarget ? null : policeCandidates[0];
      const unitCandidates = [];
      if (!playerTarget && !ufoTarget && !policeTarget) {
        for (const unit of unitRuntime.getUnitsInZone(turret.zoneId)) {
          if (String(unit.ownerUserId) === String(turret.ownerUserId) ||
              geo.distanceMeters(turret, unit) > turret.alcance ||
              await ClanMembershipService.shareActiveClan(
                String(turret.ownerUserId),
                String(unit.ownerUserId),
              )) continue;
          unitCandidates.push(unit);
        }
        unitCandidates.sort((a, b) =>
          geo.distanceMeters(turret, a) - geo.distanceMeters(turret, b));
      }
      const unitTarget = playerTarget || ufoTarget || policeTarget
        ? null
        : unitCandidates[0];
      const target = playerTarget || ufoTarget || policeTarget || unitTarget;
      if (!target) continue;
      turret.nextShotAt = new Date(now + turret.cadenciaDisparo * 1000);
      await TurretModel.updateOne({ _id: turretId }, { $set: { nextShotAt: turret.nextShotAt } }).catch(() => {});
      const shotId = `turret-${turretId}-${now}`;
      const distance = geo.distanceMeters(turret, target);
      nsp.to(turret.zoneId).emit('turret:shot', {
        shotId, turretId, ownerUserId: String(turret.ownerUserId),
        targetUserId: playerTarget?.userId || null,
        targetUfoId: ufoTarget?.ufoId || null,
        targetPoliceUnitId: policeTarget?.unitId || null,
        targetUnitId: unitTarget?.unitId || null,
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
        if (policeTarget) {
          const currentPolice = policeRuntime.getUnitsInZone(turret.zoneId)
            .find((unit) => unit.unitId === policeTarget.unitId);
          if (!currentPolice ||
              !policeRuntime.isUnitHostileToUser(
                currentPolice.unitId,
                String(turret.ownerUserId)
              ) || geo.distanceMeters(
            currentPolice,
            { lat: target.lat, lng: target.lng }
          ) > (Number(currentPolice.definition.hitRadiusMeters) || PLAYER_HIT_RADIUS_M)) return;
          policeRuntime.applyBulletDamage(
            currentPolice.unitId,
            turret.dano,
            String(turret.ownerUserId),
            `turret:${shotId}:police:${currentPolice.unitId}`,
          );
          nsp.to(turret.zoneId).emit('turret:shot:explode', {
            shotId,
            turretId,
            targetPoliceUnitId: currentPolice.unitId,
            lat: target.lat,
            lng: target.lng,
          });
          return;
        }
        if (unitTarget) {
          const currentUnit = unitRuntime.getUnitsInZone(turret.zoneId)
            .find((unit) => unit.unitId === unitTarget.unitId);
          if (!currentUnit || geo.distanceMeters(
            currentUnit,
            { lat: target.lat, lng: target.lng },
          ) > (Number(currentUnit.hitRadiusMeters) || PLAYER_HIT_RADIUS_M)) return;
          unitRuntime.applyDamage(
            currentUnit.unitId,
            turret.dano,
            String(turret.ownerUserId),
            `turret:${shotId}:unit:${currentUnit.unitId}`,
          );
          nsp.to(turret.zoneId).emit('turret:shot:explode', {
            shotId,
            turretId,
            targetUnitId: currentUnit.unitId,
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
            !zonesAreLocal(player.zoneId, mine.zoneId) || (player.vida ?? 0) <= 0) {
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
      const policeById = new Map(policeRuntime.getUnitsInZone(mine.zoneId)
        .filter((unit) => unit.life > 0 &&
          geo.distanceMeters(mine, unit) <= mine.radioActivacion)
        .map((unit) => [unit.unitId, unit]));
      const policeCurrentlyInside = new Set(policeById.keys());
      mine.policeInside ||= new Set();
      const policeTargetId = targetEntry ? null : [...policeCurrentlyInside]
        .find((unitId) => !mine.policeInside.has(unitId));
      const unitsById = new Map();
      for (const unit of unitRuntime.getUnitsInZone(mine.zoneId)) {
        if (String(unit.ownerUserId) === String(mine.ownerUserId) ||
            geo.distanceMeters(mine, unit) > mine.radioActivacion ||
            await ClanMembershipService.shareActiveClan(
              String(mine.ownerUserId),
              String(unit.ownerUserId),
            )) continue;
        unitsById.set(unit.unitId, unit);
      }
      const unitsCurrentlyInside = new Set(unitsById.keys());
      mine.unitsInside ||= new Set();
      const unitTargetId = targetEntry || policeTargetId ? null :
        [...unitsCurrentlyInside].find((unitId) => !mine.unitsInside.has(unitId));
      if (!targetEntry && !policeTargetId && !unitTargetId) {
        mine.playersInside = currentlyInside;
        mine.policeInside = policeCurrentlyInside;
        mine.unitsInside = unitsCurrentlyInside;
        continue;
      }

      try {
        await assertGameModeEnabled(String(mine.ownerUserId));
      } catch (_) {
        continue;
      }
      mine.playersInside = currentlyInside;
      mine.policeInside = policeCurrentlyInside;
      mine.unitsInside = unitsCurrentlyInside;

      const target = targetEntry ? candidatesByUser.get(targetEntry) : null;
      const policeTarget = policeTargetId ? policeById.get(policeTargetId) : null;
      const unitTarget = unitTargetId ? unitsById.get(unitTargetId) : null;
      if (!target && !policeTarget && !unitTarget) continue;
      mine.processing = true;

      const damageResult = unitTarget
        ? unitRuntime.applyDamage(
          unitTarget.unitId,
          mine.dano,
          String(mine.ownerUserId),
          `mine:${mineId}:unit:${unitTarget.unitId}`,
        )
        : policeTarget
        ? policeRuntime.applyBulletDamage(
          policeTarget.unitId,
          mine.dano,
          String(mine.ownerUserId),
          `mine:${mineId}:police:${policeTarget.unitId}`,
        )
        : await applyPlayerDamage({
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
        targetUserId: target?.userId || null,
        targetPoliceUnitId: policeTarget?.unitId || null,
        targetUnitId: unitTarget?.unitId || null,
        vida: damageResult?.vida ?? null,
        policeLife: damageResult?.life ?? null,
        unitLife: unitTarget ? (damageResult?.life ?? 0) : null,
        protected: damageResult?.protected || false,
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
            !zonesAreLocal(player.zoneId, airstrike.zoneId) ||
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
      for (const policeTarget of policeRuntime.getUnitsInZone(airstrike.zoneId)) {
        if (policeTarget.life <= 0 ||
            geo.distanceMeters(airstrike, policeTarget) > airstrike.radioExplosion) {
          continue;
        }
        const damageResult = policeRuntime.applyBulletDamage(
          policeTarget.unitId,
          airstrike.dano,
          String(airstrike.ownerUserId),
          `airstrike:${airstrikeId}:police:${policeTarget.unitId}`,
        );
        hits.push({
          policeUnitId: policeTarget.unitId,
          life: damageResult.life ?? 0,
          dead: damageResult.dead === true,
        });
      }
      for (const unitTarget of unitRuntime.getUnitsInZone(airstrike.zoneId)) {
        if (unitTarget.life <= 0 ||
            geo.distanceMeters(airstrike, unitTarget) > airstrike.radioExplosion ||
            (String(unitTarget.ownerUserId) !== String(airstrike.ownerUserId) &&
              await ClanMembershipService.shareActiveClan(
                String(airstrike.ownerUserId),
                String(unitTarget.ownerUserId),
              ))) continue;
        const damageResult = unitRuntime.applyDamage(
          unitTarget.unitId,
          airstrike.dano,
          String(airstrike.ownerUserId),
          `airstrike:${airstrikeId}:unit:${unitTarget.unitId}`,
        );
        hits.push({
          unitId: unitTarget.unitId,
          life: damageResult.life ?? 0,
          dead: damageResult.dead === true,
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
    // Celda local de ~1 km; la vecindad 3x3 evita cortes en sus límites.
    const latCell = Math.floor((lat + 90) / 0.01);
    const lngCell = Math.floor((lng + 180) / 0.01);
    return `geo:${latCell}:${lngCell}`;
  }

  function zoneCoordinates(zoneId) {
    const match = /^geo:(\d+):(\d+)$/.exec(String(zoneId));
    return match ? { latCell: Number(match[1]), lngCell: Number(match[2]) } : null;
  }

  function neighboringZoneIds(zoneId) {
    const cell = zoneCoordinates(zoneId);
    if (!cell) return new Set();
    const result = new Set();
    for (let latOffset = -1; latOffset <= 1; latOffset += 1) {
      for (let lngOffset = -1; lngOffset <= 1; lngOffset += 1) {
        result.add(`geo:${cell.latCell + latOffset}:${cell.lngCell + lngOffset}`);
      }
    }
    return result;
  }

  function zonesAreLocal(firstZoneId, secondZoneId) {
    return neighboringZoneIds(firstZoneId).has(secondZoneId);
  }

  function updateZoneSubscriptions(socket, previousZoneId, nextZoneId) {
    const previousRooms = previousZoneId
      ? neighboringZoneIds(previousZoneId)
      : new Set();
    const nextRooms = neighboringZoneIds(nextZoneId);
    for (const room of previousRooms) {
      if (!nextRooms.has(room)) socket.leave(room);
    }
    for (const room of nextRooms) {
      if (!previousRooms.has(room)) socket.join(room);
    }
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
    const packetWindowMs = 10 * 1000;
    const packetLimit = Math.max(100, Number(process.env.SOCKET_EVENTS_PER_10_SECONDS) || 300);
    let packetWindowStartedAt = Date.now();
    let packetCount = 0;
    socket.use((_packet, next) => {
      const now = Date.now();
      if (now - packetWindowStartedAt >= packetWindowMs) {
        packetWindowStartedAt = now;
        packetCount = 0;
      }
      packetCount += 1;
      if (packetCount > packetLimit) return next(new Error('Demasiados eventos PVP'));
      return next();
    });
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
        if (!userId || !Number.isFinite(lat) || !Number.isFinite(lng) ||
            lat < -90 || lat > 90 || lng < -180 || lng > 180) {
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
        let duelStats = publicDuelStats();
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
          duelStats = publicDuelStats(user.duelStats);
        }

        const zoneId = toZoneId(lat, lng);
        const previous = players.get(socket.id);
        if (previous) {
          roomIndex.get(previous.zoneId)?.delete(socket.id);
        }
        updateZoneSubscriptions(socket, previous?.zoneId, zoneId);
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
          duelStats,
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
        scheduleUfosAfterClientHome(zoneId, { lat, lng }).catch((error) => {
          console.error(`[PVP][${instanceId}] ufo schedule error`, error);
        });

        // Enviar al que entra el estado de la sala (jugadores ya presentes)
        const othersByUserId = new Map();
        for (const p of lastPresenceByUser.values()) {
          if (zonesAreLocal(p.zoneId, zoneId) && p.userId !== userId) {
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
              ...duelPresence(p),
              ...presenceMetadata(p),
            });
          }
        }
        const others = [...othersByUserId.values()];
        await turretsReady;
        await minesReady;
        await airstrikesReady;
        const roomTurrets = [...turrets.values()]
          .filter((t) => zonesAreLocal(t.zoneId, zoneId))
          .map(turretPayload);
        const roomMines = [...mines.values()]
          .filter((mine) => zonesAreLocal(mine.zoneId, zoneId))
          .map(minePayload);
        const roomAirstrikes = [...airstrikes.values()]
          .filter((airstrike) => zonesAreLocal(airstrike.zoneId, zoneId))
          .map(airstrikePayload);
        const roomUfos = [...activeUfos.values()]
          .filter((ufo) => zonesAreLocal(ufo.zoneId, zoneId))
          .map(ufoPayload);
        const roomUfoProjectiles = [...activeUfoProjectiles.values()]
          .filter((projectile) => zonesAreLocal(projectile.zoneId, zoneId))
          .map((projectile) => ufoProjectilePayload(projectile));
        await policeRuntime.ensureAmbientPatrol(playerState, { lat, lng });
        const policeSnapshot = policeRuntime.getSnapshot(zoneId);
        const unitSnapshot = unitRuntime.getSnapshot(zoneId);
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
          ...policeSnapshot,
          ...unitSnapshot,
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
          ...duelPresence(playerState),
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
      if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
          lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
      if (Number.isSafeInteger(clientSeq)) {
        if (clientSeq <= p.lastClientSeq) return;
        p.lastClientSeq = clientSeq;
      }
      const elapsedSeconds = Math.max(0, (Date.now() - p.lastSeen) / 1000);
      const maximumJumpMeters = Math.max(10000, elapsedSeconds * 100);
      if (geo.distanceMeters(p, { lat, lng }) > maximumJumpMeters) {
        log('presence jump rejected', {
          socketId: socket.id,
          userId: p.userId,
          from: { lat: p.lat, lng: p.lng },
          to: { lat, lng },
        });
        return;
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
      const previousZone = p.zoneId;
      const previouslyLocal = new Map();
      const newlyLocal = new Map();
      if (newZone !== previousZone) {
        for (const other of lastPresenceByUser.values()) {
          if (other.userId === p.userId) continue;
          if (zonesAreLocal(other.zoneId, previousZone)) {
            previouslyLocal.set(other.userId, other);
          }
          if (zonesAreLocal(other.zoneId, newZone)) {
            newlyLocal.set(other.userId, other);
          }
        }
      }
      if (newZone !== p.zoneId) {
        roomIndex.get(p.zoneId)?.delete(socket.id);
        updateZoneSubscriptions(socket, p.zoneId, newZone);
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
      if (newZone !== previousZone) {
        const leavePayload = {
          userId: p.userId,
          seq: p.seq,
          serverTimestamp: Date.now(),
          lastSeen: p.lastSeen,
          presenceSessionId: p.presenceSessionId,
          reason: 'left-local-area',
        };
        for (const [otherUserId, other] of previouslyLocal) {
          if (newlyLocal.has(otherUserId)) continue;
          emitToUser(otherUserId, 'presence:leave', leavePayload);
          emitToUser(p.userId, 'presence:leave', {
            userId: other.userId,
            seq: other.seq,
            serverTimestamp: Date.now(),
            lastSeen: other.lastSeen,
            presenceSessionId: other.presenceSessionId,
            reason: 'left-local-area',
          });
        }
        for (const [otherUserId, other] of newlyLocal) {
          if (previouslyLocal.has(otherUserId)) continue;
          emitToUser(otherUserId, 'presence:spawn', {
            userId: p.userId,
            lat: p.lat,
            lng: p.lng,
            heading: p.heading,
            skinUrl: p.skinUrl,
            skinId: p.skinId || '',
            skinDefinition: p.skinDefinition || null,
            nickname: p.nickname,
            vida: p.vida,
            clanIds: p.clanIds || [],
            bountyTotal: p.bountyTotal || 0,
            ...duelPresence(p),
            ...presenceMetadata(p),
          });
          emitToUser(p.userId, 'presence:spawn', {
            userId: other.userId,
            lat: other.lat,
            lng: other.lng,
            heading: other.heading,
            skinUrl: other.skinUrl,
            skinId: other.skinId || '',
            skinDefinition: other.skinDefinition || null,
            nickname: other.nickname,
            vida: other.vida,
            clanIds: other.clanIds || [],
            bountyTotal: other.bountyTotal || 0,
            ...duelPresence(other),
            ...presenceMetadata(other),
          });
        }
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
        ...duelPresence(p),
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

    socket.on('unit:place', async (payload, cb) => {
      const p = players.get(socket.id);
      if (!p) return cb?.({ ok: false, error: 'No player' });
      const cardId = String(payload?.cardId || '');
      const lat = Number(payload?.lat);
      const lng = Number(payload?.lng);
      try {
        await assertGameModeEnabled(p.userId);
        const baseCard = await CardModel.findById(cardId).lean();
        if (!baseCard || baseCard.tipoArma !== 'TROPA') {
          throw new Error('Carta TROPA invalida');
        }
        const owner = await UserModel.findOne({
          _id: p.userId,
          cartas: cardId,
          mazo: cardId,
        }).lean();
        if (!owner) throw new Error('La carta no esta disponible en tu mazo');
        const card = effectiveCard(
          baseCard,
          upgradeLevelForUser(owner, cardId),
        );
        const maximumPlacement = Number(card.distanciaMaximaColocacion);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
            !Number.isFinite(maximumPlacement) || maximumPlacement <= 0 ||
            geo.distanceMeters(p, { lat, lng }) > maximumPlacement) {
          throw new Error('Posicion de TROPA invalida');
        }
        const required = [
          card.numeroUnidades,
          card.rangoDeteccion,
          card.rangoAtaque,
          card.distanciaMaximaPersecucion,
          card.vida,
          card.velocidadMovimiento,
          card.dano,
          card.cooldownAtaque,
          card.duracion,
        ];
        if (!required.every((value) => Number.isFinite(Number(value)) && Number(value) > 0) ||
            !Number.isFinite(Number(card.separacionUnidades)) ||
            Number(card.separacionUnidades) < 0 ||
            !card.unitIdleSpritesheet?.url || !card.unitWalkSpritesheet?.url ||
            !card.unitAttackSpritesheet?.url) {
          throw new Error('La carta TROPA no tiene una configuracion valida');
        }
        const cooldownKey = `unit:${cardId}`;
        const cooldownMs = Math.max(0, Number(card.tiempoEspera) || 0) * 1000;
        const lastPlacedAt = p.lastShotByCard?.[cooldownKey] || 0;
        if (Date.now() - lastPlacedAt < cooldownMs) {
          throw new Error('Carta en tiempo de espera');
        }
        const spawned = unitRuntime.spawnGroup({
          ownerUserId: p.userId,
          cardId,
          zoneId: toZoneId(lat, lng),
          position: { lat, lng },
          definition: {
            unitCount: Number(card.numeroUnidades),
            unitSpacingMeters: Number(card.separacionUnidades),
            life: Number(card.vida),
            detectionRangeMeters: Number(card.rangoDeteccion),
            attackRangeMeters: Number(card.rangoAtaque),
            maxPursuitDistanceMeters: Number(card.distanciaMaximaPersecucion),
            speedMetersPerSecond: Number(card.velocidadMovimiento),
            damage: Number(card.dano),
            attackCooldownSeconds: Number(card.cooldownAtaque),
            durationSeconds: Number(card.duracion),
            idleSpritesheet: card.unitIdleSpritesheet,
            walkSpritesheet: card.unitWalkSpritesheet,
            attackSpritesheet: card.unitAttackSpritesheet,
          },
        });
        const placedAt = Date.now();
        for (const sameUser of playersForUser(p.userId)) {
          sameUser.lastShotByCard = {
            ...(sameUser.lastShotByCard || {}),
            [cooldownKey]: placedAt,
          };
        }
        cb?.({ ok: true, units: spawned, cooldownMs });
      } catch (error) {
        console.error(`[PVP][${instanceId}] unit placement error`, {
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
          renderType: card.mineRenderType || 'classic',
          spritesheet: card.mineSpritesheet || null,
          explosionRenderType: card.mineExplosionRenderType || 'classic',
          explosionSpritesheet: card.mineExplosionSpritesheet || null,
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
          planeRenderType: card.airstrikePlaneRenderType || 'classic',
          planeSpritesheet: card.airstrikePlaneSpritesheet || null,
          bombRenderType: card.airstrikeBombRenderType || 'classic',
          bombSpritesheet: card.airstrikeBombSpritesheet || null,
          explosionRenderType: card.airstrikeExplosionRenderType || 'classic',
          explosionSpritesheet: card.airstrikeExplosionSpritesheet || null,
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
        const createdAt = Date.now();
        const startsAt = createdAt + BULLET_START_DELAY_MS;
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
          createdAt,
          startsAt,
          lastAdvancedAt: startsAt,
        });
        policeRuntime.onPlayerShot(p, authoritativeFrom).catch((error) => {
          console.error(`[PVP][${instanceId}] police trigger error`, error);
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
          createdAt,
          startsAt,
          serverTimestamp: Date.now(),
        });

        const acceptedAck = {
          ok:true,
          bulletId,
          clientShotId: normalizedClientShotId,
          from: authoritativeFrom,
          heading: authoritativeHeading,
          speed: authoritativeSpeed,
          alcance: validated.alcance,
          dano: validated.dano,
          startDelayMs: BULLET_START_DELAY_MS,
          createdAt,
          startsAt,
          serverTimestamp: Date.now(),
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

    socket.on('duel:profile', async (payload, cb) => {
      const requester = players.get(socket.id);
      const target = primaryPlayer(payload?.targetUserId);
      if (!requester || !target) {
        return cb?.({ ok: false, error: 'Jugador no disponible' });
      }
      try {
        const maxWager = await DuelWagerService.maxWagerFor([
          requester.userId,
          target.userId,
        ]);
        cb?.({
          ok: true,
          userId: target.userId,
          nickname: target.nickname,
          maxWager,
          ...duelPresence(target),
        });
      } catch (_) {
        cb?.({ ok: false, error: 'No se pudo consultar el saldo disponible' });
      }
    });

    socket.on('duel:challenge', async (payload, cb) => {
      const challenger = players.get(socket.id);
      const target = primaryPlayer(payload?.targetUserId);
      if (!challenger || primarySocketByUser.get(challenger.userId) !== socket.id) {
        return cb?.({ ok: false, error: 'Presencia no disponible' });
      }
      if (!target || target.userId === challenger.userId) {
        return cb?.({ ok: false, error: 'Rival no disponible' });
      }
      if (geo.distanceMeters(challenger, target) >= 50) {
        return cb?.({ ok: false, error: 'El rival debe estar a menos de 50 metros' });
      }
      const usersBusy = activeDuelByUser.has(challenger.userId) ||
        activeDuelByUser.has(target.userId) ||
        [...duelInvites.values()].some((invite) =>
          invite.status === 'pending' && (
            invite.players.includes(challenger.userId) ||
            invite.players.includes(target.userId)
          ));
      if (usersBusy) return cb?.({ ok: false, error: 'Uno de los jugadores ya está ocupado' });

      let wagerPerPlayer;
      try {
        const wager = await DuelWagerService.assertWagerAvailable(
          [challenger.userId, target.userId],
          payload?.wagerPerPlayer,
        );
        wagerPerPlayer = wager.amount;
      } catch (error) {
        return cb?.({ ok: false, error: error.message });
      }

      const invite = {
        id: newDuelId('invite'),
        challengerUserId: challenger.userId,
        targetUserId: target.userId,
        players: [challenger.userId, target.userId],
        status: 'pending',
        expiresAt: Date.now() + 20000,
        wagerPerPlayer,
      };
      duelInvites.set(invite.id, invite);
      const publicInvite = {
        inviteId: invite.id,
        challengerUserId: challenger.userId,
        challengerNickname: challenger.nickname,
        targetUserId: target.userId,
        expiresAt: invite.expiresAt,
        wagerPerPlayer,
        potTotal: wagerPerPlayer * 2,
      };
      emitToUser(target.userId, 'duel:challenge', publicInvite);
      cb?.({ ok: true, ...publicInvite });
      const timer = setTimeout(() => {
        if (invite.status !== 'pending') return;
        invite.status = 'expired';
        duelInvites.delete(invite.id);
        emitToUser(challenger.userId, 'duel:expired', { inviteId: invite.id });
        emitToUser(target.userId, 'duel:expired', { inviteId: invite.id });
      }, 20000);
      timer.unref?.();
    });

    socket.on('duel:respond', async (payload, cb) => {
      const responder = players.get(socket.id);
      const invite = duelInvites.get(String(payload?.inviteId || ''));
      if (!responder || !invite || invite.targetUserId !== responder.userId ||
          invite.status !== 'pending' || invite.expiresAt <= Date.now()) {
        return cb?.({ ok: false, error: 'El reto ya no está disponible' });
      }
      invite.status = payload?.accept === true ? 'accepted' : 'rejected';
      duelInvites.delete(invite.id);
      if (invite.status === 'rejected') {
        emitToUser(invite.challengerUserId, 'duel:declined', { inviteId: invite.id });
        return cb?.({ ok: true, accepted: false });
      }
      if (!primaryPlayer(invite.challengerUserId) ||
          activeDuelByUser.has(invite.challengerUserId) ||
          activeDuelByUser.has(invite.targetUserId)) {
        return cb?.({ ok: false, error: 'El rival ya no está disponible' });
      }

      const duelId = newDuelId();
      let wagerLock;
      let startedSession;
      try {
        wagerLock = await DuelWagerService.lockWager({
          inviteId: invite.id,
          duelId,
          userIds: invite.players,
          amount: invite.wagerPerPlayer,
        });

        const game = duelGameChooser();
        const questions = game === 'culture' ? shuffledCultureQuestions() : [];
        const startsAt = Date.now() + duelStartDelayMs;
        const releaseAt = game === 'reflex'
          ? startsAt + (reflexSequenceDelayMs ??
            REFLEX_LIGHT_COUNT * REFLEX_LIGHT_INTERVAL_MS + reflexDelay())
          : null;
        const session = {
          id: duelId,
          inviteId: invite.id,
          players: [...invite.players],
          game,
          status: 'active',
          wagerPerPlayer: wagerLock.amount,
          potTotal: wagerLock.potTotal,
          seed: Math.floor(Math.random() * 0x7fffffff),
          questions,
          questionIndexByUser: new Map(invite.players.map((userId) => [userId, 0])),
          startedAt: Date.now(),
          startsAt,
          releaseAt,
          reflexResults: new Map(),
        };
        startedSession = session;
        if (game === 'reflex') {
          session.resultTimer = setTimeout(() => {
            if (session.status !== 'active') return;
            const missing = session.players.find((userId) => !session.reflexResults.has(userId));
            if (missing) settleDuel(session, missing, 'reaction-timeout');
          }, Math.max(1, releaseAt + 10000 - Date.now()));
        }
        duelSessions.set(session.id, session);
        for (const userId of session.players) activeDuelByUser.set(userId, session.id);
        for (const userId of session.players) {
          const balance = wagerLock.balances.get(String(userId));
          if (balance != null && wagerLock.amount > 0) {
            emitToUser(userId, 'duel:wager-balance', {
              duelId: session.id,
              balance,
              delta: -wagerLock.amount,
              reason: 'stake-locked',
            });
          }
          const opponent = primaryPlayer(duelOpponent(session, userId));
          emitToUser(userId, 'duel:started', {
            duelId: session.id,
            game,
            seed: session.seed,
            wagerPerPlayer: session.wagerPerPlayer,
            potTotal: session.potTotal,
            opponentUserId: opponent?.userId,
            opponentNickname: opponent?.nickname || 'Rival',
            questions: questions.map(({ id, question, options }) => ({ id, question, options })),
            startedAt: session.startedAt,
            startsAt: session.startsAt,
            releaseAt: session.releaseAt,
          });
        }
        cb?.({ ok: true, accepted: true, duelId: session.id });
      } catch (error) {
        if (startedSession) {
          if (startedSession.resultTimer) clearTimeout(startedSession.resultTimer);
          duelSessions.delete(startedSession.id);
          for (const userId of startedSession.players) activeDuelByUser.delete(userId);
        }
        if (wagerLock) {
          try {
            const refund = await DuelWagerService.refundWager({
              inviteId: invite.id,
              duelId,
              userIds: invite.players,
              amount: invite.wagerPerPlayer,
              reason: 'start-error',
            });
            for (const userId of invite.players) {
              const balance = refund.balances.get(String(userId));
              if (balance != null) emitToUser(userId, 'duel:wager-balance', {
                duelId,
                balance,
                delta: invite.wagerPerPlayer,
                reason: 'start-refund',
              });
            }
          } catch (refundError) {
            console.error(`[PVP][${instanceId}] duel wager refund error`, refundError);
          }
        }
        emitToUser(invite.challengerUserId, 'duel:cancelled', {
          inviteId: invite.id,
          error: error.message || 'No se pudo iniciar el duelo',
        });
        emitToUser(invite.targetUserId, 'duel:cancelled', {
          inviteId: invite.id,
          error: error.message || 'No se pudo iniciar el duelo',
        });
        cb?.({ ok: false, error: error.message || 'No se pudo iniciar el duelo' });
      }
    });

    socket.on('duel:answer', (payload, cb) => {
      const player = players.get(socket.id);
      const session = duelSessions.get(String(payload?.duelId || ''));
      if (!player || !session || session.status !== 'active' ||
          session.game !== 'culture' || !session.players.includes(player.userId)) {
        return cb?.({ ok: false, error: 'Sesión de duelo no válida' });
      }
      const expected = session.questionIndexByUser.get(player.userId) || 0;
      if (Number(payload?.questionIndex) !== expected) {
        return cb?.({ ok: false, error: 'Pregunta fuera de orden' });
      }
      const question = session.questions[expected % session.questions.length];
      if (Number(payload?.optionIndex) !== question.correctIndex) {
        cb?.({ ok: true, correct: false });
        settleDuel(session, player.userId, 'wrong-answer');
        return;
      }
      session.questionIndexByUser.set(player.userId, expected + 1);
      cb?.({ ok: true, correct: true, nextQuestionIndex: expected + 1 });
    });

    socket.on('duel:death', (payload, cb) => {
      const player = players.get(socket.id);
      const session = duelSessions.get(String(payload?.duelId || ''));
      if (!player || !session || session.game !== 'space' ||
          !session.players.includes(player.userId)) {
        return cb?.({ ok: false, error: 'Sesión de duelo no válida' });
      }
      cb?.({ ok: true });
      settleDuel(session, player.userId, 'death');
    });

    socket.on('duel:memory-complete', (payload, cb) => {
      const player = players.get(socket.id);
      const session = duelSessions.get(String(payload?.duelId || ''));
      if (!player || !session || session.status !== 'active' ||
          session.game !== 'memory' || !session.players.includes(player.userId)) {
        return cb?.({ ok: false, error: 'Sesión de duelo no válida' });
      }
      const earliest = session.startsAt + memoryPreviewMs;
      if (Date.now() < earliest - 150) {
        return cb?.({ ok: false, error: 'La partida todavía no ha comenzado' });
      }
      cb?.({ ok: true });
      settleDuel(session, duelOpponent(session, player.userId), 'memory-complete');
    });

    socket.on('duel:reflex-result', (payload, cb) => {
      const player = players.get(socket.id);
      const session = duelSessions.get(String(payload?.duelId || ''));
      if (!player || !session || session.status !== 'active' ||
          session.game !== 'reflex' || !session.players.includes(player.userId) ||
          session.reflexResults.has(player.userId)) {
        return cb?.({ ok: false, error: 'Sesión de duelo no válida' });
      }
      const receivedAt = Date.now();
      const falseStart = payload?.falseStart === true || receivedAt < session.releaseAt;
      if (falseStart) {
        cb?.({ ok: true, falseStart: true });
        settleDuel(session, player.userId, 'false-start');
        return;
      }
      const result = { reactionMs: receivedAt - session.releaseAt, receivedAt };
      session.reflexResults.set(player.userId, result);
      cb?.({ ok: true, reactionMs: result.reactionMs });
      if (session.reflexResults.size === session.players.length) {
        const [firstId, secondId] = session.players;
        const first = session.reflexResults.get(firstId);
        const second = session.reflexResults.get(secondId);
        const loser = first.reactionMs === second.reactionMs
          ? (first.receivedAt <= second.receivedAt ? secondId : firstId)
          : (first.reactionMs > second.reactionMs ? firstId : secondId);
        settleDuel(session, loser, 'reaction-time');
      }
    });

    socket.on('duel:forfeit', (payload, cb) => {
      const player = players.get(socket.id);
      const session = duelSessions.get(String(payload?.duelId || ''));
      if (!player || !session || !session.players.includes(player.userId)) {
        return cb?.({ ok: false, error: 'Sesión de duelo no válida' });
      }
      cb?.({ ok: true });
      settleDuel(session, player.userId, 'forfeit');
    });

    socket.on('police:leave', () => {
      const p = players.get(socket.id);
      if (p) policeRuntime.clearWanted(p.userId, 'client-background');
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
            ...duelPresence(replacement),
            ...presenceMetadata(replacement),
          });
        } else {
          const duelId = activeDuelByUser.get(p.userId);
          if (duelId) settleDuel(duelSessions.get(duelId), p.userId, 'disconnect');
          policeRuntime.handleDisconnect(p.userId);
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
            unitRuntime.removeOwner(p.userId, 'owner-left');
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
