const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const User = require('../api/models/User');
const StepcoinTransaction = require('../api/models/StepcoinTransaction');
const { publicDuelStats, shuffledCultureQuestions } = require('../api/services/duel.service');
const { normalizeWager, lockWager } = require('../api/services/duelWagerService');

test('duel rank thresholds depend only on accumulated wins', () => {
  assert.equal(publicDuelStats({ wins: 0, losses: 0 }).rank, null);
  assert.equal(publicDuelStats({ wins: 9, losses: 20 }).rank, null);
  assert.equal(publicDuelStats({ wins: 10, losses: 0 }).rank.name, 'Blanco');
  assert.equal(publicDuelStats({ wins: 30, losses: 8 }).rank.name, 'Amarillo');
  assert.equal(publicDuelStats({ wins: 600, losses: 99 }).rank.name, 'Negro');
});

test('duel profile reports wins required by the next rank', () => {
  assert.equal(publicDuelStats({ wins: 0 }).winsToNextRank, 10);
  assert.equal(publicDuelStats({ wins: 29 }).winsToNextRank, 1);
  assert.equal(publicDuelStats({ wins: 600 }).winsToNextRank, 0);
});

test('culture duel question payload can hide authoritative answers', () => {
  const questions = shuffledCultureQuestions(() => 0.5);
  assert.ok(questions.length >= 20);
  assert.equal(new Set(questions.map((question) => question.id)).size, questions.length);
  assert.ok(questions.every((question) => Number.isInteger(question.correctIndex)));
});

test('duel wager only accepts safe non-negative integer Stepcoins', () => {
  assert.equal(normalizeWager(undefined), 0);
  assert.equal(normalizeWager(1000), 1000);
  assert.throws(() => normalizeWager(-1), /no válida/);
  assert.throws(() => normalizeWager(10.5), /no válida/);
  assert.throws(() => normalizeWager(Number.MAX_SAFE_INTEGER), /no válida/);
});

test('duel wager creates both stake movements as an ordered transaction', async () => {
  const originalStartSession = mongoose.startSession;
  const originalFindTransactions = StepcoinTransaction.find;
  const originalCreateTransaction = StepcoinTransaction.create;
  const originalFindOneAndUpdate = User.findOneAndUpdate;
  const session = {
    async withTransaction(operation) { await operation(); },
    async endSession() {},
  };
  const userIds = ['player-one', 'player-two'];
  let createdTransactions;
  let createOptions;
  let updateIndex = 0;

  mongoose.startSession = async () => session;
  StepcoinTransaction.find = () => ({
    session() { return this; },
    async lean() { return []; },
  });
  StepcoinTransaction.create = async (transactions, options) => {
    createdTransactions = transactions;
    createOptions = options;
    return transactions;
  };
  User.findOneAndUpdate = () => ({
    select() { return this; },
    async lean() {
      const userId = userIds[updateIndex++];
      return { _id: userId, stepcoins: 900 };
    },
  });

  try {
    const result = await lockWager({
      inviteId: 'invite-1',
      duelId: 'duel-1',
      userIds,
      amount: 100,
    });

    assert.equal(result.potTotal, 200);
    assert.equal(createdTransactions.length, 2);
    assert.equal(createOptions.session, session);
    assert.equal(createOptions.ordered, true);
  } finally {
    mongoose.startSession = originalStartSession;
    StepcoinTransaction.find = originalFindTransactions;
    StepcoinTransaction.create = originalCreateTransaction;
    User.findOneAndUpdate = originalFindOneAndUpdate;
  }
});
