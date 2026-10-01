const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const {
  collectMediaUrls,
  deleteAccountData,
} = require('../api/services/accountDeletion');
const { createAuthRouter } = require('../api/routes/auth');
const User = require('../api/models/User');

function query(value) {
  return {
    select() { return this; },
    lean: async () => value,
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
}

async function withServer(router, callback) {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try { return await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('account deletion only collects owned GridFS URLs', () => {
  const urls = collectMediaUrls({
    fotoPerfil: '/api/media/507f1f77bcf86cd799439011',
    profile: {
      idCardFront: '/api/media/507f191e810c19729de860ea',
      localOnly: '/storage/emulated/0/private.jpg',
    },
  });
  assert.deepEqual([...urls].sort(), [
    '/api/media/507f191e810c19729de860ea',
    '/api/media/507f1f77bcf86cd799439011',
  ]);
});

test('account deletion removes only the user from shared records', async () => {
  const userId = '507f1f77bcf86cd799439011';
  const evidenceUrl = '/api/media/507f191e810c19729de860ea';
  const updates = [];
  const deletions = [];
  const updateModel = (name) => ({
    updateMany: async (...args) => { updates.push([name, ...args]); },
  });
  const deleteModel = (name) => ({
    deleteMany: async (filter) => { deletions.push([name, filter]); },
  });
  const challengeModel = {
    ...updateModel('Challenge'),
    find: () => ({
      select() { return this; },
      lean: async () => [{
        participantes: [{ userId, evidenciaUrl: evidenceUrl }],
      }],
    }),
  };
  let userDeleted = false;
  let removedMedia = [];
  let mediaRemovedBeforeUser = false;

  const models = {
    User: {
      findById: () => query({
        _id: userId,
        fotoPerfil: '/api/media/507f1f77bcf86cd799439012',
      }),
      deleteOne: async () => {
        mediaRemovedBeforeUser = removedMedia.length > 0;
        userDeleted = true;
      },
    },
    Challenge: challengeModel,
    Clan: updateModel('Clan'),
    MapPromoCode: updateModel('MapPromoCode'),
    Reward: updateModel('Reward'),
    Candado: updateModel('Candado'),
    Order: updateModel('Order'),
    Payment: updateModel('Payment'),
    CommercialRequest: updateModel('CommercialRequest'),
    Establishment: updateModel('Establishment'),
  };
  for (const name of [
    'Airstrike', 'CandadoLog', 'Mine', 'Notification', 'Projectile',
    'StepcoinTransaction', 'StreakRewardClaim', 'Turret', 'UberConnection',
    'UberOAuthAttempt', 'UbicacionVisible', 'UserActivityDay',
    'UserDailyStreak', 'UserLife',
  ]) models[name] = deleteModel(name);

  const deleted = await deleteAccountData(userId, {
    models,
    deleteMediaUrls: async (urls) => { removedMedia = urls; },
  });

  assert.equal(deleted, true);
  assert.equal(userDeleted, true);
  assert.equal(mediaRemovedBeforeUser, true);
  assert.ok(updates.some(([name, , update]) => (
    name === 'Challenge' && update.$pull?.participantes?.userId === userId
  )));
  assert.ok(updates.some(([name, , update]) => (
    name === 'Clan' && update.$pull?.members?.userId === userId
  )));
  assert.ok(updates.some(([name, , update]) => (
    name === 'Order' && update.$unset?.shipping === ''
  )));
  assert.ok(updates.some(([name, , update]) => (
    name === 'Payment' && update.$set?.nombre === 'Cuenta eliminada'
      && update.$unset?.userId === ''
  )));
  assert.deepEqual(new Set(removedMedia), new Set([
    evidenceUrl,
    '/api/media/507f1f77bcf86cd799439012',
  ]));
  assert.ok(deletions.every(([name]) => ![
    'Challenge', 'Clan', 'MapPromoCode', 'Reward', 'Order', 'Payment',
  ].includes(name)));
});

test('account endpoint requires provider-aware recent authentication', () => {
  const auth = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'routes', 'auth.js'),
    'utf8',
  );
  assert.match(auth, /router\.delete\('\/account'/);
  assert.match(auth, /firebaseIdToken/);
  assert.match(auth, /decoded\.auth_time/);
  assert.match(auth, /bcrypt\.compare\(password, profile\.password\)/);
  assert.match(auth, /deleteData\(String\(profile\._id\)\)/);
});

test('legacy deletion verifies password before deleting its own account', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  const originalFindById = User.findById;
  const originalCompare = bcrypt.compare;
  process.env.JWT_SECRET = 'account-deletion-test-secret';
  const profile = {
    _id: '507f1f77bcf86cd799439011',
    role: 'cliente',
    email: 'legacy@example.test',
    nickname: 'Legacy',
    password: 'hash',
  };
  User.findById = () => query(profile);
  bcrypt.compare = async (password) => password === 'correct-password';
  t.after(() => {
    User.findById = originalFindById;
    bcrypt.compare = originalCompare;
    if (previousSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  let deletedId = '';
  const router = createAuthRouter({
    UserModel: User,
    disableRateLimit: true,
    deleteAccountData: async (id) => {
      deletedId = id;
      return true;
    },
  });
  const token = jwt.sign({ id: profile._id }, process.env.JWT_SECRET);
  await withServer(router, async (base) => {
    const rejected = await fetch(`${base}/api/auth/account`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    assert.equal(rejected.status, 401);
    assert.equal(deletedId, '');

    const deleted = await fetch(`${base}/api/auth/account`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ password: 'correct-password' }),
    });
    assert.equal(deleted.status, 204);
    assert.equal(deletedId, profile._id);
  });
});
