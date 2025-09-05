// sockets/pvp.socket.js
const geo  = require('../utils/geo');              // <- OK si utils está en la raíz del repo
const Card = require('../api/models/Card');        // <- ANTES: ../models/Card
const User = require('../api/models/User');        // <- ANTES: ../models/User

// Si tienes el modelo Life, apunta igual a api/models
let Life;
try {
  Life = require('../api/models/Life');            // <- ANTES: ../models/Life
} catch (e) {
  // fallback para no romper si aún no existe el modelo
  Life = {
    findOne: async () => null,
    updateOne: async () => ({ acknowledged: true })
  };
}

module.exports = function(io) {
  const nsp = io.of('/pvp');

  // Estado en memoria (MVP)
  const players = new Map(); // socketId -> { userId, lat, lng, heading, skinUrl, nombre, zoneId, lastShotByCard:{}, vida }
  const bullets = new Map(); // bulletId -> { byUserId, zoneId, lat, lng, heading, speed, alcance, dano, spriteUrl, createdAt }
  const roomIndex = new Map(); // zoneId -> Set<socketId>

  // Tick de balas (server-authoritative)
  const TICK_MS = 50;
  setInterval(() => {
    const now = Date.now();
    for (const [id, b] of bullets) {
      // avanzar ~ speed * (TICK_MS/1000)
      const deltaM = b.speed * (TICK_MS / 1000);
      const next = geo.computeOffset({lat:b.lat, lng:b.lng}, deltaM, b.heading);
      b.lat = next.lat; b.lng = next.lng;
      b.recorrido = (b.recorrido || 0) + deltaM;

      // colisiones con jugadores de su sala
      const socketsInZone = roomIndex.get(b.zoneId) || new Set();
      for (const sid of socketsInZone) {
        const p = players.get(sid);
        if (!p || p.userId === b.byUserId) continue;

        const dist = geo.distanceMeters({lat:b.lat, lng:b.lng}, {lat:p.lat, lng:p.lng});
        if (dist <= 12) { // umbral de impacto
          // aplicar daño (servidor)
          const nuevaVida = Math.max(0, (p.vida ?? 1000) - b.dano);
          p.vida = nuevaVida;
          // Persistir vida si tienes modelo/servicio (adaptar a tu lógica real):
          Life.updateOne({ userId: p.userId }, { $set: { vida: nuevaVida }}, { upsert: true }).catch(()=>{});

          // notificar a sala
          nsp.to(b.zoneId).emit('life:update', { userId: p.userId, vida: nuevaVida });
          nsp.to(b.zoneId).emit('bullet:explode', { bulletId: id, lat: b.lat, lng: b.lng });

          bullets.delete(id);
          break;
        }
      }

      // fin de alcance
      if ((b.recorrido || 0) >= b.alcance) {
        nsp.to(b.zoneId).emit('bullet:explode', { bulletId: id, lat: b.lat, lng: b.lng });
        bullets.delete(id);
      }
    }
  }, TICK_MS);

  // Helpers
  function toZoneId(lat, lng) {
    // Celda ~120 m. Ajusta DECIMALES para agrupar menos/más jugadores.
    return geo.cellId(lat, lng, 2);
  }

  // Validar spawn de bala contra su carta (anti-cheat)
  async function validateBullet(byUserId, cardId, intento) {
    const card = await Card.findById(cardId).lean();
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
    return { alcance: card.alcance||0, dano: card.dano||0 };
  }

  nsp.on('connection', (socket) => {
    // 1) Spawn/presencia inicial
    socket.on('presence:hello', async (payload, cb) => {
      try {
        const { userId, lat, lng, heading, skinUrl, nombre } = payload;
        if (!userId || typeof lat!=='number' || typeof lng!=='number') {
          return cb?.({ ok:false, error:'payload inválido' });
        }

        const zoneId = toZoneId(lat, lng);
        socket.join(zoneId);
        if (!roomIndex.has(zoneId)) roomIndex.set(zoneId, new Set());
        roomIndex.get(zoneId).add(socket.id);

        // vida actual (si tienes modelo Life)
        const lifeDoc = await Life.findOne({ userId }).lean().catch(()=>null);
        const vida = lifeDoc?.vida ?? 1000;

        players.set(socket.id, { userId, lat, lng, heading: heading||0, skinUrl, nombre, zoneId, lastShotByCard:{}, vida });

        // Enviar al que entra el estado de la sala (jugadores ya presentes)
        const others = [];
        for (const sid of roomIndex.get(zoneId)) {
          if (sid === socket.id) continue;
          const p = players.get(sid);
          if (p) others.push({ userId:p.userId, lat:p.lat, lng:p.lng, heading:p.heading, skinUrl:p.skinUrl, nombre:p.nombre, vida:p.vida??1000 });
        }
        cb?.({ ok:true, players: others });

        // Notificar a los demás tu spawn
        socket.to(zoneId).emit('presence:spawn', { userId, lat, lng, heading, skinUrl, nombre, vida });
      } catch (e) {
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

      p.lat = lat; p.lng = lng; p.heading = heading||p.heading;
      nsp.to(p.zoneId).emit('presence:move', { userId: p.userId, lat, lng, heading: p.heading });
    });

    // 3) Disparo
    socket.on('bullet:spawn', async (payload, cb) => {
      try {
        const p = players.get(socket.id);
        if (!p) throw new Error('No player');

        const { cardId, from, heading, speed, alcance, dano, spriteUrl } = payload;
        // Rango de spawn razonable (anti-teleport del origen)
        if (geo.distanceMeters({lat:p.lat,lng:p.lng}, from) > 25) throw new Error('Origen inválido');

        await validateBullet(p.userId, cardId, { alcance, dano, speed });

        // Crear bala server-side
        const bulletId = `${p.userId}-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
        bullets.set(bulletId, {
          byUserId: p.userId,
          zoneId: p.zoneId,
          lat: from.lat, lng: from.lng,
          heading: heading%360, speed: Math.min(speed, 180),
          alcance, dano,
          spriteUrl,
          createdAt: Date.now(),
        });

        // Avisar a la sala para que los clientes la dibujen en local
        nsp.to(p.zoneId).emit('bullet:spawn', {
          bulletId, byUserId: p.userId,
          from, heading, speed: Math.min(speed,180),
          alcance, dano, spriteUrl
        });

        cb?.({ ok:true, bulletId });
      } catch (e) {
        cb?.({ ok:false, error: e.message });
      }
    });

    // 4) Desconexión
    socket.on('disconnect', () => {
      const p = players.get(socket.id);
      if (!p) return;
      nsp.to(p.zoneId).emit('presence:leave', { userId: p.userId });

      roomIndex.get(p.zoneId)?.delete(socket.id);
      players.delete(socket.id);
    });
  });
};
