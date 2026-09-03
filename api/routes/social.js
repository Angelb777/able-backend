const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Taunt = require('../models/Taunt');
const Bounty = require('../models/Bounty');
const Notification = require('../models/Notification');
const StepcoinTransaction = require('../models/StepcoinTransaction');
const { verifyToken, requireNickname } = require('../middlewares/authMiddleware');
const { normalizeNickname, validateNickname } = require('../utils/nickname');
const { publicNickname } = require('../utils/publicIdentity');
const notificationService = require('../services/notificationService');
const socialRealtime = require('../services/socialRealtime');
const bountyService = require('../services/bountyService');

const router = express.Router();
router.use(verifyToken);

const TAUNT_COOLDOWN_MS = Number(process.env.TAUNT_COOLDOWN_MS) || 15 * 1000;
const MIN_BOUNTY = Math.max(
  1000,
  Number(process.env.MIN_BOUNTY_STEPCOINS) || 1000
);
const MAX_BOUNTY = Number(process.env.MAX_BOUNTY_STEPCOINS) || 1000000;
const tauntCooldowns = new Map();
const rateLimits = new Map();

function rateLimit(bucket, userId, limit, windowMs) {
  const key = `${bucket}:${userId}`;
  const now = Date.now();
  let state = rateLimits.get(key);
  if (!state || state.resetAt <= now) state = { count: 0, resetAt: now + windowMs };
  state.count += 1;
  rateLimits.set(key, state);
  return state.count <= limit ? null : Math.max(1, Math.ceil((state.resetAt - now) / 1000));
}

function requestKey(req) {
  const raw = String(req.body?.requestKey || req.headers['idempotency-key'] || '').trim();
  return raw && raw.length <= 100 ? raw : crypto.randomUUID();
}

async function ensureDefaultTaunts() {
  await Taunt.updateOne(
    { key: 'saludo-pixel' },
    {
      $set: { price: 50 },
      $setOnInsert: { name: 'Saludo pixel', durationMs: 3000, active: true, imageUrl: '' },
    },
    { upsert: true }
  );
  await Taunt.updateOne(
    { key: 'reto-pixel' },
    {
      $set: { price: 250 },
      $setOnInsert: { name: 'Te reto', durationMs: 3500, active: true, imageUrl: '' },
    },
    { upsert: true }
  );
}

router.get('/me', async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('nickname fotoPerfil stepcoins role gameModeEnabled').lean();
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({
      id: String(user._id),
      nickname: publicNickname(user),
      hasChosenNickname: Boolean(user.nickname),
      needsNickname: !user.nickname,
      avatarUrl: user.fotoPerfil || '',
      stepcoins: user.stepcoins || 0,
      role: user.role,
      gameModeEnabled: user.gameModeEnabled !== false,
    });
  } catch (error) {
    next(error);
  }
});

router.put('/me/game-mode', async (req, res, next) => {
  try {
    if (typeof req.body.gameModeEnabled !== 'boolean') {
      return res.status(400).json({ error: 'Valor de Modo Juego no válido' });
    }
    const gameModeEnabled = req.body.gameModeEnabled;
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: { gameModeEnabled } },
      { new: true, runValidators: true }
    ).select('_id gameModeEnabled').lean();
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    socialRealtime.events.emit('game-mode-changed', {
      userId: String(user._id),
      gameModeEnabled: user.gameModeEnabled !== false,
    });
    res.json({ gameModeEnabled: user.gameModeEnabled !== false });
  } catch (error) {
    next(error);
  }
});

router.put('/me/nickname', async (req, res, next) => {
  try {
    const checked = validateNickname(req.body.nickname);
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    const user = await User.findOneAndUpdate(
      { _id: req.user.id },
      { $set: { nickname: checked.nickname, normalizedNickname: checked.normalizedNickname } },
      { new: true, runValidators: true }
    ).select('nickname');
    if (!user) return res.status(409).json({ error: 'El nickname ya no puede modificarse desde este flujo' });
    socialRealtime.nicknameChanged(req.user.id, user.nickname);
    res.json({ nickname: user.nickname, needsNickname: false });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ error: 'Ese nickname ya está en uso' });
    next(error);
  }
});

router.use(requireNickname);

router.get('/users/search', async (req, res, next) => {
  try {
    const retryAfter = rateLimit('nickname-search', req.user.id, 30, 60 * 1000);
    if (retryAfter) return res.status(429).set('Retry-After', String(retryAfter)).json({ error: 'Demasiadas búsquedas. Inténtalo de nuevo en unos segundos.' });
    const normalized = normalizeNickname(req.query.nickname);
    if (!normalized) return res.status(400).json({ error: 'Indica un nickname' });
    const user = await User.findOne({ normalizedNickname: normalized }).select('nickname fotoPerfil').lean();
    if (!user) return res.status(404).json({ error: 'No existe ningún usuario con ese nickname' });
    res.json({ id: String(user._id), nickname: user.nickname, avatarUrl: user.fotoPerfil || '', isSelf: String(user._id) === String(req.user.id) });
  } catch (error) {
    next(error);
  }
});

