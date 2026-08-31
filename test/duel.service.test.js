const test = require('node:test');
const assert = require('node:assert/strict');
const { publicDuelStats, shuffledCultureQuestions } = require('../api/services/duel.service');

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
