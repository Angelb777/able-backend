const Airstrike = require('../models/Airstrike');
const Candado = require('../models/Candado');
const CandadoLog = require('../models/CandadoLog');
const Challenge = require('../models/Challenge');
const Clan = require('../models/Clan');
const CommercialRequest = require('../models/CommercialRequest');
const Establishment = require('../models/Establishment');
const MapPromoCode = require('../models/MapPromoCode');
const Mine = require('../models/Mine');
const Notification = require('../models/Notification');
const Order = require('../models/Order');
const Payment = require('../models/Payment');
const Projectile = require('../models/Projectile');
const Reward = require('../models/Reward');
const StepcoinTransaction = require('../models/StepcoinTransaction');
const StreakRewardClaim = require('../models/StreakRewardClaim');
const Turret = require('../models/Turret');
const UberConnection = require('../models/UberConnection');
const UberOAuthAttempt = require('../models/UberOAuthAttempt');
const UbicacionVisible = require('../models/UbicacionVisible');
const User = require('../models/User');
const UserActivityDay = require('../models/UserActivityDay');
const UserDailyStreak = require('../models/UserDailyStreak');
const UserLife = require('../models/UserLife');
const { deleteMediaUrls } = require('../utils/mediaStorage');

function collectMediaUrls(value, result = new Set()) {
  if (typeof value === 'string') {
    if (/^\/api\/media\/[a-f\d]{24}$/i.test(value)) result.add(value);
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMediaUrls(item, result);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectMediaUrls(item, result);
  }
  return result;
}

async function deleteAccountData(userId, dependencies = {}) {
  const models = {
    Airstrike, Candado, CandadoLog, Challenge, Clan,
    CommercialRequest, Establishment, MapPromoCode,
    Mine, Notification, Order, Payment, Projectile, Reward,
    StepcoinTransaction, StreakRewardClaim, Turret,
    UberConnection, UberOAuthAttempt, UbicacionVisible, User,
    UserActivityDay, UserDailyStreak, UserLife,
    ...dependencies.models,
  };
  const removeMedia = dependencies.deleteMediaUrls || deleteMediaUrls;
  const user = await models.User.findById(userId).lean();
  if (!user) return false;
  const mediaUrls = Array.from(collectMediaUrls(user));

  // Evidence belongs to the participant, not to the shared challenge. Remove
  // the file together with the participant entry while preserving the event.
  const challenges = await models.Challenge.find({
    participantes: { $elemMatch: { userId } },
  }).select('participantes').lean();
  for (const challenge of challenges) {
    for (const participant of challenge.participantes || []) {
      if (String(participant.userId) === String(userId)) {
        if (participant.evidenciaUrl
            && /^\/api\/media\/[a-f\d]{24}$/i.test(participant.evidenciaUrl)) {
          mediaUrls.push(participant.evidenciaUrl);
        }
      }
    }
  }

  await Promise.all([
    models.Airstrike.deleteMany({ ownerUserId: userId }),
    models.CandadoLog.deleteMany({ usuarioId: userId }),
    models.Mine.deleteMany({ ownerUserId: userId }),
    models.Notification.deleteMany({ userId }),
    models.Projectile.deleteMany({ userId }),
    models.StepcoinTransaction.deleteMany({ userId }),
    models.StreakRewardClaim.deleteMany({ userId }),
    models.Turret.deleteMany({ ownerUserId: userId }),
    models.UberConnection.deleteMany({ user: userId }),
    models.UberOAuthAttempt.deleteMany({ user: userId }),
    models.UbicacionVisible.deleteMany({ userId }),
    models.UserActivityDay.deleteMany({ userId }),
    models.UserDailyStreak.deleteMany({ userId }),
    models.UserLife.deleteMany({ userId }),

    // Shared/social records are kept. Only this user's embedded membership,
    // invitation, participation or redemption is removed.
    models.Challenge.updateMany(
      { 'participantes.userId': userId },
      { $pull: { participantes: { userId } } },
    ),
    models.Clan.updateMany(
      {
        $or: [
          { 'members.userId': userId },
          { 'pendingInvitations.userId': userId },
          { 'pendingInvitations.invitedByUserId': userId },
          { 'pendingJoinRequests.userId': userId },
        ],
      },
      {
        $pull: {
          members: { userId },
          pendingInvitations: {
            $or: [{ userId }, { invitedByUserId: userId }],
          },
          pendingJoinRequests: { userId },
        },
      },
    ),
    models.MapPromoCode.updateMany(
      { 'redemptions.userId': userId },
      { $pull: { redemptions: { userId } } },
    ),
    models.Reward.updateMany(
      { 'compradores.userId': userId },
      { $pull: { compradores: { userId } } },
    ),
    models.Reward.updateMany(
      { 'compradores.validatedBy': userId },
      { $unset: { 'compradores.$[purchase].validatedBy': '' } },
      { arrayFilters: [{ 'purchase.validatedBy': userId }] },
    ),

    // Physical locks remain reusable; the account ownership and last private
    // location are removed without deleting the lock itself.
    models.Candado.updateMany(
      { creadoPor: userId },
      {
        $set: { creadoPor: null, visibleEnMapa: false, releasedAt: new Date() },
        $unset: { lastLat: '', lastLng: '', lastSeenAt: '' },
      },
    ),

    // Financial records are retained for accounting, but direct customer PII
    // and the resolvable account link are removed.
    models.Order.updateMany(
      { createdBy: userId },
      {
        $unset: { createdBy: '', shipping: '', billing: '', notes: '' },
      },
    ),
    models.Order.updateMany(
      { 'fulfillment.shippedBy': userId },
      { $unset: { 'fulfillment.shippedBy': '' } },
    ),
    models.Payment.updateMany(
      { userId },
      {
        $set: { nombre: 'Cuenta eliminada' },
        $unset: { userId: '' },
      },
    ),

    // Moderator references do not own these shared/commercial resources.
    models.CommercialRequest.updateMany(
      { reviewedBy: userId },
      { $unset: { reviewedBy: '' } },
    ),
    models.CommercialRequest.updateMany(
      { 'history.actorId': userId },
      { $unset: { 'history.$[entry].actorId': '' } },
      { arrayFilters: [{ 'entry.actorId': userId }] },
    ),
    models.Establishment.updateMany(
      { reviewedBy: userId },
      { $unset: { reviewedBy: '' } },
    ),
  ]);

  await removeMedia(mediaUrls);
  await models.User.deleteOne({ _id: userId });
  return true;
}

module.exports = { collectMediaUrls, deleteAccountData };
