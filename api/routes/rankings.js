const express = require('express');
const Clan = require('../models/Clan');
const User = require('../models/User');
const StepcoinTransaction = require('../models/StepcoinTransaction');
const { publicDuelStats } = require('../services/duel.service');
const { publicNickname } = require('../utils/publicIdentity');

const router = express.Router();
const MOBILITY_SOURCES = ['pedometer', 'walking_pedometer', 'cycling_gps'];

function rankingPeriod(value) {
  return ['week', 'month', 'all'].includes(value) ? value : 'all';
}

function periodStart(period, now = Date.now()) {
  if (period === 'week') return new Date(now - 7 * 24 * 60 * 60 * 1000);
  if (period === 'month') return new Date(now - 30 * 24 * 60 * 60 * 1000);
  return null;
}

function clanRankingPipeline(period, now = Date.now()) {
  const since = periodStart(rankingPeriod(period), now);
  const conditions = [
    { $eq: ['$userId', '$$memberId'] },
    { $gt: ['$cantidad', 0] },
    { $eq: ['$tipo', 'recompensa'] },
    { $in: ['$metadata.source', MOBILITY_SOURCES] },
    { $gte: ['$fecha', '$$joinedAt'] },
    ...(since ? [{ $gte: ['$fecha', since] }] : []),
  ];

  return [
    { $match: { status: 'active', visibility: 'public' } },
    { $unwind: '$members' },
    {
      $lookup: {
        from: StepcoinTransaction.collection.name,
        let: { memberId: '$members.userId', joinedAt: '$members.joinedAt' },
        pipeline: [
          { $match: { $expr: { $and: conditions } } },
          { $group: { _id: null, total: { $sum: '$cantidad' } } },
        ],
        as: 'memberActivity',
      },
    },
    {
      $group: {
        _id: '$_id',
        name: { $first: '$name' },
        imageUrl: { $first: '$imageUrl' },
        memberCount: { $sum: 1 },
        mobilityStepcoins: {
          $sum: { $ifNull: [{ $arrayElemAt: ['$memberActivity.total', 0] }, 0] },
        },
      },
    },
    { $sort: { mobilityStepcoins: -1, _id: 1 } },
    { $limit: 100 },
  ];
}

router.get('/clans', async (req, res) => {
  try {
    const period = rankingPeriod(req.query.period);
    const clans = await Clan.aggregate(clanRankingPipeline(period));
    res.json(clans.map((clan) => ({
      id: String(clan._id),
      name: clan.name,
      imageUrl: clan.imageUrl || '',
      memberCount: clan.memberCount || 0,
      mobilityStepcoins: clan.mobilityStepcoins || 0,
    })));
  } catch (error) {
    console.error('[RANKINGS][CLANS]', error);
    res.status(500).json({ error: 'Error interno obteniendo el ranking de clanes' });
  }
});

router.get('/duels', async (_req, res) => {
  try {
    const users = await User.find({
      role: 'cliente',
      $or: [
        { 'duelStats.wins': { $gt: 0 } },
        { 'duelStats.losses': { $gt: 0 } },
      ],
    })
      .select('nickname duelStats')
      .sort({ 'duelStats.wins': -1, 'duelStats.losses': 1, _id: 1 })
      .limit(100)
      .lean();

    res.json(users.map((user) => ({
      id: String(user._id),
      nickname: publicNickname(user),
      ...publicDuelStats(user.duelStats),
    })));
  } catch (error) {
    console.error('[RANKINGS][DUELS]', error);
    res.status(500).json({ error: 'Error interno obteniendo el ranking de duelistas' });
  }
});

module.exports = router;
module.exports.clanRankingPipeline = clanRankingPipeline;
module.exports.periodStart = periodStart;
module.exports.rankingPeriod = rankingPeriod;
