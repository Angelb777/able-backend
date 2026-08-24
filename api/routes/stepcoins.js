const express = require("express");
const router = express.Router();
const User = require("../models/User");
const StepcoinTransaction = require("../models/StepcoinTransaction");
const Card = require("../models/Card");
const { publicNickname } = require('../utils/publicIdentity');
const { randomInt } = require('crypto');
const { verifyToken, requireSelfOrAdmin } = require('../middlewares/authMiddleware');

const ROULETTE_OPTIONS = [
  ['Tirar otra vez', 3000], ['Nada', 2500], ['Juego de Cultura', 2200],
  ['Carta aleatoria', 1500], ['Juego Nave Espacial', 787],
  ['Gana 20000 Stepcoins', 5], ['Pierde 20000 Stepcoins', 8],
];

function rouletteOutcome() {
  const total = ROULETTE_OPTIONS.reduce((sum, option) => sum + option[1], 0);
  const draw = randomInt(total);
  let cumulative = 0;
  for (const [label, weight] of ROULETTE_OPTIONS) {
    cumulative += weight;
    if (draw < cumulative) return label;
  }
  return 'Nada';
}

function authenticatedTarget(req) {
  return req.user.role === 'admin' && req.body?.userId
    ? String(req.body.userId)
    : String(req.user.id);
}

