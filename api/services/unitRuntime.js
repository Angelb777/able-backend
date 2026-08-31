function bearingBetween(from, to) {
  const rad = (value) => value * Math.PI / 180;
  const y = Math.sin(rad(to.lng - from.lng)) * Math.cos(rad(to.lat));
  const x = Math.cos(rad(from.lat)) * Math.sin(rad(to.lat)) -
    Math.sin(rad(from.lat)) * Math.cos(rad(to.lat)) *
      Math.cos(rad(to.lng - from.lng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function createUnitRuntime({
  nsp,
  geo,
  routeProvider,
  getPlayersInZone,
  getTurretsInZone,
  getPoliceUnitsInZone,
  isPoliceHostileToUser,
  areUsersAllied,
  applyPlayerDamage,
  applyTurretDamage,
  applyPoliceDamage,
  now = () => Date.now(),
  updateIntervalMs = 500,
} = {}) {
  const units = new Map();
  const processedDamage = new Set();
  let serial = 0;
  let lastLogicAt = 0;

  const unitPayload = (unit) => ({
    unitId: unit.unitId,
    groupId: unit.groupId,
    ownerUserId: unit.ownerUserId,
    cardId: unit.cardId,
    zoneId: unit.zoneId,
    lat: unit.lat,
    lng: unit.lng,
    spawnLat: unit.spawnLat,
    spawnLng: unit.spawnLng,
    heading: unit.heading || 0,
    life: unit.life,
    maxLife: unit.maxLife,
    state: unit.state,
    targetType: unit.targetType,
    targetId: unit.targetId,
    detectionRangeMeters: unit.detectionRangeMeters,
    attackRangeMeters: unit.attackRangeMeters,
    maxPursuitDistanceMeters: unit.maxPursuitDistanceMeters,
    speedMetersPerSecond: unit.speedMetersPerSecond,
    damage: unit.damage,
    attackCooldownSeconds: unit.attackCooldownSeconds,
    hitRadiusMeters: unit.hitRadiusMeters,
    idleSpritesheet: unit.idleSpritesheet,
    walkSpritesheet: unit.walkSpritesheet,
    attackSpritesheet: unit.attackSpritesheet,
    expiresAt: new Date(unit.expiresAt).toISOString(),
    seq: unit.seq || 1,
    serverTimestamp: now(),
  });

  const emitUpdate = (unit) => {
    unit.seq += 1;
    nsp.to(unit.zoneId).emit('unit:update', unitPayload(unit));
  };

  const clearTarget = (unit) => {
    unit.targetType = null;
    unit.targetId = null;
    unit.route = [];
    unit.routeIndex = 0;
    unit.routeTarget = null;
  };

  const destroyUnit = (unit, reason, attackerUserId = null) => {
    if (!unit || !units.has(unit.unitId)) return false;
    units.delete(unit.unitId);
    unit.life = 0;
    unit.state = reason === 'destroyed' ? 'dead' : 'expired';
    clearTarget(unit);
    unit.seq += 1;
    nsp.to(unit.zoneId).emit('unit:destroy', {
      ...unitPayload(unit),
      reason,
      attackerUserId: attackerUserId ? String(attackerUserId) : null,
    });
    return true;
  };

  const applyDamage = (unitId, damage, attackerUserId, eventId) => {
    const unit = units.get(String(unitId));
    const normalizedEventId = String(eventId || '');
    if (!unit || unit.life <= 0) return { applied: false, dead: true, life: 0 };
    if (!normalizedEventId || processedDamage.has(normalizedEventId)) {
      return { applied: false, duplicate: true, dead: false, life: unit.life };
    }
    processedDamage.add(normalizedEventId);
    const forget = setTimeout(() => processedDamage.delete(normalizedEventId), 60000);
    forget.unref?.();
    unit.life = Math.max(0, unit.life - Math.max(0, Number(damage) || 0));
    if (unit.life === 0) {
      destroyUnit(unit, 'destroyed', attackerUserId);
      return { applied: true, dead: true, life: 0 };
    }
    emitUpdate(unit);
    return { applied: true, dead: false, life: unit.life };
  };

  const spawnGroup = ({ ownerUserId, cardId, zoneId, position, definition }) => {
    const count = Math.max(1, Math.floor(Number(definition.unitCount) || 1));
    const spacing = Math.max(0, Number(definition.unitSpacingMeters) || 0);
    const groupId = `troop-${String(ownerUserId)}-${now()}-${++serial}`;
    const created = [];
    for (let index = 0; index < count; index += 1) {
      const centeredIndex = index - (count - 1) / 2;
      const spawn = centeredIndex === 0
        ? { lat: position.lat, lng: position.lng }
        : geo.computeOffset(position, Math.abs(centeredIndex) * spacing,
          centeredIndex < 0 ? 270 : 90);
      const unitId = `${groupId}-${index + 1}`;
      const life = Math.max(1, Math.floor(Number(definition.life) || 1));
      const unit = {
        unitId,
        groupId,
        ownerUserId: String(ownerUserId),
        cardId: String(cardId),
        zoneId,
        lat: spawn.lat,
        lng: spawn.lng,
        spawnLat: spawn.lat,
        spawnLng: spawn.lng,
        heading: 0,
        life,
        maxLife: life,
        state: 'idle',
        targetType: null,
        targetId: null,
        detectionRangeMeters: Math.max(1, Number(definition.detectionRangeMeters) || 1),
        attackRangeMeters: Math.max(0.1, Number(definition.attackRangeMeters) || 0.1),
        maxPursuitDistanceMeters: Math.max(1, Number(definition.maxPursuitDistanceMeters) || 1),
        speedMetersPerSecond: Math.max(0.1, Number(definition.speedMetersPerSecond) || 0.1),
        damage: Math.max(0, Math.floor(Number(definition.damage) || 0)),
        attackCooldownSeconds: Math.max(0.1, Number(definition.attackCooldownSeconds) || 0.1),
        hitRadiusMeters: Math.max(1, Number(definition.hitRadiusMeters) || 8),
        idleSpritesheet: definition.idleSpritesheet || null,
        walkSpritesheet: definition.walkSpritesheet || null,
        attackSpritesheet: definition.attackSpritesheet || null,
        expiresAt: now() + Math.max(1, Number(definition.durationSeconds) || 1) * 1000,
        nextAttackAt: now(),
        route: [],
        routeIndex: 0,
        routeTarget: null,
        routePending: false,
        routeRetryAt: 0,
        seq: 1,
      };
      units.set(unitId, unit);
      created.push(unit);
      nsp.to(zoneId).emit('unit:spawn', unitPayload(unit));
    }
    return created.map(unitPayload);
  };

  const allied = async (ownerUserId, candidateOwnerUserId) => {
    if (!candidateOwnerUserId || String(ownerUserId) === String(candidateOwnerUserId)) {
      return true;
    }
    return Boolean(await areUsersAllied?.(String(ownerUserId), String(candidateOwnerUserId)));
  };

  const targetKey = (target) => `${target.type}:${target.id}`;
  const targetPosition = (target) => ({ lat: Number(target.entity.lat), lng: Number(target.entity.lng) });
  const insidePursuitArea = (unit, target) =>
    geo.distanceMeters(
      { lat: unit.spawnLat, lng: unit.spawnLng },
      targetPosition(target),
    ) <= unit.maxPursuitDistanceMeters;

  const collectTargets = async (unit) => {
    const candidates = [];
    for (const player of getPlayersInZone?.(unit.zoneId) || []) {
      if (!player || player.gameModeEnabled === false || (player.vida ?? 0) <= 0 ||
          await allied(unit.ownerUserId, player.userId)) continue;
      candidates.push({ type: 'player', id: String(player.userId), entity: player });
    }
    for (const other of units.values()) {
      if (other.unitId === unit.unitId || other.zoneId !== unit.zoneId || other.life <= 0 ||
          await allied(unit.ownerUserId, other.ownerUserId)) continue;
      candidates.push({ type: 'unit', id: other.unitId, entity: other });
    }
    for (const turret of getTurretsInZone?.(unit.zoneId) || []) {
      if (!turret || turret.vida <= 0 || await allied(unit.ownerUserId, turret.ownerUserId)) continue;
      candidates.push({ type: 'turret', id: String(turret._id), entity: turret });
    }
    for (const police of getPoliceUnitsInZone?.(unit.zoneId) || []) {
      if (!police || police.life <= 0 ||
          !isPoliceHostileToUser?.(police.unitId, unit.ownerUserId)) continue;
      candidates.push({ type: 'police', id: String(police.unitId), entity: police });
    }
    return candidates.filter((target) => {
      const distance = geo.distanceMeters(unit, target.entity);
      return distance <= unit.detectionRangeMeters && insidePursuitArea(unit, target);
    });
  };

  const resolveCurrentTarget = async (unit) => {
    if (!unit.targetType || !unit.targetId) return null;
    let entity = null;
    if (unit.targetType === 'player') {
      entity = (getPlayersInZone?.(unit.zoneId) || [])
        .find((item) => String(item.userId) === unit.targetId);
      if (!entity || entity.gameModeEnabled === false || (entity.vida ?? 0) <= 0 ||
          await allied(unit.ownerUserId, entity.userId)) return null;
    } else if (unit.targetType === 'unit') {
      entity = units.get(unit.targetId);
      if (!entity || entity.life <= 0 || await allied(unit.ownerUserId, entity.ownerUserId)) return null;
    } else if (unit.targetType === 'turret') {
      entity = (getTurretsInZone?.(unit.zoneId) || [])
        .find((item) => String(item._id) === unit.targetId);
      if (!entity || entity.vida <= 0 || await allied(unit.ownerUserId, entity.ownerUserId)) return null;
    } else if (unit.targetType === 'police') {
      entity = (getPoliceUnitsInZone?.(unit.zoneId) || [])
        .find((item) => String(item.unitId) === unit.targetId);
      if (!entity || entity.life <= 0 ||
          !isPoliceHostileToUser?.(entity.unitId, unit.ownerUserId)) return null;
    }
    const target = { type: unit.targetType, id: unit.targetId, entity };
    return entity && insidePursuitArea(unit, target) ? target : null;
  };

  const selectTarget = async (unit) => {
    const current = await resolveCurrentTarget(unit);
    if (current) return current;
    clearTarget(unit);
    const candidates = await collectTargets(unit);
    candidates.sort((a, b) =>
      geo.distanceMeters(unit, a.entity) - geo.distanceMeters(unit, b.entity) ||
      targetKey(a).localeCompare(targetKey(b)));
    const selected = candidates[0] || null;
    if (selected) {
      unit.targetType = selected.type;
      unit.targetId = selected.id;
    }
    return selected;
  };

  const requestRoute = (unit, target) => {
    const destination = targetPosition(target);
    if (!routeProvider?.getRoute || unit.routePending || now() < unit.routeRetryAt ||
        (unit.routeTarget && unit.route.length > unit.routeIndex &&
          geo.distanceMeters(unit.routeTarget, destination) < 25)) return;
    unit.routePending = true;
    const from = { lat: unit.lat, lng: unit.lng };
    routeProvider.getRoute(from, destination, 'walking').then((points) => {
      if (!units.has(unit.unitId)) return;
      if (Array.isArray(points) && points.length > 1) {
        unit.route = points;
        unit.routeIndex = 1;
        unit.routeTarget = destination;
        unit.routeRetryAt = 0;
      } else {
        unit.route = [];
        unit.routeIndex = 0;
        unit.routeTarget = null;
        unit.routeRetryAt = now() + 10000;
      }
    }).catch(() => {
      unit.route = [];
      unit.routeIndex = 0;
      unit.routeTarget = null;
      unit.routeRetryAt = now() + 10000;
    }).finally(() => { unit.routePending = false; });
  };

  const moveToward = (unit, destination, budget) => {
    const distance = geo.distanceMeters(unit, destination);
    if (distance <= budget) {
      unit.lat = destination.lat;
      unit.lng = destination.lng;
      return budget - distance;
    }
    unit.heading = bearingBetween(unit, destination);
    const next = geo.computeOffset(unit, budget, unit.heading);
    if (geo.distanceMeters({ lat: unit.spawnLat, lng: unit.spawnLng }, next) >
        unit.maxPursuitDistanceMeters) return 0;
    unit.lat = next.lat;
    unit.lng = next.lng;
    return 0;
  };

  const moveUnit = (unit, target, elapsedSeconds) => {
    requestRoute(unit, target);
    let remaining = unit.speedMetersPerSecond * elapsedSeconds;
    while (remaining > 0 && unit.routeIndex < unit.route.length) {
      const waypoint = unit.route[unit.routeIndex];
      if (geo.distanceMeters(
        { lat: unit.spawnLat, lng: unit.spawnLng }, waypoint,
      ) > unit.maxPursuitDistanceMeters) {
        clearTarget(unit);
        unit.state = 'idle';
        return;
      }
      remaining = moveToward(unit, waypoint, remaining);
      if (geo.distanceMeters(unit, waypoint) < 1) unit.routeIndex += 1;
      else break;
    }
  };

  const attack = async (unit, target, timestamp) => {
    if (timestamp < unit.nextAttackAt) return;
    unit.nextAttackAt = timestamp + unit.attackCooldownSeconds * 1000;
    const attackId = `unit-attack-${unit.unitId}-${timestamp}-${++serial}`;
    nsp.to(unit.zoneId).emit('unit:attack', {
      unitId: unit.unitId,
      ownerUserId: unit.ownerUserId,
      targetType: target.type,
      targetId: target.id,
      damage: unit.damage,
      attackId,
      seq: unit.seq,
      serverTimestamp: timestamp,
    });
    if (target.type === 'player') {
      await applyPlayerDamage?.({
        attackerUserId: unit.ownerUserId,
        target: target.entity,
        damage: unit.damage,
        zoneId: unit.zoneId,
        source: 'unit',
        killEventId: attackId,
        eventData: { byUnitId: unit.unitId },
      });
    } else if (target.type === 'unit') {
      applyDamage(target.id, unit.damage, unit.ownerUserId, attackId);
    } else if (target.type === 'turret') {
      await applyTurretDamage?.(target.id, unit.damage, unit.ownerUserId, attackId);
    } else if (target.type === 'police') {
      applyPoliceDamage?.(target.id, unit.damage, unit.ownerUserId, attackId);
    }
  };

  const logicTick = async (timestamp, elapsedSeconds) => {
    for (const unit of [...units.values()]) {
      if (!units.has(unit.unitId)) continue;
      if (timestamp >= unit.expiresAt) {
        destroyUnit(unit, 'expired');
        continue;
      }
      const target = await selectTarget(unit);
      if (!target) {
        unit.state = 'idle';
        emitUpdate(unit);
        continue;
      }
      unit.heading = bearingBetween(unit, target.entity);
      const distance = geo.distanceMeters(unit, target.entity);
      if (distance <= unit.attackRangeMeters) {
        unit.state = 'attack';
        await attack(unit, target, timestamp);
      } else {
        unit.state = 'walk';
        moveUnit(unit, target, elapsedSeconds);
      }
      if (units.has(unit.unitId)) emitUpdate(unit);
    }
  };

  const timer = setInterval(() => {
    const timestamp = now();
    if (timestamp - lastLogicAt < updateIntervalMs) return;
    const elapsed = lastLogicAt
      ? Math.min(2, (timestamp - lastLogicAt) / 1000)
      : updateIntervalMs / 1000;
    lastLogicAt = timestamp;
    logicTick(timestamp, elapsed).catch((error) => {
      console.error('[UNIT] logic tick error', error);
    });
  }, Math.min(100, updateIntervalMs));
  timer.unref?.();

  return {
    spawnGroup,
    applyDamage,
    destroyUnit,
    removeOwner: (ownerUserId, reason = 'owner-left') => {
      let removed = 0;
      for (const unit of [...units.values()]) {
        if (unit.ownerUserId !== String(ownerUserId)) continue;
        if (destroyUnit(unit, reason)) removed += 1;
      }
      return removed;
    },
    getUnitsInZone: (zoneId) => [...units.values()]
      .filter((unit) => unit.zoneId === zoneId && unit.life > 0),
    getSnapshot: (zoneId) => ({
      units: [...units.values()]
        .filter((unit) => unit.zoneId === zoneId && unit.life > 0)
        .map(unitPayload),
    }),
    shutdown: () => {
      clearInterval(timer);
      for (const unit of [...units.values()]) destroyUnit(unit, 'shutdown');
    },
    _debug: { units, logicTick, selectTarget, resolveCurrentTarget },
  };
}

module.exports = { createUnitRuntime, bearingBetween };
