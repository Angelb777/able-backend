const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const UserActivityDay = require('../api/models/UserActivityDay');
const Payment = require('../api/models/Payment');
const User = require('../api/models/User');
const {
  createActivityRouter,
  nextStreakState,
  streakPayload,
  zonedDayKey,
} = require('../api/routes/activity');
const { paymentTotals, periodValues } = require('../api/routes/metrics');
const {
  calendarPeriod,
  eligibleUserFilter,
  rollingSevenDayRange,
  utcDayKey,
} = require('../api/utils/metricPeriods');

test('metric periods use stable UTC calendar boundaries', () => {
  const now = new Date('2026-01-01T00:30:00.000Z');
  assert.equal(utcDayKey(now), '2026-01-01');

  const rolling = rollingSevenDayRange(now);
  assert.equal(rolling.startDay, '2025-12-26');
  assert.equal(rolling.endDay, '2026-01-02');

  const monthly = calendarPeriod('monthly', now);
  assert.equal(monthly.period, '2026-01');
  assert.equal(monthly.start.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(monthly.end.toISOString(), '2026-02-01T00:00:00.000Z');

  const yearly = calendarPeriod('yearly', now);
  assert.equal(yearly.period, '2026');
  assert.equal(yearly.start.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(yearly.end.toISOString(), '2027-01-01T00:00:00.000Z');
});

test('streak calendar follows the configured Able timezone', () => {
  assert.equal(
    zonedDayKey(new Date('2026-08-25T22:30:00.000Z'), 'Europe/Madrid'),
    '2026-08-26'
  );
});

test('eligible metrics users include clients and the known legacy user role only', () => {
  assert.deepEqual(eligibleUserFilter(), { role: { $in: ['cliente', 'user'] } });
});

test('daily activity has a unique user and day index', () => {
  const index = UserActivityDay.schema.indexes().find(([fields]) =>
    fields.userId === 1 && fields.day === 1
  );
  assert.ok(index);
  assert.equal(index[1].unique, true);
});

test('economic metrics only aggregate dated, verified monetary payments', async (t) => {
  const originalAggregate = Payment.aggregate;
  let pipeline;
  Payment.aggregate = async (received) => {
    pipeline = received;
    return [];
  };
  t.after(() => { Payment.aggregate = originalAggregate; });

  await paymentTotals(['507f1f77bcf86cd799439011']);
  assert.equal(pipeline[0].$match.verified, true);
  assert.deepEqual(pipeline[0].$match.fecha, { $type: 'date' });
  assert.deepEqual(pipeline[0].$match.cantidad, { $type: 'number', $gt: 0 });
});

test('new payments are unverified unless a trusted route certifies them', () => {
  const payment = new Payment({
    userId: '507f1f77bcf86cd799439011',
    nombre: 'Test',
    cantidad: 10,
  });
  assert.equal(payment.verified, false);
  payment.cantidad = 0;
  assert.ok(payment.validateSync()?.errors?.cantidad);
});

test('period values combine eligible users, recurrence and ticket per payment', async (t) => {
  const originals = {
    find: User.find,
    countDocuments: User.countDocuments,
    activityAggregate: UserActivityDay.aggregate,
    paymentAggregate: Payment.aggregate,
  };
  User.find = () => ({
    select() { return this; },
    lean: async () => [{ _id: 'u1' }, { _id: 'u2' }],
  });
  User.countDocuments = async () => 1;
  UserActivityDay.aggregate = async () => [{ activeUsers: 2, recurrentUsers: 1 }];
  Payment.aggregate = async () => [{
    payingUsers: 1,
    totalRevenue: 30,
    avgTicket: 15,
    paymentCount: 2,
  }];
  t.after(() => {
    User.find = originals.find;
    User.countDocuments = originals.countDocuments;
    UserActivityDay.aggregate = originals.activityAggregate;
    Payment.aggregate = originals.paymentAggregate;
  });

  const result = await periodValues('monthly', new Date('2026-08-25T12:00:00.000Z'));
  assert.equal(result.range.period, '2026-08');
  assert.deepEqual(result.values, {
    totalUsers: 2,
    newUsers: 1,
    activeUsers: 2,
    recurrentUsers: 1,
    calculationVersion: 2,
    payingUsers: 1,
    payingUsersPercent: 50,
    totalRevenue: 30,
    avgTicket: 15,
  });
});

test('activity endpoint is authenticated, idempotent and ignores non-clients', async (t) => {
  const writes = new Set();
  let eligible = true;
  let currentTime = new Date('2026-08-25T12:00:00.000Z');
  const UserModel = { exists: async () => eligible };
  const ActivityModel = {
    async updateOne(query, update, options) {
      assert.deepEqual(update, { $setOnInsert: query });
      assert.equal(options.upsert, true);
      const key = `${query.userId}:${query.day}`;
      const inserted = !writes.has(key);
      writes.add(key);
      return { upsertedCount: inserted ? 1 : 0 };
    },
  };
  const streakDocument = {
    _id: 'streak-1',
    currentStreak: 0,
    lastActiveDay: '',
    streakStartedDay: '',
    lastPopupDay: '',
    pendingRewards: [],
    async save() { return this; },
  };
  const StreakModel = {
    async findOne() { return streakDocument; },
    async findOneAndUpdate(query, update) {
      if (streakDocument.lastPopupDay === query.lastPopupDay?.$ne) return null;
      streakDocument.lastPopupDay = update.$set.lastPopupDay;
      return streakDocument;
    },
  };
  const authenticate = (req, res, next) => {
    if (!req.headers.authorization) return res.status(401).json({ error: 'missing' });
    req.user = { id: '507f1f77bcf86cd799439011', role: 'cliente' };
    return next();
  };
  const app = express();
  app.use('/api/activity', createActivityRouter({
    UserModel,
    ActivityModel,
    StreakModel,
    verifyToken: authenticate,
    now: () => currentTime,
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/activity`;

  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  const headers = {
    Authorization: 'Bearer test',
    'X-Able-Streak-UI': '1',
  };
  const first = await fetch(url, { method: 'POST', headers });
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.equal(firstBody.day, '2026-08-25');
  assert.equal(firstBody.streak.current, 1);
  assert.equal(firstBody.streak.showPopup, false);
  const repeatedActivity = await fetch(url, { method: 'POST', headers });
  assert.equal(repeatedActivity.status, 200);
  assert.equal((await repeatedActivity.json()).streak.showPopup, false);

  currentTime = new Date('2026-08-26T12:00:00.000Z');
  const secondDay = await fetch(url, { method: 'POST', headers });
  assert.equal(secondDay.status, 201);
  const secondDayBody = await secondDay.json();
  assert.equal(secondDayBody.streak.current, 2);
  assert.equal(secondDayBody.streak.showPopup, true);
  const repeatedSecondDay = await fetch(url, { method: 'POST', headers });
  assert.equal(repeatedSecondDay.status, 200);
  assert.equal((await repeatedSecondDay.json()).streak.showPopup, false);
  assert.equal(writes.size, 2);

  eligible = false;
  const ignored = await fetch(url, { method: 'POST', headers });
  assert.deepEqual(await ignored.json(), { ok: true, tracked: false });
});

test('daily streak advances, resets after a missed day and earns every seventh day', () => {
  const first = nextStreakState(null, '2026-08-01');
  assert.equal(first.currentStreak, 1);
  assert.equal(first.earnedReward, null);

  let state = { lastActiveDay: '2026-08-01', currentStreak: 1, streakStartedDay: '2026-08-01' };
  for (let day = 2; day <= 7; day += 1) {
    const key = `2026-08-0${day}`;
    const next = nextStreakState(state, key);
    state = { lastActiveDay: key, ...next };
  }
  assert.equal(state.currentStreak, 7);
  assert.deepEqual(state.earnedReward, {
    key: '2026-08-01:7',
    milestone: 7,
    streakStartedDay: '2026-08-01',
  });

  const repeated = nextStreakState(state, '2026-08-07');
  assert.equal(repeated.currentStreak, 7);
  assert.equal(repeated.earnedReward, null);

  const reset = nextStreakState(state, '2026-08-09');
  assert.equal(reset.currentStreak, 1);
  assert.equal(reset.streakStartedDay, '2026-08-09');
});

test('streak payload exposes seven-day progress and a pending claim', () => {
  const payload = streakPayload({
    currentStreak: 14,
    pendingRewards: [{ key: '2026-08-01:14', milestone: 14 }],
  }, '2026-08-14', true);
  assert.deepEqual(payload, {
    day: '2026-08-14',
    current: 14,
    cycleDay: 7,
    nextRewardAt: 14,
    daysUntilReward: 0,
    showPopup: true,
    pendingReward: { key: '2026-08-01:14', milestone: 14 },
  });
});

test('dashboard exposes the simple global and period recurrence metrics', () => {
  const dashboard = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'dashboard.js'),
    'utf8'
  );
  assert.match(dashboard, /\/api\/metrics\/summary/);
  assert.match(dashboard, /Activos últimos 7 días/);
  assert.match(dashboard, /Usuarios recurrentes/);
  assert.match(dashboard, /\/api\/activity/);
  assert.doesNotMatch(dashboard, /cohorte|funnel/i);
});