// Añadir o quitar stepcoins (positivo o negativo)
router.post("/adjust", verifyToken, async (req, res) => {
  const { userId, cantidad, tipo, descripcion, source, claimId, level } = req.body;
  const targetUserId = authenticatedTarget(req);

  if (req.user.role !== 'admin' && userId && String(userId) !== targetUserId) {
    return res.status(403).json({ error: 'No puedes modificar otro usuario' });
  }

  if (!Number.isInteger(cantidad) || cantidad === 0 || !tipo) {
    return res.status(400).json({ error: "Faltan datos obligatorios" });
  }
  if (req.user.role !== 'admin' &&
      (!['recompensa', 'minijuego_cultura', 'minijuego'].includes(tipo) ||
       cantidad < 1 || cantidad > 500)) {
    return res.status(403).json({ error: 'Ajuste no permitido para clientes' });
  }
  const clientSource = String(source || '').trim();
  const normalizedClaimId = String(claimId || '').trim();
  if (req.user.role !== 'admin') {
    const validPedometer = clientSource === 'pedometer' && cantidad <= 500;
    const validMiniGame = ['culture', 'space'].includes(clientSource) &&
      cantidad === 100 && Number.isInteger(level) && level >= 1 && level <= 100;
    if ((!validPedometer && !validMiniGame) ||
        normalizedClaimId.length < 4 || normalizedClaimId.length > 160) {
      return res.status(403).json({ error: 'Recompensa de cliente no valida' });
    }
  }

  try {
    const operationKey = req.user.role === 'admin'
      ? undefined
      : `client-reward:${targetUserId}:${clientSource}:${normalizedClaimId}`;
    if (operationKey) {
      const previous = await StepcoinTransaction.findOne({ operationKey }).lean();
      if (previous) {
        const current = await User.findById(targetUserId).select('stepcoins').lean();
        return res.json({
          message: 'Recompensa ya procesada',
          user: current,
          duplicate: true,
        });
      }
    }
    const user = await User.findById(targetUserId);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    // Evitar saldo negativo
    if (user.stepcoins + cantidad < 0) {
      return res.status(400).json({ error: "Saldo insuficiente" });
    }

    // Actualizar saldo
    user.stepcoins += cantidad;
    await user.save();

    // Registrar transacción
    const trans = new StepcoinTransaction({
      userId: targetUserId,
      cantidad,
      tipo: req.user.role === 'admin' ? 'admin' : 'recompensa',
      descripcion,
      operationKey,
      metadata: { requestedType: tipo, source: clientSource, level },
    });
    await trans.save();

    res.json({ message: "Stepcoins actualizados correctamente", user });
  } catch (err) {
    console.error("❌ Error ajustando stepcoins:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// Ver historial del usuario
router.get("/historial/:userId", verifyToken, requireSelfOrAdmin(), async (req, res) => {
  try {
    const historial = await StepcoinTransaction.find({ userId: req.params.userId })
      .sort({ fecha: -1 });

    res.json(historial);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener historial" });
  }
});

const Skin = require("../models/Skin"); // Asegúrate de tenerlo importado

// Comprar skin con stepcoins
router.post("/comprar-skin", verifyToken, async (req, res) => {
  const { userId, skinId } = req.body;
  const targetUserId = authenticatedTarget(req);

  if (req.user.role !== 'admin' && userId && String(userId) !== targetUserId) {
    return res.status(403).json({ error: 'No puedes comprar para otro usuario' });
  }

  if (!skinId) {
    return res.status(400).json({ error: "Faltan datos obligatorios" });
  }

  try {
    const user = await User.findById(targetUserId);
    const skin = await Skin.findById(skinId);
    if (!user || !skin) {
      return res.status(404).json({ error: "Usuario o Skin no encontrado" });
    }

    if (user.stepcoins < skin.precio) {
      return res.status(400).json({ error: "Saldo insuficiente para comprar esta skin" });
    }

    // Verificar si ya la compró
    if (user.skinsCompradas.includes(skin._id)) {
      return res.status(400).json({ error: "Ya has comprado esta skin" });
    }

    // Descontar
    user.stepcoins -= skin.precio;
    user.skinsCompradas.push(skin._id);
    await user.save();

    // Registrar transacción
    const trans = new StepcoinTransaction({
      userId: targetUserId,
      cantidad: -skin.precio,
      tipo: "compra", // Debe coincidir con el enum
      descripcion: `Compra de skin: ${skin.titulo}`
    });
    await trans.save();

    // ✅ Enviar el usuario actualizado (solo campos clave)
    res.json({
      message: "Skin comprada correctamente",
      userActualizado: {
        stepcoins: user.stepcoins,
        skinsCompradas: user.skinsCompradas,
        id: user._id,
        role: user.role
      }
    });
  } catch (err) {
    console.error("❌ Error comprando skin:", err.message, err.stack);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

router.post("/ruleta", verifyToken, async (req, res) => {
  try {
    const { userId, requestId } = req.body;
    const targetUserId = authenticatedTarget(req);
    if (req.user.role !== 'admin' && userId && String(userId) !== targetUserId) {
      return res.status(403).json({ error: 'No puedes girar para otro usuario' });
    }
    if (typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 120) {
      return res.status(400).json({ error: 'requestId invalido' });
    }

    const operationKey = `roulette:${targetUserId}:${requestId}`;
    const previous = await StepcoinTransaction.findOne({ operationKey }).lean();
    if (previous) {
      const current = await User.findById(targetUserId).select('stepcoins').lean();
      return res.json({
        resultado: previous.metadata?.resultado || 'Nada',
        nuevosStepcoins: current?.stepcoins || 0,
        duplicate: true,
      });
    }

    const user = await User.findOneAndUpdate(
      { _id: targetUserId, rouletteRequestIds: { $ne: requestId } },
      { $push: { rouletteRequestIds: { $each: [requestId], $slice: -100 } } },
      { new: true },
    ).select('+rouletteRequestIds');
    if (!user) {
      const current = await User.findById(targetUserId)
        .select('+rouletteRequestIds stepcoins')
        .lean();
      if (!current) return res.status(404).json({ error: "Usuario no encontrado" });
      if (current.rouletteRequestIds?.includes(requestId)) {
        return res.status(409).json({ error: 'Tirada en proceso', duplicate: true });
      }
      return res.status(409).json({ error: 'No se pudo reservar la tirada' });
    }

    const SPIN_COST = 500;
    const MIN_BALANCE_BIG_LOSS = 30000;

    const saldoInicial = typeof user.stepcoins === "number" ? user.stepcoins : 0;
    if (saldoInicial < SPIN_COST) {
      return res.status(400).json({ error: "Saldo insuficiente" });
    }

    let applied = rouletteOutcome();

    // Regla anti-pérdida: si no llega a 30k, convertir a "Nada"
    if (applied === "Pierde 20000 Stepcoins" && saldoInicial < MIN_BALANCE_BIG_LOSS) {
      applied = "Nada";
    }

    // Caso especial: si es Carta y NO hay cartas disponibles, no cobramos y devolvemos yaTienesTodas
    if (applied === "Carta aleatoria") {
      const todas = await Card.find().select("_id titulo imagenPortada");
      const tiene = new Set((user.cartas || []).map((id) => String(id)));
      const candidatas = todas.filter((c) => !tiene.has(String(c._id)));

      if (candidatas.length === 0) {
        await StepcoinTransaction.create({
          userId: targetUserId,
          cantidad: 0,
          tipo: 'ruleta',
          descripcion: 'Resultado ruleta: Carta aleatoria (ya tenia todas)',
          operationKey,
          metadata: { resultado: 'Carta aleatoria', yaTienesTodas: true },
        });
        return res.json({
          resultado: "Carta aleatoria",
          yaTienesTodas: true,
          nuevosStepcoins: saldoInicial, // no cobramos
        });
      }
    }

    // 1) Cobrar tirada
    user.stepcoins = saldoInicial - SPIN_COST;

    let nuevaCarta = null;

    // 2) Aplicar efecto del resultado
    switch (applied) {
      case "Tirar otra vez":
        user.stepcoins += SPIN_COST; // reintegro (neto 0)
        break;

      case "Gana 20000 Stepcoins":
        user.stepcoins += 20000;
        break;

      case "Pierde 20000 Stepcoins":
        user.stepcoins = Math.max(0, user.stepcoins - 20000);
        break;

      case "Carta aleatoria": {
        const todas = await Card.find().select("_id titulo imagenPortada");
        const tiene = new Set((user.cartas || []).map((id) => String(id)));
        const candidatas = todas.filter((c) => !tiene.has(String(c._id)));

        if (candidatas.length === 0) {
          // Si entre medias se quedó sin cartas, revertimos el cobro para ser amables
          user.stepcoins = saldoInicial;
          await user.save();
          await StepcoinTransaction.create({
            userId: targetUserId,
            cantidad: 0,
            tipo: "ruleta",
            descripcion: `Resultado ruleta: Carta aleatoria (ya tenía todas)`,
          });
          return res.json({
            resultado: "Carta aleatoria",
            yaTienesTodas: true,
            nuevosStepcoins: user.stepcoins,
          });
        }

        const randomCarta = candidatas[Math.floor(Math.random() * candidatas.length)];
        user.cartas = user.cartas || [];
        user.cartas.push(randomCarta._id);

        nuevaCarta = {
          _id: String(randomCarta._id),
          titulo: randomCarta.titulo,
          imagenPortada: randomCarta.imagenPortada || null,
        };
        break;
      }

      // "Nada", "Juego de Cultura", "Juego Nave Espacial" → no afectan saldo
      case "Nada":
      case "Juego de Cultura":
      case "Juego Nave Espacial":
      default:
        break;
    }

    await user.save();

    const delta = user.stepcoins - saldoInicial;
    await StepcoinTransaction.create({
      userId: targetUserId,
      cantidad: delta, // cambio neto real de la tirada
      tipo: "ruleta",
      descripcion: `Resultado ruleta aplicado: ${applied}`,
      operationKey,
      metadata: { resultado: applied },
    });

    return res.json({
      resultado: applied,          // lo que se aplicó realmente
      nuevosStepcoins: user.stepcoins,
      nuevaCarta,                  // opcional
    });
  } catch (err) {
    console.error("❌ Error en ruleta:", err);
    return res.status(500).json({ error: "Error interno al procesar ruleta" });
  }
});


// Ranking de actividad: solo Stepcoins positivos obtenidos por movilidad.
// El saldo de User.stepcoins no interviene, por lo que gastar no resta puestos.
router.get("/ranking", async (req, res) => {
  try {
    const period = ['week', 'month', 'all'].includes(req.query.period)
      ? req.query.period
      : 'all';
    const since = period === 'week'
      ? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      : period === 'month'
        ? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        : null;

    const transactionMatch = {
      cantidad: { $gt: 0 },
      tipo: 'recompensa',
      'metadata.source': 'pedometer',
      ...(since ? { fecha: { $gte: since } } : {}),
    };

    const topUsuarios = await StepcoinTransaction.aggregate([
      { $match: transactionMatch },
      { $group: { _id: '$userId', mobilityStepcoins: { $sum: '$cantidad' } } },
      {
        $lookup: {
          from: User.collection.name,
          localField: '_id',
          foreignField: '_id',
          as: 'user',
        },
      },
      { $unwind: '$user' },
      { $match: { 'user.role': 'cliente' } },
      { $sort: { mobilityStepcoins: -1, _id: 1 } },
      { $limit: 100 },
      { $project: { _id: 0, userId: '$_id', mobilityStepcoins: 1, user: 1 } },
    ]);

    res.json(topUsuarios.map((entry) => ({
      id: String(entry.userId),
      nickname: publicNickname(entry.user),
      mobilityStepcoins: entry.mobilityStepcoins || 0,
      // Alias para clientes antiguos del ranking; ya no representa el saldo.
      stepcoins: entry.mobilityStepcoins || 0,
    })));
  } catch (err) {
    console.error("❌ Error obteniendo ranking:", err);
    res.status(500).json({ error: "Error interno" });
  }
});


module.exports = router;
