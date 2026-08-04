const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMigrationPlan, applyMigrationPlan } = require('../scripts/migrate-nicknames');

test('nickname migration preserves chosen values and is idempotent', async () => {
  const users = [
    { _id: '66b0b91187f9f1a0b30db490', nickname: 'Angel73', nombre: 'Nombre Privado' },
    { _id: '66b0f6fc4cd93f3570dd2584', nombre: 'Otra Persona' },
  ];
  const first = buildMigrationPlan(users);
  assert.deepEqual(first.normalize, [{
    id: users[0]._id,
    nickname: 'Angel73',
    normalizedNickname: 'angel73',
  }]);
  assert.deepEqual(first.pendingOnboarding, [{ id: users[1]._id, action: 'onboarding-required' }]);
  assert.doesNotMatch(JSON.stringify(first), /Nombre Privado|Otra Persona/);

  const UserModel = {
    async updateOne(query, update) {
      const user = users.find((item) => item._id === query._id);
      if (user && !user.normalizedNickname && user.nickname === query.nickname) {
        user.normalizedNickname = update.$set.normalizedNickname;
      }
    },
  };
  await applyMigrationPlan(first, UserModel);
  assert.equal(users[0].nickname, 'Angel73');
  assert.equal(users[0].normalizedNickname, 'angel73');
  assert.equal(users[1].nickname, undefined);

  const second = buildMigrationPlan(users);
  assert.equal(second.normalize.length, 0);
  await applyMigrationPlan(second, UserModel);
  assert.equal(users[0].nickname, 'Angel73');
  assert.equal(users[1].nickname, undefined);
});

test('migration reports case-insensitive conflicts without resolving them', () => {
  const plan = buildMigrationPlan([
    { _id: '66b0b91187f9f1a0b30db490', nickname: 'Angel73' },
    { _id: '66b0f6fc4cd93f3570dd2584', nickname: 'ANGEL73' },
  ]);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].normalizedNickname, 'angel73');
  assert.equal(plan.normalize.length, 0);
});
