const test = require('node:test');
const assert = require('node:assert/strict');

const User = require('../api/models/User');
const onboardingRouter = require('../api/routes/onboarding');

test('legacy users remain ineligible while new client onboarding is explicit', () => {
  const legacy = new User({
    email: 'legacy@example.com',
    password: 'hash',
    role: 'cliente',
  });
  assert.equal(legacy.onboarding, undefined);
  assert.deepEqual(onboardingRouter.payload(legacy), {
    eligible: false,
    version: 1,
    status: 'ineligible',
    step: null,
    projectileCardId: null,
    placementCardId: null,
  });

  const fresh = new User({
    email: 'fresh@example.com',
    password: 'hash',
    role: 'cliente',
    onboarding: { version: 1, status: 'active', step: 'mapBasics' },
  });
  const state = onboardingRouter.payload(fresh);
  assert.equal(state.eligible, true);
  assert.equal(state.status, 'active');
  assert.equal(state.step, 'mapBasics');
});

test('tutorial rewards are equipped once and keep the deck at four cards', () => {
  const user = { cartas: ['a'], mazo: ['a', 'b', 'c', 'd'] };
  onboardingRouter.equipForTutorial(user, 'projectile');
  assert.deepEqual(user.cartas, ['a', 'projectile']);
  assert.deepEqual(user.mazo, ['a', 'b', 'c', 'projectile']);

  onboardingRouter.equipForTutorial(user, 'projectile');
  assert.deepEqual(user.cartas, ['a', 'projectile']);
  assert.deepEqual(user.mazo, ['a', 'b', 'c', 'projectile']);
});

test('onboarding state order includes game mode and both special spins', () => {
  const steps = onboardingRouter.STEPS;
  assert.ok(steps.indexOf('gameMode') > steps.indexOf('openCards'));
  assert.ok(steps.indexOf('projectileSpin') > steps.indexOf('openRoulette'));
  assert.equal(steps.indexOf('placementSpin'), steps.indexOf('projectileSpin') + 1);
  assert.equal(steps.indexOf('finalMessage'), steps.indexOf('selectPlacement') + 1);
  assert.equal(steps.indexOf('completed'), steps.indexOf('finalMessage') + 1);
});
