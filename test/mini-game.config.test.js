const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MINI_GAME_IDS,
  ROULETTE_OPTIONS,
  chooseDuelGame,
  memoryScore,
  reflexScore,
} = require('../api/services/miniGameConfig');
const User = require('../api/models/User');

test('roulette preserves total weight and includes all four minigames', () => {
  assert.equal(ROULETTE_OPTIONS.reduce((sum, entry) => sum + entry[1], 0), 10000);
  assert.deepEqual(MINI_GAME_IDS, ['culture', 'space', 'memory', 'reflex']);
  assert.deepEqual([0, .25, .5, .999].map((value) => chooseDuelGame(() => value)),
    MINI_GAME_IDS);
});

test('server scoring mirrors demanding Memory and Reflex thresholds', () => {
  assert.equal(memoryScore(7400, 0), 10);
  assert.equal(memoryScore(7400, 1), 9);
  assert.equal(memoryScore(60000, 20), 1);
  assert.equal(reflexScore(169), 10);
  assert.equal(reflexScore(220), 8);
  assert.equal(reflexScore(1, true), 1);
});

test('user statistics and one-use sessions cover every minigame', () => {
  for (const game of MINI_GAME_IDS) {
    assert.ok(User.schema.path(`miniGameStats.${game}.played`));
    assert.ok(User.schema.path(`miniGameStats.${game}.rewards`));
  }
  assert.ok(User.schema.path('miniGameSessions'));
});
