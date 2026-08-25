const express = require('express');
const XLSX = require('xlsx');
const { verifyToken, checkRole } = require('../middlewares/authMiddleware');
const Metric = require('../models/Metric');
const User = require('../models/User');
const Payment = require('../models/Payment');
const UserActivityDay = require('../models/UserActivityDay');
const {
  calendarPeriod,
  eligibleUserFilter,
  rollingSevenDayRange,
} = require('../utils/metricPeriods');

const router = express.Router();
const adminOnly = [verifyToken, checkRole(['admin'])];
const VALID_TYPES = new Set(['monthly', 'yearly']);

async function eligibleUserIds() {
  const users = await User.find(eligibleUserFilter()).select('_id').lean();
  return users.map((user) => user._id);
}

async function activityTotals(userIds, startDay, endDay) {
  if (!userIds.length) return { activeUsers: 0, recurrentUsers: 0 };
  const [totals] = await UserActivityDay.aggregate([
    {
      $match: {
        userId: { $in: userIds },
        day: { $gte: startDay, $lt: endDay },
      },
    },
    { $group: { _id: '$userId', days: { $addToSet: '$day' } } },
    { $project: { dayCount: { $size: '$days' } } },
    {
      $group: {
        _id: null,
        activeUsers: { $sum: 1 },
        recurrentUsers: { $sum: { $cond: [{ $gte: ['$dayCount', 2] }, 1, 0] } },
      },
    },
  ]);
  return {
    activeUsers: totals?.activeUsers || 0,
    recurrentUsers: totals?.recurrentUsers || 0,
  };
}

async function paymentTotals(userIds, range) {
  if (!userIds.length) {
    return { payingUsers: 0, totalRevenue: 0, avgTicket: 0, paymentCount: 0 };
  }
  const match = {
    userId: { $in: userIds },
    cantidad: { $type: 'number', $gt: 0 },
    verified: true,
  };
  match.fecha = range
    ? { $gte: range.start, $lt: range.end }
    : { $type: 'date' };

  const [totals] = await Payment.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        payingUserIds: { $addToSet: '$userId' },
        totalRevenue: { $sum: '$cantidad' },
        paymentCount: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        payingUsers: { $size: '$payingUserIds' },
        totalRevenue: 1,
        paymentCount: 1,
        avgTicket: {
          $cond: [
            { $gt: ['$paymentCount', 0] },
            { $divide: ['$totalRevenue', '$paymentCount'] },
            0,
          ],
        },
      },
    },
  ]);
  return {
    payingUsers: totals?.payingUsers || 0,
    totalRevenue: totals?.totalRevenue || 0,
    avgTicket: totals?.avgTicket || 0,
    paymentCount: totals?.paymentCount || 0,
  };
}

async function periodValues(type, now = new Date()) {
  const range = calendarPeriod(type, now);
  const userIds = await eligibleUserIds();
  const [newUsers, activity, payments] = await Promise.all([
    User.countDocuments(eligibleUserFilter({
      createdAt: { $gte: range.start, $lt: range.end },
    })),
    activityTotals(userIds, range.startDay, range.endDay),
    paymentTotals(userIds, range),
  ]);
  const totalUsers = userIds.length;
  return {
    range,
    values: {
      totalUsers,
      newUsers,
      activeUsers: activity.activeUsers,
      recurrentUsers: activity.recurrentUsers,
      calculationVersion: 2,
      payingUsers: payments.payingUsers,
      payingUsersPercent: totalUsers
        ? Number((payments.payingUsers * 100 / totalUsers).toFixed(2))
        : 0,
      totalRevenue: Number(payments.totalRevenue.toFixed(2)),
      // Ticket medio = facturacion / numero de transacciones monetarias validas.
      avgTicket: Number(payments.avgTicket.toFixed(2)),
    },
  };
}

router.get('/summary', ...adminOnly, async (_req, res, next) => {
  try {
    const userIds = await eligibleUserIds();
    const range = rollingSevenDayRange();
    const [activity, payments] = await Promise.all([
      activityTotals(userIds, range.startDay, range.endDay),
      paymentTotals(userIds),
    ]);
    const recurrencePercent = activity.activeUsers
      ? Number((activity.recurrentUsers * 100 / activity.activeUsers).toFixed(2))
      : 0;
    return res.json({
      registeredUsers: userIds.length,
      activeUsers: activity.activeUsers,
      recurrentUsers: activity.recurrentUsers,
      recurrencePercent,
      payingUsers: payments.payingUsers,
      totalRevenue: Number(payments.totalRevenue.toFixed(2)),
      activityWindow: { from: range.startDay, to: range.endDay },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/generate', ...adminOnly, async (_req, res, next) => {
  const now = new Date();
  try {
    const calculated = await Promise.all([
      periodValues('monthly', now),
      periodValues('yearly', now),
    ]);
    await Promise.all(calculated.map(({ range, values }) => Metric.findOneAndUpdate(
      { type: range.type, period: range.period },
      {
        $set: { values },
        $setOnInsert: {
          type: range.type,
          period: range.period,
          createdAt: now,
        },
      },
      { upsert: true, setDefaultsOnInsert: true }
    )));
    return res.json({ message: 'Metricas actualizadas correctamente.' });
  } catch (error) {
    return next(error);
  }
});

router.get('/', ...adminOnly, async (req, res) => {
  const type = req.query.type || 'monthly';
  if (!VALID_TYPES.has(type)) return res.status(400).json({ error: 'Tipo de metricas no valido' });
  const metrics = await Metric.find({ type }).sort({ period: -1 });
  return res.json(metrics);
});

router.get('/excel', ...adminOnly, async (req, res) => {
  const type = req.query.type || 'monthly';
  if (!VALID_TYPES.has(type)) return res.status(400).json({ error: 'Tipo de metricas no valido' });
  const metrics = await Metric.find({ type }).sort({ period: -1 });
  const data = metrics.map((metric) => ({
    Periodo: metric.period,
    'Usuarios totales': metric.values.totalUsers,
    'Usuarios nuevos': metric.values.newUsers,
    'Usuarios activos': metric.values.activeUsers ?? '',
    'Usuarios recurrentes (2+ dias)': metric.values.recurrentUsers ?? '',
    'Usuarios que han pagado': metric.values.payingUsers,
    '% que han pagado': metric.values.payingUsersPercent,
    'Facturacion total': metric.values.totalRevenue,
    'Ticket medio por pago': metric.values.avgTicket,
  }));

  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Metricas');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename=metrics-${type}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return res.send(buffer);
});

module.exports = router;
module.exports.activityTotals = activityTotals;
module.exports.paymentTotals = paymentTotals;
module.exports.periodValues = periodValues;
