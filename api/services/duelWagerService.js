const mongoose = require('mongoose');
const User = require('../models/User');
const StepcoinTransaction = require('../models/StepcoinTransaction');

const MAX_DUEL_WAGER = 1000000000;

function normalizeWager(raw) {
  const amount = Number(raw ?? 0);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_DUEL_WAGER) {
    throw Object.assign(new Error('Cantidad de Stepcoins no válida'), { status: 400 });
  }
  return amount;
}

async function balancesFor(userIds, session = null) {
  let query = User.find({ _id: { $in: userIds } }).select('_id stepcoins');
  if (session) query = query.session(session);
  const users = await query.lean();
  return new Map(users.map((user) => [String(user._id), Math.max(0, Number(user.stepcoins) || 0)]));
}

async function maxWagerFor(userIds) {
  const balances = await balancesFor(userIds);
  if (balances.size !== userIds.length) return 0;
  return Math.min(...userIds.map((id) => balances.get(String(id)) || 0));
}

async function assertWagerAvailable(userIds, rawAmount) {
  const amount = normalizeWager(rawAmount);
  if (amount === 0) return { amount, maxWager: await maxWagerFor(userIds) };
  const maxWager = await maxWagerFor(userIds);
  if (amount > maxWager) {
    throw Object.assign(new Error('Uno de los jugadores no tiene Stepcoins suficientes'), { status: 409 });
  }
  return { amount, maxWager };
}

async function lockWager({ inviteId, duelId, userIds, amount: rawAmount }) {
  const amount = normalizeWager(rawAmount);
  if (amount === 0) return { amount: 0, potTotal: 0, balances: await balancesFor(userIds) };

  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const operationKeys = userIds.map((id) => `duel-stake:${inviteId}:${id}`);
      const previous = await StepcoinTransaction.find({
        operationKey: { $in: operationKeys },
      }).session(session).lean();
      if (previous.length === userIds.length) {
        result = {
          amount,
          potTotal: amount * 2,
          balances: await balancesFor(userIds, session),
          duplicate: true,
        };
        return;
      }
      if (previous.length !== 0) throw new Error('Bloqueo de apuesta incompleto');

      const updated = [];
      for (const userId of userIds) {
        const user = await User.findOneAndUpdate(
          { _id: userId, stepcoins: { $gte: amount } },
          { $inc: { stepcoins: -amount } },
          { new: true, session },
        ).select('_id stepcoins').lean();
        if (!user) {
          throw Object.assign(new Error('Uno de los jugadores no tiene Stepcoins suficientes'), { status: 409 });
        }
        updated.push(user);
      }

      await StepcoinTransaction.create(userIds.map((userId) => ({
        userId,
        cantidad: -amount,
        tipo: 'duelo_apuesta',
        descripcion: `Apuesta bloqueada para el duelo ${duelId}`,
        operationKey: `duel-stake:${inviteId}:${userId}`,
        metadata: { inviteId, duelId, wagerPerPlayer: amount, potTotal: amount * 2 },
      })), { session, ordered: true });

      result = {
        amount,
        potTotal: amount * 2,
        balances: new Map(updated.map((user) => [String(user._id), user.stepcoins])),
        duplicate: false,
      };
    });
    return result;
  } finally {
    await session.endSession();
  }
}

async function refundWager({ inviteId, duelId, userIds, amount: rawAmount, reason }) {
  const amount = normalizeWager(rawAmount);
  if (amount === 0) return { balances: await balancesFor(userIds), duplicate: false };
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const refundKeys = userIds.map((id) => `duel-refund:${inviteId}:${id}`);
      const previous = await StepcoinTransaction.find({ operationKey: { $in: refundKeys } })
        .session(session).lean();
      if (previous.length === userIds.length) {
        result = { balances: await balancesFor(userIds, session), duplicate: true };
        return;
      }
      if (previous.length !== 0) throw new Error('Reembolso de apuesta incompleto');

      for (const userId of userIds) {
        await User.updateOne({ _id: userId }, { $inc: { stepcoins: amount } }, { session });
      }
      await StepcoinTransaction.create(userIds.map((userId) => ({
        userId,
        cantidad: amount,
        tipo: 'reembolso_duelo',
        descripcion: `Reembolso de apuesta del duelo ${duelId}`,
        operationKey: `duel-refund:${inviteId}:${userId}`,
        metadata: { inviteId, duelId, reason, wagerPerPlayer: amount },
      })), { session, ordered: true });
      result = { balances: await balancesFor(userIds, session), duplicate: false };
    });
    return result;
  } finally {
    await session.endSession();
  }
}

async function payPot({ duelId, winnerUserId, loserUserId, amount: rawAmount, reason }) {
  const amount = normalizeWager(rawAmount);
  const potTotal = amount * 2;
  if (potTotal === 0) {
    const balances = await balancesFor([winnerUserId, loserUserId]);
    return { potTotal: 0, winnerBalance: balances.get(String(winnerUserId)) || 0, duplicate: false };
  }

  const operationKey = `duel-pot:${duelId}`;
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const previous = await StepcoinTransaction.findOne({ operationKey }).session(session).lean();
      if (previous) {
        const balances = await balancesFor([winnerUserId], session);
        result = { potTotal, winnerBalance: balances.get(String(winnerUserId)) || 0, duplicate: true };
        return;
      }
      const winner = await User.findOneAndUpdate(
        { _id: winnerUserId },
        { $inc: { stepcoins: potTotal } },
        { new: true, session },
      ).select('_id stepcoins').lean();
      if (!winner) throw new Error('No se pudo entregar el bote del duelo');
      await StepcoinTransaction.create([{
        userId: winnerUserId,
        cantidad: potTotal,
        tipo: 'duelo_bote',
        descripcion: `Bote ganado en el duelo ${duelId}`,
        operationKey,
        metadata: { duelId, loserUserId, reason, wagerPerPlayer: amount, potTotal },
      }], { session, ordered: true });
      result = { potTotal, winnerBalance: winner.stepcoins, duplicate: false };
    });
    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = {
  normalizeWager,
  maxWagerFor,
  assertWagerAvailable,
  lockWager,
  refundWager,
  payPot,
};
