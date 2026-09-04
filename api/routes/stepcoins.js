const express = require("express");
const mongoose = require('mongoose');
const router = express.Router();
const User = require("../models/User");
const StepcoinTransaction = require("../models/StepcoinTransaction");
const Card = require("../models/Card");
const { publicNickname } = require('../utils/publicIdentity');
const { randomInt, randomUUID } = require('crypto');
const { verifyToken, requireSelfOrAdmin } = require('../middlewares/authMiddleware');
const { authenticatedUserKey, createLimiter, integerEnv } = require('../middlewares/securityLimits');
const { findRandomUnownedCard, publicCard } = require('../services/randomCardService');
const {
  MINI_GAME_IDS,
  MINI_GAMES,
  LEGACY_LEVEL_REWARD_GAMES,
  ROULETTE_OPTIONS,
  memoryScore,
  reflexScore,
} = require('../services/miniGameConfig');

function rouletteOutcome(options = ROULETTE_OPTIONS) {
  const total = options.reduce((sum, option) => sum + option[1], 0);
  const draw = randomInt(total);
  let cumulative = 0;
  for (const [label, weight] of options) {
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

const economyWriteLimiter = createLimiter({
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: authenticatedUserKey,
  code: 'ECONOMY_RATE_LIMITED',
  message: 'Demasiadas operaciones de economia. Intentalo de nuevo en un minuto.',
});

const rouletteLimiter = createLimiter({
  windowMs: 60 * 1000,
  limit: 10,
  keyGenerator: authenticatedUserKey,
  code: 'ROULETTE_RATE_LIMITED',
  message: 'Demasiadas tiradas. Espera un minuto antes de continuar.',
});

async function positiveClientRewardsSince(userId, source, since, session) {
  const [result] = await StepcoinTransaction.aggregate([
    {
      $match: {
        userId: new mongoose.Types.ObjectId(userId),
        cantidad: { $gt: 0 },
        tipo: 'recompensa',
        'metadata.source': source,
        fecha: { $gte: since },
      },
    },
    { $group: { _id: null, total: { $sum: '$cantidad' } } },
  ]).session(session);
  return Number(result?.total || 0);
}

const MOVEMENT_SOURCES = new Map([
  ['pedometer', 'walking_pedometer'],
  ['walking_pedometer', 'walking_pedometer'],
  ['cycling_gps', 'cycling_gps'],
]);

function normalizeMovementSource(source) {
  return MOVEMENT_SOURCES.get(String(source || '').trim()) || '';
}

function movementAvailableReward(source, movementSession, now = Date.now()) {
  const allowanceUpdatedAt = movementSession.allowanceUpdatedAt || movementSession.issuedAt;
  const elapsedMs = Math.max(0, now - new Date(allowanceUpdatedAt).getTime());
  const elapsedSeconds = elapsedMs / 1000;
  // 300 pasos/minuto (150 SC) permite carrera intensa sin alterar el ratio
  // 2 pasos = 1 SC. Bicicleta conserva el techo previo de 15.000 SC/hora.
  const perHour = source === 'cycling_gps'
    ? integerEnv('CYCLING_REWARD_PER_HOUR', 15000)
    : integerEnv('WALKING_REWARD_PER_HOUR', 9000);
  const maximumBurst = 500;
  const previouslyAvailable = Math.max(0, Number(movementSession.availableReward) || 0);
  return Math.min(maximumBurst, previouslyAvailable + elapsedSeconds * perHour / 3600);
}

router.post('/movement/session', verifyToken, economyWriteLimiter, async (req, res) => {
  const source = normalizeMovementSource(req.body?.source);
  if (!source) {
    return res.status(400).json({ error: 'Origen de movimiento no valido' });
  }
  const targetUserId = String(req.user.id);
  try {
    let user = await User.findById(targetUserId).select('+movementSessions');
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    let movementSession = user.movementSessions?.find((entry) => entry.source === source);
    if (!movementSession) {
      const created = {
        source,
        id: randomUUID(),
        issuedAt: new Date(),
        nextSequence: 1,
        totalClaimed: 0,
        availableReward: 0,
        allowanceUpdatedAt: new Date(),
      };
      user = await User.findOneAndUpdate(
        { _id: targetUserId, 'movementSessions.source': { $ne: source } },
        { $push: { movementSessions: created } },
        { new: true },
      ).select('+movementSessions');
      if (!user) user = await User.findById(targetUserId).select('+movementSessions');
      movementSession = user?.movementSessions?.find((entry) => entry.source === source);
    }
    if (!movementSession) {
      return res.status(409).json({ error: 'No se pudo crear la sesion de movimiento' });
    }
    return res.json({
      sessionId: movementSession.id,
      source: movementSession.source,
      issuedAt: movementSession.issuedAt,
      nextSequence: movementSession.nextSequence,
    });
  } catch (error) {
    console.error('Error creando sesion de movimiento:', error);
    return res.status(500).json({ error: 'Error interno creando sesion de movimiento' });
  }
});

// Añadir o quitar stepcoins (positivo o negativo)
router.post("/adjust", verifyToken, economyWriteLimiter, async (req, res) => {
  const {
    userId, cantidad, tipo, descripcion, source, claimId, level,
    movementSessionId, movementSequence,
  } = req.body;
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
  const movementSource = normalizeMovementSource(clientSource);
  if (req.user.role !== 'admin') {
    const validPedometer = Boolean(movementSource) && cantidad <= 500 &&
      typeof movementSessionId === 'string' && movementSessionId.length >= 16 &&
      movementSessionId.length <= 160 && Number.isSafeInteger(movementSequence) &&
      movementSequence >= 1;
    const validMiniGame = LEGACY_LEVEL_REWARD_GAMES.includes(clientSource) &&
      cantidad === 100 && Number.isInteger(level) &&
      ((clientSource === 'culture' && level >= 1 && level <= 10) ||
       (clientSource === 'space' && level >= 2 && level <= 11));
    if ((!validPedometer && !validMiniGame) ||
        normalizedClaimId.length < 4 || normalizedClaimId.length > 160) {
      return res.status(403).json({ error: 'Recompensa de cliente no valida' });
    }
  }

  let session;
  try {
    const operationKey = req.user.role === 'admin'
      ? undefined
      : movementSource
        ? `movement:${targetUserId}:${movementSessionId}:${movementSequence}`
        : `client-reward:${targetUserId}:${clientSource}:${normalizedClaimId}`;
    session = await User.startSession();
    session.startTransaction();
    if (operationKey) {
      const previous = await StepcoinTransaction
        .findOne({ operationKey })
        .session(session)
        .lean();
      if (previous) {
        const current = await User.findById(targetUserId)
          .select('stepcoins')
          .session(session)
          .lean();
        await session.abortTransaction();
        return res.json({
          message: 'Recompensa ya procesada',
          user: current,
          duplicate: true,
          claimId: normalizedClaimId,
        });
      }
    }

    if (req.user.role !== 'admin' && LEGACY_LEVEL_REWARD_GAMES.includes(clientSource)) {
      const expectedSuffix = `-level-${level}`;
      const miniGameSessionId = normalizedClaimId.endsWith(expectedSuffix)
        ? normalizedClaimId.slice(0, -expectedSuffix.length)
        : '';
      const rewarded = await User.findOneAndUpdate(
        {
          _id: targetUserId,
          miniGameSessions: {
            $elemMatch: {
              id: miniGameSessionId,
              game: clientSource,
              claimed: false,
              expiresAt: { $gt: new Date() },
              rewardedLevels: { $ne: level },
            },
          },
        },
        {
          $inc: {
            stepcoins: cantidad,
            [`miniGameStats.${clientSource}.rewards`]: cantidad,
          },
          $addToSet: { 'miniGameSessions.$.rewardedLevels': level },
        },
        { new: true, session },
      ).select('stepcoins');
      if (!rewarded) {
        await session.abortTransaction();
        return res.status(409).json({
          error: 'Sesion de minijuego invalida, caducada o nivel ya premiado',
          code: 'INVALID_MINIGAME_REWARD',
        });
      }
      await StepcoinTransaction.create([{
        userId: targetUserId,
        cantidad,
        tipo: 'recompensa',
        descripcion: `Nivel ${level} de ${clientSource}`,
        operationKey,
        metadata: { source: clientSource, level, miniGameSessionId },
      }], { session });
      await session.commitTransaction();
      return res.json({
        message: 'Stepcoins actualizados correctamente',
        user: rewarded,
        duplicate: false,
        claimId: normalizedClaimId,
      });
    }

    let user;
    let movementSession;
    let movementRewardAvailable;
    if (req.user.role !== 'admin' && movementSource) {
      user = await User.findById(targetUserId)
        .select('+movementSessions')
        .session(session);
      if (!user) {
        await session.abortTransaction();
        return res.status(404).json({ error: "Usuario no encontrado" });
      }
      movementSession = user.movementSessions?.find(
        (entry) => entry.source === movementSource && entry.id === movementSessionId,
      );
      if (!movementSession) {
        await session.abortTransaction();
        return res.status(403).json({
          error: 'Sesion de movimiento no valida',
          code: 'INVALID_MOVEMENT_SESSION',
        });
      }
      if (movementSequence !== movementSession.nextSequence) {
        await session.abortTransaction();
        return res.status(409).json({
          error: 'Secuencia de movimiento no valida',
          code: 'INVALID_MOVEMENT_SEQUENCE',
          nextSequence: movementSession.nextSequence,
        });
      }
      movementRewardAvailable = movementAvailableReward(
        movementSource, movementSession,
      );
      if (cantidad > Math.floor(movementRewardAvailable)) {
        await session.abortTransaction();
        return res.status(429).json({
          error: 'Incremento de Stepcoins no compatible con el tiempo de actividad',
          code: 'ANOMALOUS_STEPCOIN_REWARD',
        });
      }
    }

    if (req.user.role !== 'admin' && movementSource === 'cycling_gps') {
      const now = Date.now();
      const hourlyLimit = integerEnv('CYCLING_REWARD_PER_HOUR', 15000);
      const hourly = await positiveClientRewardsSince(
        targetUserId, movementSource, new Date(now - 60 * 60 * 1000), session,
      );
      if (hourly + cantidad > hourlyLimit) {
        await session.abortTransaction();
        return res.status(429).json({
          error: 'Incremento de Stepcoins no compatible con actividad normal',
          code: 'ANOMALOUS_STEPCOIN_REWARD',
        });
      }
    }
    user ??= await User.findById(targetUserId).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    // Evitar saldo negativo
    if (user.stepcoins + cantidad < 0) {
      await session.abortTransaction();
      return res.status(400).json({ error: "Saldo insuficiente" });
    }

    // Actualizar saldo
    user.stepcoins += cantidad;
    if (movementSession) {
      movementSession.totalClaimed += cantidad;
      movementSession.availableReward = Math.max(
        0,
        movementRewardAvailable - cantidad,
      );
      movementSession.allowanceUpdatedAt = new Date();
      movementSession.nextSequence += 1;
      movementSession.lastClaimedAt = new Date();
    }
    await user.save({ session });

    // Registrar transacción
    const trans = new StepcoinTransaction({
      userId: targetUserId,
      cantidad,
      tipo: req.user.role === 'admin' ? 'admin' : 'recompensa',
      descripcion: req.user.role === 'admin'
        ? String(descripcion || '').slice(0, 300)
        : `Actividad validada: ${movementSource || clientSource}`,
      operationKey,
      metadata: {
        requestedType: tipo,
        source: movementSource || clientSource,
        level,
        movementSessionId: movementSession?.id,
        movementSequence: movementSession ? movementSequence : undefined,
      },
    });
    await trans.save({ session });

    await session.commitTransaction();
    return res.json({
      message: "Stepcoins actualizados correctamente",
      user: movementSession ? { stepcoins: user.stepcoins } : user,
      duplicate: false,
      claimId: normalizedClaimId || undefined,
      movementSession: movementSession ? {
        sessionId: movementSession.id,
        nextSequence: movementSession.nextSequence,
      } : undefined,
    });
  } catch (err) {
    if (session?.inTransaction()) await session.abortTransaction();
    if (err?.code === 11000) {
      const current = await User.findById(targetUserId).select('stepcoins').lean();
      return res.json({
        message: 'Recompensa ya procesada',
        user: current,
        duplicate: true,
        claimId: normalizedClaimId || undefined,
      });
    }
    console.error("❌ Error ajustando stepcoins:", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  } finally {
    if (session) await session.endSession();
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
router.post("/comprar-skin", verifyToken, economyWriteLimiter, async (req, res) => {
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

router.post("/ruleta", verifyToken, rouletteLimiter, async (req, res) => {
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
    ).select('+rouletteRequestIds +miniGameSessions');
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

    // Flutter conserva los cuatro juegos. La web declara su superficie para
    // no recibir Nave Espacial mientras esa experiencia no exista allí.
    const rouletteOptions = req.body?.clientSurface === 'web'
      ? ROULETTE_OPTIONS.filter(([label]) => label !== MINI_GAMES.space.rouletteLabel)
      : ROULETTE_OPTIONS;
    let applied = rouletteOutcome(rouletteOptions);

    // Regla anti-pérdida: si no llega a 30k, convertir a "Nada"
    if (applied === "Pierde 20000 Stepcoins" && saldoInicial < MIN_BALANCE_BIG_LOSS) {
      applied = "Nada";
    }

    // Caso especial: si es Carta y NO hay cartas disponibles, no cobramos y devolvemos yaTienesTodas
    if (applied === "Carta aleatoria") {
      const randomCard = await findRandomUnownedCard(Card, user.cartas);
      if (!randomCard) {
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
        const randomCarta = await findRandomUnownedCard(Card, user.cartas);
        if (!randomCarta) {
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

        user.cartas = user.cartas || [];
        user.cartas.push(randomCarta._id);
        nuevaCarta = publicCard(randomCarta);
        break;
      }

      // "Nada", "Juego de Cultura", "Juego Nave Espacial" → no afectan saldo
      case "Nada":
      case "Juego de Cultura":
      case "Juego Nave Espacial":
      case "Memory Game":
      case "Reflex Game":
      default:
        break;
    }

    let miniGameSessionId = null;
    const miniGame = Object.values(MINI_GAMES).find(
      (candidate) => candidate.rouletteLabel === applied,
    );
    if (miniGame) {
      miniGameSessionId = randomUUID();
      const now = new Date();
      user.miniGameSessions = (user.miniGameSessions || [])
        .filter((entry) => entry.expiresAt > now && !entry.claimed)
        .slice(-19);
      user.miniGameSessions.push({
        id: miniGameSessionId,
        game: miniGame.id,
        issuedAt: now,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
        claimed: false,
      });
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
      miniGameSessionId,
    });
  } catch (err) {
    console.error("❌ Error en ruleta:", err);
    return res.status(500).json({ error: "Error interno al procesar ruleta" });
  }
});


router.post('/minigame-result', verifyToken, economyWriteLimiter, async (req, res) => {
  try {
    const targetUserId = authenticatedTarget(req);
    const game = String(req.body?.game || '').trim();
    const sessionId = String(req.body?.sessionId || '').trim();
    const score = Number(req.body?.score);
    const durationMs = Number(req.body?.durationMs);
    const reactionMs = Number(req.body?.reactionMs ?? 0);
    const errors = Number(req.body?.errors || 0);
    const falseStart = req.body?.falseStart === true;
    if (!MINI_GAME_IDS.includes(game) || sessionId.length < 8 || sessionId.length > 160 ||
        !Number.isInteger(score) || score < 1 || score > 10 ||
        !Number.isInteger(durationMs) || durationMs < 0 || durationMs > 3600000 ||
        !Number.isInteger(errors) || errors < 0 || errors > 1000 ||
        !Number.isInteger(reactionMs) || reactionMs < 0 || reactionMs > 60000) {
      return res.status(400).json({ error: 'Resultado de minijuego no válido' });
    }
    if (game === 'memory' && score !== memoryScore(durationMs, errors)) {
      return res.status(400).json({ error: 'Puntuación Memory incoherente' });
    }
    if (game === 'reflex' && score !== reflexScore(reactionMs, falseStart)) {
      return res.status(400).json({ error: 'Puntuación Reflex incoherente' });
    }

    const operationKey = `minigame-result:${targetUserId}:${game}:${sessionId}`;
    const previous = await StepcoinTransaction.findOne({ operationKey }).lean();
    if (previous) {
      const current = await User.findById(targetUserId).select('stepcoins').lean();
      return res.json({ duplicate: true, nuevosStepcoins: current?.stepcoins || 0 });
    }

    // El servidor solo abona una sesión emitida por una tirada real y aún no
    // consumida. Culture y Space conservan su abono histórico por nivel.
    const reward = ['memory', 'reflex'].includes(game) ? score * 100 : 0;
    const inc = {
      stepcoins: reward,
      [`miniGameStats.${game}.played`]: 1,
      [`miniGameStats.${game}.totalScore`]: score,
      [`miniGameStats.${game}.totalDurationMs`]: durationMs,
      [`miniGameStats.${game}.totalErrors`]: errors,
      [`miniGameStats.${game}.falseStarts`]: falseStart ? 1 : 0,
      [`miniGameStats.${game}.rewards`]: reward,
    };
    const user = await User.findOneAndUpdate(
      {
        _id: targetUserId,
        miniGameSessions: { $elemMatch: {
          id: sessionId, game, claimed: false, expiresAt: { $gt: new Date() },
        } },
      },
      {
        $set: { 'miniGameSessions.$.claimed': true },
        $inc: inc,
        $max: { [`miniGameStats.${game}.bestScore`]: score },
      },
      { new: true },
    ).select('stepcoins');
    if (!user) {
      return res.status(409).json({ error: 'Sesión de minijuego inválida, caducada o usada' });
    }
    await StepcoinTransaction.create({
      userId: targetUserId,
      cantidad: reward,
      tipo: 'recompensa',
      descripcion: `Resultado ${game}: ${score}/10`,
      operationKey,
      metadata: { source: game, score, durationMs, reactionMs, errors, falseStart },
    });
    return res.json({ ok: true, reward, nuevosStepcoins: user.stepcoins });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ duplicate: true });
    console.error('Error registrando resultado de minijuego:', error);
    return res.status(500).json({ error: 'Error interno registrando minijuego' });
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

    const transactionConditions = [
      { $eq: ['$userId', '$$userId'] },
      { $gt: ['$cantidad', 0] },
      { $eq: ['$tipo', 'recompensa'] },
      { $in: ['$metadata.source', ['pedometer', 'walking_pedometer', 'cycling_gps']] },
      ...(since ? [{ $gte: ['$fecha', since] }] : []),
    ];

    const topUsuarios = await User.aggregate([
      { $match: { role: 'cliente' } },
      {
        $lookup: {
          from: StepcoinTransaction.collection.name,
          let: { userId: '$_id' },
          pipeline: [
            { $match: { $expr: { $and: transactionConditions } } },
            { $group: { _id: null, total: { $sum: '$cantidad' } } },
          ],
          as: 'mobility',
        },
      },
      {
        $set: {
          mobilityStepcoins: {
            $ifNull: [{ $arrayElemAt: ['$mobility.total', 0] }, 0],
          },
        },
      },
      { $sort: { mobilityStepcoins: -1, _id: 1 } },
      { $limit: 100 },
      { $project: { nickname: 1, mobilityStepcoins: 1 } },
    ]);

    res.json(topUsuarios.map((entry) => ({
      id: String(entry._id),
      nickname: publicNickname(entry),
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
