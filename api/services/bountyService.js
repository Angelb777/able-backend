const mongoose = require('mongoose');
const Bounty = require('../models/Bounty');
const User = require('../models/User');
const StepcoinTransaction = require('../models/StepcoinTransaction');
const CombatKillEvent = require('../models/CombatKillEvent');
const clanMembershipCache = require('./clanMembershipCache');
const notificationService = require('./notificationService');
const socialRealtime = require('./socialRealtime');

const BOUNTY_DURATION_MS = Number(process.env.BOUNTY_DURATION_MS) || 7 * 24 * 60 * 60 * 1000;
const BOUNTY_EXPIRY_INTERVAL_MS = Number(process.env.BOUNTY_EXPIRY_INTERVAL_MS) || 60 * 1000;
let expiryTimer = null;

async function totalForTarget(targetUserId) {
  const result = await Bounty.aggregate([
    { $match: { targetUserId: new mongoose.Types.ObjectId(String(targetUserId)), status: 'active', expiresAt: { $gt: new Date() } } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return result[0]?.total || 0;
}

async function totalsForTargets(targetUserIds) {
  const ids = [...new Set((targetUserIds || []).filter(mongoose.isValidObjectId).map((id) => new mongoose.Types.ObjectId(String(id))))];
  if (!ids.length) return new Map();
  const rows = await Bounty.aggregate([
    { $match: { targetUserId: { $in: ids }, status: 'active', expiresAt: { $gt: new Date() } } },
    { $group: { _id: '$targetUserId', total: { $sum: '$amount' } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), row.total]));
}

async function emitBountyTotal(targetUserId) {
  const total = await totalForTarget(targetUserId);
  socialRealtime.broadcast('bounty:total', {
    targetUserId: String(targetUserId),
    total,
  });
  return total;
}

async function claimForKill({ attackerUserId, targetUserId, killEventId, source }) {
  if (!attackerUserId || !targetUserId || attackerUserId === targetUserId) {
    return { paid: 0, claimed: 0, duplicate: false };
  }
  if (await clanMembershipCache.shareActiveClan(attackerUserId, targetUserId)) {
    return { paid: 0, claimed: 0, protected: true };
  }

  const session = await mongoose.startSession();
  let result = { paid: 0, claimed: 0, duplicate: false };
  let claimedBounties = [];
  try {
    await session.withTransaction(async () => {
      const existing = await CombatKillEvent.findOne({ killEventId }).session(session).lean();
      if (existing) {
        result = { paid: existing.bountyPaid || 0, claimed: 0, duplicate: true };
        return;
      }

      const candidates = await Bounty.find({
        targetUserId,
        status: 'active',
        expiresAt: { $gt: new Date() },
        createdByUserId: { $ne: attackerUserId },
      }).session(session);
      claimedBounties = candidates.map((item) => ({
        id: String(item._id),
        creatorId: String(item.createdByUserId),
        amount: item.amount,
      }));

      let paid = 0;
      for (const bounty of candidates) {
        bounty.status = 'claimed';
        bounty.claimedByUserId = attackerUserId;
        bounty.claimedAt = new Date();
        bounty.killEventId = killEventId;
        await bounty.save({ session });
        paid += bounty.amount;
      }

      if (paid > 0) {
        await User.updateOne({ _id: attackerUserId }, { $inc: { stepcoins: paid } }, { session });
        await StepcoinTransaction.create([{
          userId: attackerUserId,
          cantidad: paid,
          tipo: 'cobro_recompensa',
          descripcion: `Recompensas cobradas por eliminar a ${targetUserId}`,
          operationKey: `bounty-claim:${killEventId}`,
          metadata: { targetUserId, killEventId, bountyIds: candidates.map((item) => item._id) },
        }], { session });
      }

      await CombatKillEvent.create([{
        killEventId,
        attackerUserId,
        targetUserId,
        source,
        bountyPaid: paid,
      }], { session });
      result = { paid, claimed: candidates.length, duplicate: false };
    });
  } finally {
    await session.endSession();
  }

  if (!result.duplicate) {
    if (result.paid > 0) {
      await notificationService.createNotification({
        userId: attackerUserId,
        type: 'bounty_claimed',
        title: 'Recompensa cobrada',
        message: `Has cobrado ${result.paid} Stepcoins en recompensas.`,
        data: { targetUserId, killEventId, amount: result.paid },
        dedupeKey: `bounty-claimed:${killEventId}:${attackerUserId}`,
      }).catch(() => {});
      socialRealtime.emitToUser(attackerUserId, 'stepcoins:update', { delta: result.paid, reason: 'bounty_claimed' });
      await Promise.all(claimedBounties.map((item) =>
        notificationService.createNotification({
          userId: item.creatorId,
          type: 'bounty_claimed',
          title: 'Recompensa cobrada',
          message: `Tu recompensa de ${item.amount} Stepcoins ha sido cobrada.`,
          data: { bountyId: item.id, targetUserId, attackerUserId, killEventId },
          dedupeKey: `bounty-creator-claimed:${item.id}`,
        }).catch(() => null)
      ));
    }
    await emitBountyTotal(targetUserId).catch(() => {});
  }
  return result;
}

async function processExpiredBounties({ limit = 100 } = {}) {
  let processed = 0;
  while (processed < limit) {
    const session = await mongoose.startSession();
    let expired = null;
    try {
      await session.withTransaction(async () => {
        expired = await Bounty.findOneAndUpdate(
          { status: 'active', expiresAt: { $lte: new Date() } },
          { $set: { status: 'expired', refundedAt: new Date() } },
          { new: true, session, sort: { expiresAt: 1 } }
        );
        if (!expired) return;
        await User.updateOne(
          { _id: expired.createdByUserId },
          { $inc: { stepcoins: expired.amount } },
          { session }
        );
        await StepcoinTransaction.create([{
          userId: expired.createdByUserId,
          cantidad: expired.amount,
          tipo: 'devolucion_recompensa',
          descripcion: 'Devolución de recompensa PVP expirada',
          operationKey: `bounty-refund:${expired._id}`,
          metadata: { bountyId: expired._id, targetUserId: expired.targetUserId },
        }], { session });
      });
    } finally {
      await session.endSession();
    }
    if (!expired) break;
    processed += 1;
    socialRealtime.emitToUser(expired.createdByUserId, 'stepcoins:update', {
      delta: expired.amount,
      reason: 'bounty_expired',
    });
    await notificationService.createNotification({
      userId: expired.createdByUserId,
      type: 'bounty_expired',
      title: 'Recompensa expirada',
      message: `Se han devuelto ${expired.amount} Stepcoins de una recompensa expirada.`,
      data: { bountyId: expired._id, targetUserId: expired.targetUserId },
      dedupeKey: `bounty-expired:${expired._id}`,
    }).catch(() => {});
    await emitBountyTotal(expired.targetUserId).catch(() => {});
  }
  return processed;
}

function startExpiryWorker() {
  if (expiryTimer) return expiryTimer;
  const run = () => processExpiredBounties().catch((error) => {
    console.error('[BOUNTY] expiry worker error', error);
  });
  expiryTimer = setInterval(run, BOUNTY_EXPIRY_INTERVAL_MS);
  expiryTimer.unref?.();
  setTimeout(run, 1000).unref?.();
  return expiryTimer;
}

module.exports = {
  BOUNTY_DURATION_MS,
  totalForTarget,
  totalsForTargets,
  emitBountyTotal,
  claimForKill,
  processExpiredBounties,
  startExpiryWorker,
};
