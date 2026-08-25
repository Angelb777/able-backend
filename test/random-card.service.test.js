const test = require('node:test');
const assert = require('node:assert/strict');
const { pickRandomCard, unownedCards } = require('../api/services/randomCardService');

test('roulette and streak card helper excludes owned cards', () => {
  const cards = [{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }];
  assert.deepEqual(unownedCards(cards, ['a', 'c']), [{ _id: 'b' }]);
});

test('shared card helper selects only from valid candidates', () => {
  const cards = [{ _id: 'a' }, { _id: 'b' }];
  assert.equal(pickRandomCard(cards, () => 0.99)._id, 'b');
  assert.equal(pickRandomCard([], () => 0), null);
});