router.get('/taunts', async (_req, res, next) => {
  try {
    await ensureDefaultTaunts();
    const taunts = await Taunt.find({ active: true }).sort({ price: 1, name: 1 }).lean();
    res.json(taunts.map((taunt) => ({
      id: String(taunt._id),
      name: taunt.name,
      imageUrl: taunt.imageUrl || '',
      animationUrl: taunt.animationUrl || '',
      price: taunt.price,
      durationMs: taunt.durationMs,
    })));
  } catch (error) {
    next(error);
  }
});

router.post('/taunts/send', async (req, res, next) => {
  const senderUserId = String(req.user.id);
  const targetUserId = String(req.body.targetUserId || '');
  try {
    const retryAfter = rateLimit('taunt-send', senderUserId, 20, 60 * 1000);
    if (retryAfter) return res.status(429).set('Retry-After', String(retryAfter)).json({ error: 'Has enviado demasiadas burlas' });
    if (!mongoose.isValidObjectId(targetUserId)) return res.status(400).json({ error: 'Jugador objetivo no válido' });
    if (targetUserId === senderUserId) return res.status(400).json({ error: 'No puedes enviarte una burla a ti mismo' });
    if (!socialRealtime.isOnline(targetUserId)) return res.status(409).json({ error: 'El jugador ya no está conectado' });
    const cooldownKey = `${senderUserId}:${targetUserId}`;
    const cooldownEnd = tauntCooldowns.get(cooldownKey) || 0;
    if (cooldownEnd > Date.now()) {
      return res.status(429).json({ error: 'Burla en cooldown', cooldownMs: cooldownEnd - Date.now() });
    }
    const taunt = await Taunt.findOne({ _id: req.body.tauntId, active: true }).lean();
    if (!taunt) return res.status(404).json({ error: 'La burla no está disponible' });
    const target = await User.findById(targetUserId).select('_id').lean();
    if (!target) return res.status(404).json({ error: 'Jugador no encontrado' });

    const idempotencyKey = requestKey(req);
    const operationKey = `taunt:${senderUserId}:${idempotencyKey}`;
    const session = await mongoose.startSession();
    let balance = 0;
    let duplicate = false;
    try {
      await session.withTransaction(async () => {
        const previous = await StepcoinTransaction.findOne({ operationKey }).session(session).lean();
        if (previous) {
          duplicate = true;
          const current = await User.findById(senderUserId).select('stepcoins').session(session).lean();
          balance = current?.stepcoins || 0;
          return;
        }
        const sender = await User.findOneAndUpdate(
          { _id: senderUserId, stepcoins: { $gte: taunt.price } },
          { $inc: { stepcoins: -taunt.price } },
          { new: true, session }
        );
        if (!sender) throw Object.assign(new Error('No tienes Stepcoins suficientes'), { status: 409 });
        balance = sender.stepcoins;
        await StepcoinTransaction.create([{
          userId: senderUserId,
          cantidad: -taunt.price,
          tipo: 'burla',
          descripcion: `Burla enviada: ${taunt.name}`,
          operationKey,
          metadata: { targetUserId, tauntId: taunt._id },
        }], { session });
      });
    } finally {
      await session.endSession();
    }
    if (duplicate) return res.json({ ok: true, duplicate: true, balance, cooldownMs: Math.max(0, cooldownEnd - Date.now()) });

    const sender = await User.findById(senderUserId).select('nickname fotoPerfil').lean();
    const delivered = socialRealtime.emitToUser(targetUserId, 'taunt:received', {
      eventId: idempotencyKey,
      fromUserId: senderUserId,
      fromNickname: publicNickname(sender || senderUserId),
      fromAvatarUrl: sender?.fotoPerfil || '',
      taunt: {
        id: String(taunt._id),
        name: taunt.name,
        imageUrl: taunt.imageUrl || '',
        animationUrl: taunt.animationUrl || '',
        durationMs: taunt.durationMs,
      },
    });
    if (!delivered) {
      await User.updateOne({ _id: senderUserId }, { $inc: { stepcoins: taunt.price } });
      await StepcoinTransaction.create({
        userId: senderUserId,
        cantidad: taunt.price,
        tipo: 'reembolso_burla',
        descripcion: 'Reembolso: el jugador se desconectó antes de recibir la burla',
        operationKey: `taunt-refund:${operationKey}`,
        metadata: { targetUserId, tauntId: taunt._id },
      }).catch(() => {});
      return res.status(409).json({ error: 'El jugador se ha desconectado', balance: balance + taunt.price });
    }
    tauntCooldowns.set(cooldownKey, Date.now() + TAUNT_COOLDOWN_MS);
    res.json({ ok: true, balance, cooldownMs: TAUNT_COOLDOWN_MS });
  } catch (error) {
    next(error);
  }
});

