const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createActivityRouter } = require('../api/routes/activity');

function queryResult(value) {
  return {
    select() { return this; },
    lean: async () => value,
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
}

test('streak Stepcoins claim is authoritative and idempotent', async (t) => {
  const user = { _id: 'u1', stepcoins: 1000, cartas: [], streakRewardKeys: [] };
  const streak = {
    pendingRewards: [{ key: '2026-08-19:7', milestone: 7 }],
  };
  let storedClaim = null;
  const transactionKeys = new Set();

  const UserModel = {
    findOneAndUpdate(query, update) {
      if (user.streakRewardKeys.includes(query.streakRewardKeys.$ne)) {
        return queryResult(null);
      }
      user.stepcoins += update.$inc?.stepcoins || 0;
      user.streakRewardKeys.push(update.$push.streakRewardKeys);
      return queryResult(user);
    },
    findById() { return queryResult(user); },
  };
  const StreakModel = {
    async findOne() { return streak; },
    async updateOne(query, update) {
      const key = update.$pull.pendingRewards.key;
      streak.pendingRewards = streak.pendingRewards.filter((item) => item.key !== key);
    },
  };
  const ClaimModel = {
    async findOne() { return storedClaim; },
    async create(data) {
      storedClaim = {
        ...data,
        status: 'processing',
        async save() { return this; },
      };
      return storedClaim;
    },
  };
  const TransactionModel = {
    async create(data) {
      if (transactionKeys.has(data.operationKey)) {
        const error = new Error('duplicate');
        error.code = 11000;
        throw error;
      }
      transactionKeys.add(data.operationKey);
    },
  };
  const authenticate = (req, res, next) => {
    req.user = { id: 'u1', role: 'cliente' };
    next();
  };

  const app = express();
  app.use(express.json());
  app.use('/api/activity', createActivityRouter({
    UserModel,
    StreakModel,
    ClaimModel,
    TransactionModel,
    verifyToken: authenticate,
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/activity/streak/claim`;
  const body = JSON.stringify({
    rewardKey: '2026-08-19:7',
    rewardType: 'stepcoins',
  });

  const first = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const second = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  assert.equal(first.status, 200);
  assert.equal((await first.json()).duplicate, false);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).duplicate, true);
  assert.equal(user.stepcoins, 3000);
  assert.deepEqual(user.streakRewardKeys, ['2026-08-19:7']);
  assert.equal(transactionKeys.size, 1);
  assert.equal(streak.pendingRewards.length, 0);
});
