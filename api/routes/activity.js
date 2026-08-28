const express = require('express');
const User = require('../models/User');
const UserActivityDay = require('../models/UserActivityDay');
const UserDailyStreak = require('../models/UserDailyStreak');
const StreakRewardClaim = require('../models/StreakRewardClaim');
const StepcoinTransaction = require('../models/StepcoinTransaction');
const Card = require('../models/Card');
const { verifyToken } = require('../middlewares/authMiddleware');
const { eligibleUserFilter, utcDayKey } = require('../utils/metricPeriods');
const { findRandomUnownedCard, publicCard } = require('../services/randomCardService');

const DAY_MS = 24 * 60 * 60 * 1000;
const STREAK_REWARD_STEP = 7;
const STREAK_STEPCOINS = 2000;
const STREAK_TIME_ZONE = process.env.ABLE_STREAK_TIME_ZONE || 'Europe/Madrid';

function zonedDayKey(date, timeZone = STREAK_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function dayDistance(fromDay, toDay) {
  return Math.round((Date.parse(`${toDay}T00:00:00.000Z`) -
    Date.parse(`${fromDay}T00:00:00.000Z`)) / DAY_MS);
}

function nextStreakState(previous, day) {
  if (previous?.lastActiveDay === day) {
    return {
      currentStreak: previous.currentStreak,
      streakStartedDay: previous.streakStartedDay,
      earnedReward: null,
    };
  }
  const consecutive = previous?.lastActiveDay &&
    dayDistance(previous.lastActiveDay, day) === 1;
  const currentStreak = consecutive ? previous.currentStreak + 1 : 1;
  const streakStartedDay = consecutive ? previous.streakStartedDay : day;
  const milestone = currentStreak % STREAK_REWARD_STEP === 0
    ? currentStreak
    : null;
  return {
    currentStreak,
    streakStartedDay,
    earnedReward: milestone ? {
      key: `${streakStartedDay}:${milestone}`,
      milestone,
      streakStartedDay,
    } : null,
  };
}

function streakPayload(streak, day, showPopup) {
  const current = streak.currentStreak || 1;
  const cycleDay = ((current - 1) % STREAK_REWARD_STEP) + 1;
  const pending = (streak.pendingRewards || [])[0] || null;
  return {
    day,
    current,
    cycleDay,
    nextRewardAt: current + (STREAK_REWARD_STEP - cycleDay),
    daysUntilReward: STREAK_REWARD_STEP - cycleDay,
    showPopup,
    pendingReward: pending ? { key: pending.key, milestone: pending.milestone } : null,
  };
}

async function updateDailyStreak(StreakModel, userId, day, canShowPopup = true) {
  let streak = await StreakModel.findOne({ userId });
  if (!streak) {
    try {
      streak = await StreakModel.create({ userId });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      streak = await StreakModel.findOne({ userId });
    }
  }
  const next = nextStreakState(streak, day);
  streak.currentStreak = next.currentStreak;
  streak.lastActiveDay = day;
  streak.streakStartedDay = next.streakStartedDay;
  streak.pendingRewards = streak.pendingRewards || [];
  if (next.earnedReward &&
      !streak.pendingRewards.some((reward) => reward.key === next.earnedReward.key)) {
    streak.pendingRewards.push(next.earnedReward);
  }
  await streak.save();

  // El primer dia se registra en silencio. La racha se presenta al usuario
  // por primera vez cuando demuestra continuidad y alcanza el dia 2.
  if (!canShowPopup || streak.currentStreak < 2) {
    return { streak, showPopup: false };
  }

  const popupWinner = await StreakModel.findOneAndUpdate(
    { _id: streak._id, lastPopupDay: { $ne: day } },
    { $set: { lastPopupDay: day } },
    { new: true }
  );
  return { streak: popupWinner || streak, showPopup: Boolean(popupWinner) };
}

function createActivityRouter(dependencies = {}) {
  const router = express.Router();
  const UserModel = dependencies.UserModel || User;
  const CardModel = dependencies.CardModel || Card;
  const ActivityModel = dependencies.ActivityModel || UserActivityDay;
  const StreakModel = dependencies.StreakModel || UserDailyStreak;
  const ClaimModel = dependencies.ClaimModel || StreakRewardClaim;
  const TransactionModel = dependencies.TransactionModel || StepcoinTransaction;
  const authenticate = dependencies.verifyToken || verifyToken;
  const now = dependencies.now || (() => new Date());
  const streakDay = dependencies.streakDay || zonedDayKey;

  router.post('/', authenticate, async (req, res, next) => {
    try {
      const eligible = await UserModel.exists(eligibleUserFilter({ _id: req.user.id }));
      if (!eligible) {
        return res.json({ ok: true, tracked: false });
      }

      const currentTime = now();
      const day = utcDayKey(currentTime);
      const localStreakDay = streakDay(currentTime);
      const result = await ActivityModel.updateOne(
        { userId: req.user.id, day },
        { $setOnInsert: { userId: req.user.id, day } },
        { upsert: true }
      );
      const daily = await updateDailyStreak(
        StreakModel,
        req.user.id,
        localStreakDay,
        req.get('X-Able-Streak-UI') === '1'
      );
      return res.status(result.upsertedCount ? 201 : 200).json({
        ok: true,
        tracked: true,
        day,
        streak: streakPayload(daily.streak, localStreakDay, daily.showPopup),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/streak/claim', authenticate, async (req, res, next) => {
    try {
      const rewardKey = String(req.body?.rewardKey || '').trim();
      const rewardType = String(req.body?.rewardType || '').trim();
      if (!rewardKey || !['stepcoins', 'card'].includes(rewardType)) {
        return res.status(400).json({ error: 'Recompensa de racha no valida' });
      }

      const streak = await StreakModel.findOne({ userId: req.user.id });
      const pending = streak?.pendingRewards?.find((reward) => reward.key === rewardKey);
      let claim = await ClaimModel.findOne({ userId: req.user.id, rewardKey });
      if (!pending && !claim) {
        return res.status(409).json({ error: 'La recompensa ya no esta disponible' });
      }
      if (claim && claim.rewardType !== rewardType) {
        return res.status(409).json({
          error: 'Esta recompensa ya se esta procesando con otra eleccion',
        });
      }

      let selectedCard = null;
      if (!claim && rewardType === 'card') {
        const owner = await UserModel.findById(req.user.id).select('cartas').lean();
        if (!owner) return res.status(404).json({ error: 'Usuario no encontrado' });
        selectedCard = await findRandomUnownedCard(CardModel, owner.cartas);
        if (!selectedCard) {
          return res.status(409).json({
            error: 'Ya tienes todas las cartas. Puedes elegir Stepcoins.',
            code: 'all_cards_owned',
          });
        }
      }

      if (!claim) {
        try {
          claim = await ClaimModel.create({
            userId: req.user.id,
            rewardKey,
            milestone: pending.milestone,
            rewardType,
            cardId: selectedCard?._id,
          });
        } catch (error) {
          if (error?.code !== 11000) throw error;
          claim = await ClaimModel.findOne({ userId: req.user.id, rewardKey });
        }
      }
      if (claim.rewardType !== rewardType) {
        return res.status(409).json({
          error: 'Esta recompensa ya se esta procesando con otra eleccion',
        });
      }

      const operationKey = `streak:${req.user.id}:${rewardKey}`;
      const query = { _id: req.user.id, streakRewardKeys: { $ne: rewardKey } };
      let updatedUser;
      let card = null;
      if (rewardType === 'stepcoins') {
        updatedUser = await UserModel.findOneAndUpdate(query, {
          $inc: { stepcoins: STREAK_STEPCOINS },
          $push: { streakRewardKeys: rewardKey },
        }, { new: true }).select('stepcoins');
        try {
          await TransactionModel.create({
            userId: req.user.id,
            cantidad: STREAK_STEPCOINS,
            tipo: 'racha',
            descripcion: `Racha diaria: dia ${claim.milestone}`,
            operationKey,
            metadata: { rewardKey, milestone: claim.milestone },
          });
        } catch (error) {
          if (error?.code !== 11000) throw error;
        }
      } else {
        card = await CardModel.findById(claim.cardId)
          .select('_id titulo imagenPortada');
        if (!card) throw new Error('La carta reservada ya no existe');
        updatedUser = await UserModel.findOneAndUpdate(query, {
          $addToSet: { cartas: card._id },
          $push: { streakRewardKeys: rewardKey },
        }, { new: true }).select('stepcoins cartas');
      }

      const wasDuplicate = !updatedUser;
      if (!updatedUser) {
        updatedUser = await UserModel.findById(req.user.id).select('stepcoins');
      }
      claim.status = 'completed';
      await claim.save();
      await StreakModel.updateOne(
        { userId: req.user.id },
        { $pull: { pendingRewards: { key: rewardKey } } }
      );

      return res.json({
        ok: true,
        duplicate: wasDuplicate,
        rewardType,
        milestone: claim.milestone,
        stepcoins: updatedUser?.stepcoins,
        card: rewardType === 'card' ? publicCard(card) : null,
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

const router = createActivityRouter();
module.exports = router;
module.exports.createActivityRouter = createActivityRouter;
module.exports.dayDistance = dayDistance;
module.exports.nextStreakState = nextStreakState;
module.exports.streakPayload = streakPayload;
module.exports.zonedDayKey = zonedDayKey;