router.post('/bounties', async (req, res, next) => {
  const creatorId = String(req.user.id);
  const targetUserId = String(req.body.targetUserId || '');
  try {
    const retryAfter = rateLimit('bounty-create', creatorId, 20, 60 * 1000);
    if (retryAfter) return res.status(429).set('Retry-After', String(retryAfter)).json({ error: 'Has creado demasiadas recompensas' });
    if (!mongoose.isValidObjectId(targetUserId)) return res.status(400).json({ error: 'Jugador objetivo no válido' });
    if (targetUserId === creatorId) return res.status(400).json({ error: 'No puedes marcar una recompensa contra ti mismo' });
    const amount = Number(req.body.amount);
    if (!Number.isSafeInteger(amount) || amount < MIN_BOUNTY || amount > MAX_BOUNTY) {
      return res.status(400).json({ error: `La recompensa debe ser un entero entre ${MIN_BOUNTY} y ${MAX_BOUNTY}` });
    }
    if (!await User.exists({ _id: targetUserId })) return res.status(404).json({ error: 'Jugador no encontrado' });
    const creationKey = requestKey(req);
    const session = await mongoose.startSession();
    let bounty = null;
    let balance = 0;
    let duplicate = false;
    try {
      await session.withTransaction(async () => {
        bounty = await Bounty.findOne({ createdByUserId: creatorId, creationKey }).session(session);
        if (bounty) {
          duplicate = true;
          const current = await User.findById(creatorId).select('stepcoins').session(session).lean();
          balance = current?.stepcoins || 0;
          return;
        }
        const creator = await User.findOneAndUpdate(
          { _id: creatorId, stepcoins: { $gte: amount } },
          { $inc: { stepcoins: -amount } },
          { new: true, session }
        );
        if (!creator) throw Object.assign(new Error('No tienes Stepcoins suficientes'), { status: 409 });
        balance = creator.stepcoins;
        [bounty] = await Bounty.create([{
          targetUserId,
          createdByUserId: creatorId,
          amount,
          status: 'active',
          expiresAt: new Date(Date.now() + bountyService.BOUNTY_DURATION_MS),
          creationKey,
        }], { session });
        await StepcoinTransaction.create([{
          userId: creatorId,
          cantidad: -amount,
          tipo: 'recompensa_pvp',
          descripcion: `Recompensa PVP sobre ${targetUserId}`,
          operationKey: `bounty-create:${creatorId}:${creationKey}`,
          metadata: { targetUserId, bountyId: bounty._id },
        }], { session });
      });
    } finally {
      await session.endSession();
    }
    const total = await bountyService.emitBountyTotal(targetUserId);
    if (!duplicate) {
      await notificationService.createNotification({
        userId: targetUserId,
        type: 'bounty_placed',
        title: 'Recompensa PVP',
        message: `Han colocado una recompensa de ${amount} Stepcoins sobre ti.`,
        data: { bountyId: bounty._id, amount, total },
        dedupeKey: `bounty-placed:${bounty._id}`,
      });
    }
    res.status(duplicate ? 200 : 201).json({
      ok: true,
      duplicate,
      bounty: { id: String(bounty._id), amount: bounty.amount, status: bounty.status, expiresAt: bounty.expiresAt },
      total,
      balance,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/bounties/totals', async (req, res, next) => {
  try {
    const ids = String(req.query.userIds || '').split(',').filter(Boolean).slice(0, 100);
    const totals = await bountyService.totalsForTargets(ids);
    res.json({ totals: Object.fromEntries(totals) });
  } catch (error) {
    next(error);
  }
});

router.get('/notifications', async (req, res, next) => {
  try {
    const notifications = await Notification.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(100).lean();
    res.json(notifications);
  } catch (error) {
    next(error);
  }
});

router.post('/notifications/:notificationId/read', async (req, res, next) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.notificationId, userId: req.user.id },
      { $set: { readAt: new Date() } },
      { new: true }
    );
    if (!notification) return res.status(404).json({ error: 'Notificación no encontrada' });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post('/bounties/process-expired', async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });
    const processed = await bountyService.processExpiredBounties({ limit: 500 });
    res.json({ processed });
  } catch (error) {
    next(error);
  }
});

router.use((error, _req, res, _next) => {
  console.error('[SOCIAL]', error);
  if (error?.code === 11000) return res.status(409).json({ error: 'La operación ya existe' });
  res.status(error.status || 500).json({ error: error.status ? error.message : 'Error interno del sistema social' });
});

module.exports = router;
