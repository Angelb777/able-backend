const { createPoliceDirections } = require('./policeDirections');

const MAX_STARS = 5;
const PROJECTILE_TICK_MS = 50;

function bearingBetween(from, to) {
  const rad = (value) => value * Math.PI / 180;
  const y = Math.sin(rad(to.lng - from.lng)) * Math.cos(rad(to.lat));
  const x = Math.cos(rad(from.lat)) * Math.sin(rad(to.lat)) -
    Math.sin(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.cos(rad(to.lng - from.lng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function plain(value) {
  return value && typeof value.toObject === 'function' ? value.toObject() : value;
}

function createPoliceRuntime({
  nsp, geo, PoliceConfigModel, applyPlayerDamage, playersForUser,
  primaryAlivePlayersInZone, routeProvider, now = () => Date.now(), random = Math.random,
} = {}) {
  const incidents = new Map();
  const wantedUsers = new Map();
  const pendingTriggers = new Map();
  const projectiles = new Map();
  const processedDamage = new Set();
  let config = null;
  let configLoadedAt = 0;
  let lastLogicAt = 0;
  let serial = 0;
  const directions = routeProvider || createPoliceDirections();

  const defaults = () => PoliceConfigModel?.defaults?.() || ({ enabled: false, stars: [], units: {} });
  const loadConfig = async (force = false) => {
    if (!force && config && now() - configLoadedAt < 30000) return config;
    let stored = null;
    try {
      const query = PoliceConfigModel?.findOne?.({ key: 'global' });
      stored = query?.lean ? await query.lean() : await query;
    } catch (error) {
      console.error('[POLICE] config read error', error.message);
    }
    config = { ...defaults(), ...(plain(stored) || {}) };
    config.stars = Array.isArray(config.stars) && config.stars.length === 5
      ? config.stars.map(plain) : defaults().stars;
    config.units = { ...defaults().units, ...(plain(config.units) || {}) };
    configLoadedAt = now();
    return config;
  };

  const starConfig = (stars) => config?.stars?.[Math.max(1, Math.min(MAX_STARS, stars)) - 1];
  const wantedPayload = (state) => ({
    userId: state.userId, incidentId: state.incidentId || null,
    stars: state.stars || 0, escapingStar: state.escapeStartedAt ? state.stars : null,
    escapeStartedAt: state.escapeStartedAt ? new Date(state.escapeStartedAt).toISOString() : null,
    escapeLossAt: state.escapeLossAt ? new Date(state.escapeLossAt).toISOString() : null,
    seq: state.seq || 1, serverTimestamp: now(),
  });
  const emitWanted = (state, zoneId) => nsp.to(zoneId).emit('police:wanted:update', wantedPayload(state));
  const unitPayload = (unit) => ({
    unitId: unit.unitId, incidentId: unit.incidentId, unitType: unit.unitType,
    movementType: unit.definition.movementType, lat: unit.lat, lng: unit.lng,
    heading: unit.heading || 0, life: unit.life, maxLife: unit.maxLife,
    targetUserId: unit.targetUserId || null, state: unit.state || 'active',
    seq: unit.seq || 1, serverTimestamp: now(), definition: unit.definition,
  });
  const projectilePayload = (shot, timestamp = now()) => {
    const duration = Math.max(1, shot.impactAt - shot.createdAt);
    const progress = Math.max(0, Math.min(1, (timestamp - shot.createdAt) / duration));
    return {
      projectileId: shot.projectileId, unitId: shot.unitId, incidentId: shot.incidentId,
      targetUserId: shot.targetUserId, from: shot.from, to: shot.to,
      visualFrom: { lat: shot.from.lat + (shot.to.lat - shot.from.lat) * progress,
        lng: shot.from.lng + (shot.to.lng - shot.from.lng) * progress },
      speed: shot.speed, damage: shot.damage, spriteUrl: shot.spriteUrl,
      projectileRenderType: shot.projectileRenderType,
      projectileSpritesheet: shot.projectileSpritesheet,
      impactSpriteUrl: shot.impactSpriteUrl, impactRenderType: shot.impactRenderType,
      impactSpritesheet: shot.impactSpritesheet,
      createdAt: new Date(shot.createdAt).toISOString(),
      impactAt: new Date(shot.impactAt).toISOString(), serverTimestamp: timestamp,
    };
  };
  const incidentPayload = (incident) => ({
    incidentId: incident.incidentId, lat: incident.center.lat, lng: incident.center.lng,
    waveLevel: incident.waveLevel || 0, wantedUserIds: [...incident.wanted.keys()],
    state: incident.state, seq: incident.seq || 1, serverTimestamp: now(),
  });

  const cancelUnitProjectiles = (unit, reason) => {
    for (const [id, shot] of projectiles) {
      if (shot.unitId !== unit.unitId) continue;
      projectiles.delete(id);
      nsp.to(unit.zoneId).emit('police:projectile:cancel', {
        projectileId: id, unitId: unit.unitId, reason, serverTimestamp: now(),
      });
    }
  };
  const removeIncident = (incident, reason) => {
    if (!incident || !incidents.has(incident.incidentId)) return;
    incident.state = 'ended'; incident.seq += 1;
    for (const unit of incident.units.values()) {
      cancelUnitProjectiles(unit, reason);
      unit.seq += 1;
      nsp.to(incident.zoneId).emit('police:unit:destroy', { ...unitPayload(unit), reason });
    }
    incident.units.clear(); incidents.delete(incident.incidentId);
    nsp.to(incident.zoneId).emit('police:incident:end', { ...incidentPayload(incident), reason });
  };
  const clearWanted = (userId, reason = 'escaped') => {
    const id = String(userId); pendingTriggers.delete(id);
    const state = wantedUsers.get(id); if (!state) return false;
    const incident = incidents.get(state.incidentId);
    wantedUsers.delete(id);
    state.stars = 0; state.escapeStartedAt = null; state.escapeLossAt = null; state.seq += 1;
    if (incident) {
      incident.wanted.delete(id); incident.seq += 1; emitWanted(state, incident.zoneId);
      if (incident.wanted.size === 0) {
        incident.state = 'ambient';
        incident.waveLevel = 1;
        incident.pendingWaveAt = null;
        for (const unit of [...incident.units.values()]) {
          cancelUnitProjectiles(unit, reason);
          nsp.to(unit.zoneId).emit('police:unit:destroy', {
            ...unitPayload(unit),
            reason: 'pursuit-ended',
            attackerUserId: null,
          });
        }
        incident.units.clear();
        spawnAmbientPatrol(incident);
      }
      nsp.to(incident.zoneId).emit('police:incident:update', incidentPayload(incident));
    }
    return true;
  };

  const selectIncident = (position) => {
    const ordered = [...incidents.values()].filter((item) => item.state !== 'ended')
      .map((item) => ({ item, distance: geo.distanceMeters(item.center, position) }))
      .sort((a, b) => a.distance - b.distance);
    const reusable = ordered.find((entry) => entry.distance <= config.reuseRadiusMeters);
    if (reusable) return reusable.item;
    if (incidents.size >= config.maxActiveIncidents) return ordered[0]?.item || null;
    return null;
  };
  const createIncident = (player, origin, state = 'pending') => {
    const incidentId = `police-${now()}-${++serial}`;
    const incident = { incidentId, zoneId: player.zoneId, center: { ...origin },
      state, wanted: new Map(), units: new Map(), seq: 1,
      waveLevel: 0, pendingWaveAt: null, waveCompleting: false };
    incidents.set(incidentId, incident);
    nsp.to(player.zoneId).emit('police:incident:spawn', incidentPayload(incident));
    return incident;
  };
  const scheduleWave = (incident, level, delayMs) => {
    if (!incident || incident.units.size > 0 || incident.pendingWaveAt) return;
    incident.waveLevel = Math.max(1, Math.min(MAX_STARS, level));
    incident.pendingWaveAt = now() + Math.max(0, delayMs);
    incident.state = 'pending'; incident.seq += 1;
    nsp.to(incident.zoneId).emit('police:wave:scheduled', {
      ...incidentPayload(incident), spawnAt: new Date(incident.pendingWaveAt).toISOString(),
    });
  };
  const joinIncident = (player, origin, preferredIncident = null) => {
    const incident = preferredIncident || selectIncident(origin) || createIncident(player, origin);
    const existing = wantedUsers.get(String(player.userId));
    if (existing) return incidents.get(existing.incidentId) || incident;
    const state = { userId: String(player.userId), incidentId: incident.incidentId,
      stars: 1, escapeStartedAt: null, escapeLossAt: null, seq: 1 };
    wantedUsers.set(state.userId, state); incident.wanted.set(state.userId, state);
    incident.state = 'active';
    incident.waveLevel = Math.max(1, incident.waveLevel || 1);
    for (const unit of incident.units.values()) unit.state = 'active';
    incident.seq += 1; emitWanted(state, incident.zoneId);
    nsp.to(incident.zoneId).emit('police:incident:update', incidentPayload(incident));
    if (incident.units.size === 0 && !incident.pendingWaveAt) scheduleWave(incident, 1, 0);
    return incident;
  };
  const onPlayerShot = async (player, origin) => {
    await ensureAmbientPatrol(player, origin);
  };

  const spawnUnit = (incident, type, index, total, state = 'active', options = {}) => {
    const definition = plain(config.units[type]); if (!definition) return;
    const unitId = `${incident.incidentId}-${type}-${++serial}`;
    const position = options.position || geo.computeOffset(incident.center,
      Number(config.spawnDistanceMeters) || 180, ((index + 1) / (total + 1)) * 360);
    const unit = { unitId, incidentId: incident.incidentId, zoneId: incident.zoneId,
      unitType: type, definition: { ...definition }, lat: position.lat, lng: position.lng,
      heading: Number(options.heading) || 0, life: Math.max(1, Number(definition.life) || 1),
      maxLife: Math.max(1, Number(definition.life) || 1), seq: 1, state,
      targetUserId: null, targetLockedUntil: 0, nextShotAt: now(), route: [], routeIndex: 0,
      routeTarget: null, routePending: false, patrolTarget: null,
      formationIndex: Number.isInteger(options.formationIndex) ? options.formationIndex : null };
    incident.units.set(unitId, unit);
    nsp.to(incident.zoneId).emit('police:unit:spawn', unitPayload(unit));
    return unit;
  };
  const spawnWave = (incident) => {
    const level = starConfig(incident.waveLevel); if (!level) return;
    incident.pendingWaveAt = null; incident.state = 'active'; incident.seq += 1;
    const counts = { foot: Number(level.footOfficers) || 0, car: Number(level.cars) || 0,
      helicopter: Number(level.helicopters) || 0 };
    const activeTotal = [...incidents.values()]
      .reduce((sum, item) => sum + item.units.size, 0);
    const globalAvailable = Math.max(0,
      (Number(config.maxNearbyUnits) || 60) - activeTotal);
    const total = Math.min(Number(config.maxUnitsPerIncident) || 30,
      globalAvailable, counts.foot + counts.car + counts.helicopter);
    if (total <= 0) {
      incident.state = 'pending';
      incident.pendingWaveAt = now() + 1000;
      return;
    }
    let created = 0;
    for (const type of ['foot', 'car', 'helicopter']) {
      for (let i = 0; i < counts[type] && created < total; i += 1) spawnUnit(incident, type, created++, total);
    }
    nsp.to(incident.zoneId).emit('police:wave:spawn', incidentPayload(incident));
  };

  const spawnAmbientPatrol = (incident) => {
    if (!incident || incident.units.size > 0) return incident;
    incident.waveLevel = 1;
    incident.state = 'ambient';
    incident.pendingWaveAt = null;
    incident.seq += 1;
    const configured = Math.max(0, Number(starConfig(1)?.footOfficers) || 0);
    const activeTotal = [...incidents.values()].reduce((sum, item) => sum + item.units.size, 0);
    const total = Math.min(
      configured,
      Number(config.maxUnitsPerIncident) || 30,
      Math.max(0, (Number(config.maxNearbyUnits) || 60) - activeTotal),
    );
    const patrolHeading = random() * 360;
    const patrolAnchor = geo.computeOffset(
      incident.center,
      Number(config.spawnDistanceMeters) || 180,
      patrolHeading,
    );
    const spacing = Math.max(1, Number(config.patrolPairSpacingMeters) || 3);
    incident.ambientPatrolTarget = null;
    incident.ambientPatrolLeaderId = null;
    for (let index = 0; index < total; index += 1) {
      const position = index === 0
        ? patrolAnchor
        : geo.computeOffset(patrolAnchor, spacing * index, patrolHeading + 90);
      const unit = spawnUnit(incident, 'foot', index, total, 'idle', {
        position,
        formationIndex: index,
        heading: patrolHeading,
      });
      if (index === 0) incident.ambientPatrolLeaderId = unit?.unitId || null;
    }
    nsp.to(incident.zoneId).emit('police:wave:spawn', incidentPayload(incident));
    return incident;
  };

  async function ensureAmbientPatrol(player, origin = player) {
    const loaded = await loadConfig();
    if (!loaded.enabled || !player?.zoneId || player.gameModeEnabled === false || (player.vida ?? 0) <= 0) {
      return null;
    }
    const position = { lat: Number(origin?.lat), lng: Number(origin?.lng) };
    if (!Number.isFinite(position.lat) || !Number.isFinite(position.lng)) return null;
    const existing = selectIncident(position);
    if (existing) return existing;
    return spawnAmbientPatrol(createIncident(player, position, 'ambient'));
  }

  const validTarget = (incident, userId) => {
    if (!userId || !incident.wanted.has(String(userId))) return null;
    const player = playersForUser(String(userId))[0];
    return player && player.gameModeEnabled !== false && (player.vida ?? 0) > 0 ? player : null;
  };
  const selectTarget = (incident, unit, timestamp) => {
    const current = validTarget(incident, unit.targetUserId);
    if (current && timestamp < unit.targetLockedUntil) return current;
    const candidates = [...incident.wanted.values()].map((wanted) => ({
      wanted, player: validTarget(incident, wanted.userId),
    })).filter((item) => item.player).sort((a, b) => b.wanted.stars - a.wanted.stars ||
      geo.distanceMeters(unit, a.player) - geo.distanceMeters(unit, b.player));
    const selected = candidates[0]?.player || null;
    if ((selected?.userId || null) !== unit.targetUserId) {
      unit.targetUserId = selected?.userId || null; unit.seq += 1;
      nsp.to(unit.zoneId).emit('police:unit:target', unitPayload(unit));
    }
    unit.targetLockedUntil = timestamp + Math.max(500, Number(config.targetLockSeconds) * 1000 || 4000);
    return selected;
  };
  const moveToward = (unit, destination, distance) => {
    const remaining = geo.distanceMeters(unit, destination);
    if (remaining <= distance) { unit.lat = destination.lat; unit.lng = destination.lng; return distance - remaining; }
    unit.heading = bearingBetween(unit, destination);
    const next = geo.computeOffset(unit, distance, unit.heading); unit.lat = next.lat; unit.lng = next.lng; return 0;
  };
  const requestRoute = (unit, target) => {
    const threshold = Number(config.routeRecalculationDistanceMeters) || 100;
    if (unit.routePending || (unit.routeTarget && unit.route.length > unit.routeIndex &&
      geo.distanceMeters(unit.routeTarget, target) < threshold)) return;
    unit.routePending = true; const from = { lat: unit.lat, lng: unit.lng };
    const destination = { lat: target.lat, lng: target.lng };
    directions.getRoute(from, destination, unit.definition.routeMode || 'driving', {
      ttlMs: Math.max(30000, Number(config.routeCacheTtlSeconds) * 1000 || 300000),
    }).then((points) => {
      if (!incidents.get(unit.incidentId)?.units.has(unit.unitId)) return;
      if (Array.isArray(points) && points.length > 1) {
        unit.route = points; unit.routeIndex = 1; unit.routeTarget = destination;
      }
    }).finally(() => { unit.routePending = false; });
  };
  const moveUnit = (unit, target, elapsedSeconds) => {
    const budget = Math.max(0, Number(unit.definition.speedMetersPerSecond) || 0) * elapsedSeconds;
    if (unit.definition.movementType === 'air') { moveToward(unit, target, budget); return; }
    requestRoute(unit, target); let remaining = budget;
    while (remaining > 0 && unit.routeIndex < unit.route.length) {
      remaining = moveToward(unit, unit.route[unit.routeIndex], remaining);
      if (geo.distanceMeters(unit, unit.route[unit.routeIndex]) < 1) unit.routeIndex += 1;
      else break;
    }
  };
  const moveAmbientPatrol = (incident, elapsedSeconds) => {
    const units = [...incident.units.values()].filter((unit) => unit.unitType === 'foot');
    if (units.length === 0) return;
    const leader = incident.units.get(incident.ambientPatrolLeaderId) || units[0];
    const patrolRadius = Math.max(40, Number(config.spawnDistanceMeters) || 180);
    if (!incident.ambientPatrolTarget || geo.distanceMeters(leader, incident.ambientPatrolTarget) < 3) {
      incident.ambientPatrolTarget = geo.computeOffset(
        incident.center,
        patrolRadius * (0.45 + random() * 0.55),
        random() * 360,
      );
      leader.route = [];
      leader.routeIndex = 0;
      leader.routeTarget = null;
    }
    moveUnit(leader, incident.ambientPatrolTarget, elapsedSeconds);
    const spacing = Math.max(1, Number(config.patrolPairSpacingMeters) || 3);
    for (const follower of units) {
      if (follower.unitId === leader.unitId) continue;
      const index = Math.max(1, Number(follower.formationIndex) || 1);
      const desired = geo.computeOffset(leader, spacing * index, (leader.heading || 0) + 90);
      const distance = geo.distanceMeters(follower, desired);
      const baseBudget = Math.max(0, Number(follower.definition.speedMetersPerSecond) || 0) * elapsedSeconds;
      moveToward(follower, desired, distance > spacing * 2 ? baseBudget * 2 : baseBudget);
      follower.heading = leader.heading;
    }
  };
  const fire = (incident, unit, target, timestamp) => {
    const distance = geo.distanceMeters(unit, target);
    if (distance > (Number(unit.definition.rangeMeters) || 0) || timestamp < unit.nextShotAt) return;
    const speed = Math.max(1, Number(unit.definition.projectileSpeedMetersPerSecond) || 1);
    const projectileId = `police-shot-${++serial}-${timestamp}`;
    const shot = { projectileId, unitId: unit.unitId, incidentId: incident.incidentId,
      zoneId: unit.zoneId, targetUserId: String(target.userId),
      from: { lat: unit.lat, lng: unit.lng }, to: { lat: target.lat, lng: target.lng },
      speed, damage: Math.max(0, Number(unit.definition.damage) || 0),
      spriteUrl: unit.definition.projectileSpriteUrl || '',
      projectileRenderType: unit.definition.projectileRenderType || 'classic',
      projectileSpritesheet: plain(unit.definition.projectileSpritesheet) || null,
      impactSpriteUrl: unit.definition.impactSpriteUrl || '',
      impactRenderType: unit.definition.impactRenderType || 'classic',
      impactSpritesheet: plain(unit.definition.impactSpritesheet) || null,
      createdAt: timestamp,
      impactAt: timestamp + Math.max(1, distance / speed * 1000) };
    const firingDelaySeconds = Math.max(
      Number(unit.definition.cooldownSeconds) || 0,
      Number(unit.definition.fireIntervalSeconds) || 0,
      0.1
    );
    unit.nextShotAt = timestamp + firingDelaySeconds * 1000;
    projectiles.set(projectileId, shot);
    nsp.to(unit.zoneId).emit('police:projectile:spawn', projectilePayload(shot, timestamp));
  };

  const completeWave = (incident) => {
    if (incident.waveCompleting || incident.units.size > 0 || incident.pendingWaveAt || incident.state !== 'active') return;
    incident.waveCompleting = true; const completed = incident.waveLevel; const level = starConfig(completed);
    let nextLevel = completed;
    for (const state of incident.wanted.values()) {
      if (level?.completionCondition === 'all_units_destroyed' && level.autoEscalate && state.stars < MAX_STARS) {
        state.stars += 1; state.escapeStartedAt = null; state.escapeLossAt = null; state.seq += 1;
        emitWanted(state, incident.zoneId); nextLevel = Math.max(nextLevel, state.stars);
      }
    }
    incident.waveCompleting = false;
    if (nextLevel > completed) {
      const delay = Math.max(0, Number(starConfig(nextLevel)?.spawnDelaySeconds) || 0) * 1000;
      scheduleWave(incident, nextLevel, delay);
    } else { incident.state = 'contained'; incident.seq += 1; }
  };

  const destroyUnit = (unit, reason, attackerUserId) => {
    const incident = incidents.get(unit.incidentId);
    if (!incident || !incident.units.has(unit.unitId)) return false;
    incident.units.delete(unit.unitId); cancelUnitProjectiles(unit, reason);
    unit.life = 0; unit.state = 'dead'; unit.seq += 1;
    nsp.to(unit.zoneId).emit('police:unit:destroy', { ...unitPayload(unit), reason,
      attackerUserId: attackerUserId || null });
    completeWave(incident); return true;
  };
  const applyBulletDamage = (unitId, damage, attackerUserId, eventId) => {
    const unit = [...incidents.values()].map((incident) => incident.units.get(unitId)).find(Boolean);
    if (!unit || processedDamage.has(eventId)) return { applied: false, dead: !unit };
    const incident = incidents.get(unit.incidentId);
    const attacker = playersForUser(String(attackerUserId || ''))[0];
    if (incident && attacker && attacker.gameModeEnabled !== false && (attacker.vida ?? 0) > 0) {
      joinIncident(attacker, attacker, incident);
    }
    processedDamage.add(eventId); const forget = setTimeout(() => processedDamage.delete(eventId), 60000); forget.unref?.();
    unit.life = Math.max(0, unit.life - Math.max(0, Number(damage) || 0)); unit.seq += 1;
    if (unit.life === 0) { destroyUnit(unit, 'destroyed', attackerUserId); return { applied: true, dead: true }; }
    nsp.to(unit.zoneId).emit('police:unit:update', unitPayload(unit));
    return { applied: true, dead: false, life: unit.life };
  };

  const tickProjectiles = async (timestamp) => {
    for (const [id, shot] of projectiles) {
      if (shot.impactAt > timestamp) continue; projectiles.delete(id);
      const incident = incidents.get(shot.incidentId); const unit = incident?.units.get(shot.unitId);
      const target = playersForUser(shot.targetUserId)[0];
      const hit = Boolean(unit && target && target.gameModeEnabled !== false && (target.vida ?? 0) > 0 &&
        geo.distanceMeters(target, shot.to) <= 15);
      let result = null;
      if (hit) result = await applyPlayerDamage({ attackerUserId: '', target, damage: shot.damage,
        zoneId: shot.zoneId, source: 'police', killEventId: `police:${id}`,
        eventData: { projectileId: id, policeUnitId: shot.unitId, incidentId: shot.incidentId } })
        .catch((error) => { console.error('[POLICE] projectile damage error', error.message); return null; });
      nsp.to(shot.zoneId).emit('police:projectile:impact', { ...projectilePayload(shot, timestamp),
        hit, life: result?.vida ?? target?.vida ?? null, lat: shot.to.lat, lng: shot.to.lng });
      if (result?.killed) clearWanted(shot.targetUserId, 'player-death');
    }
  };
  const tickEscape = (incident, timestamp) => {
    for (const state of [...incident.wanted.values()]) {
      const player = playersForUser(state.userId)[0]; if (!player) continue;
      const level = starConfig(state.stars); if (!level) continue;
      const pursuers = [...incident.units.values()];
      const nearest = pursuers.length ? Math.min(...pursuers.map((unit) => geo.distanceMeters(unit, player)))
        : geo.distanceMeters(incident.center, player);
      if (nearest > Number(level.escapeDistanceMeters)) {
        if (!state.escapeStartedAt) {
          state.escapeStartedAt = timestamp;
          state.escapeLossAt = timestamp + Math.max(100, Number(level.escapeHoldSeconds) * 1000 || 15000);
          state.seq += 1; emitWanted(state, incident.zoneId);
        } else if (timestamp >= state.escapeLossAt) {
          state.stars = Math.max(0, state.stars - 1); state.escapeStartedAt = null; state.escapeLossAt = null; state.seq += 1;
          if (state.stars === 0) clearWanted(state.userId, 'escaped'); else emitWanted(state, incident.zoneId);
        }
      } else if (state.escapeStartedAt) {
        state.escapeStartedAt = null; state.escapeLossAt = null; state.seq += 1; emitWanted(state, incident.zoneId);
      }
    }
  };
  const logicTick = (timestamp, elapsedSeconds) => {
    for (const incident of [...incidents.values()]) {
      if (incident.state === 'ambient' &&
          (primaryAlivePlayersInZone?.(incident.zoneId) || []).length === 0) {
        removeIncident(incident, 'no-players');
        continue;
      }
      if (incident.pendingWaveAt && incident.pendingWaveAt <= timestamp) spawnWave(incident);
      if (incident.state === 'ambient' || incident.wanted.size === 0) {
        moveAmbientPatrol(incident, elapsedSeconds);
        for (const unit of incident.units.values()) {
          unit.targetUserId = null;
          unit.state = 'idle';
          unit.seq += 1; nsp.to(unit.zoneId).emit('police:unit:update', unitPayload(unit));
        }
      } else {
        for (const unit of incident.units.values()) {
          const target = selectTarget(incident, unit, timestamp);
          if (target) { moveUnit(unit, target, elapsedSeconds); fire(incident, unit, target, timestamp); }
          unit.seq += 1; nsp.to(unit.zoneId).emit('police:unit:update', unitPayload(unit));
        }
      }
      if (incident.wanted.size > 0) tickEscape(incident, timestamp);
      completeWave(incident);
    }
  };
  const timer = setInterval(() => {
    const timestamp = now(); tickProjectiles(timestamp);
    const interval = Math.max(100, Number(config?.updateIntervalMs) || 500);
    if (timestamp - lastLogicAt >= interval) {
      const elapsed = lastLogicAt ? Math.min(2, (timestamp - lastLogicAt) / 1000) : interval / 1000;
      lastLogicAt = timestamp; logicTick(timestamp, elapsed);
    }
  }, PROJECTILE_TICK_MS);
  timer.unref?.(); loadConfig();

  return {
    onPlayerShot, ensureAmbientPatrol, clearWanted, handlePlayerDeath: (userId) => clearWanted(userId, 'player-death'),
    handleDisconnect: (userId) => clearWanted(userId, 'disconnect'), refreshConfig: () => loadConfig(true),
    getUnitsInZone: (zoneId) => [...incidents.values()].filter((item) => item.zoneId === zoneId)
      .flatMap((item) => [...item.units.values()]),
    applyBulletDamage,
    getSnapshot: (zoneId) => ({
      policeIncidents: [...incidents.values()].filter((item) => item.zoneId === zoneId).map(incidentPayload),
      policeUnits: [...incidents.values()].filter((item) => item.zoneId === zoneId)
        .flatMap((item) => [...item.units.values()].map(unitPayload)),
      policeProjectiles: [...projectiles.values()].filter((item) => item.zoneId === zoneId).map(projectilePayload),
      policeWanted: [...wantedUsers.values()].filter((item) => incidents.get(item.incidentId)?.zoneId === zoneId)
        .map(wantedPayload),
    }),
    shutdown: () => { clearInterval(timer); directions.clear?.(); for (const incident of [...incidents.values()]) removeIncident(incident, 'shutdown'); },
    _debug: { incidents, wantedUsers, pendingTriggers, projectiles, logicTick, tickProjectiles, loadConfig },
  };
}

module.exports = { createPoliceRuntime, bearingBetween, MAX_STARS };
