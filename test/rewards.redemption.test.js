const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const User = require('../api/models/User');
const Reward = require('../api/models/Reward');
const rewardsRouter = require('../api/routes/rewards');

test('buyer lists are scoped to Able for admin and to the owner for commerce', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  const originalUserFindById = User.findById;
  const originalRewardFind = Reward.find;
  process.env.JWT_SECRET = 'reward-redemption-test-secret';

  User.findById = (id) => ({
    select() { return this; },
    lean: async () => ({
      _id: id,
      role: String(id),
      email: `${id}@able.test`,
      firebaseUid: null,
    }),
  });

  const seenQueries = [];
  Reward.find = (query) => {
    seenQueries.push(query);
    return {
      populate() { return this; },
      select: async () => [{
        _id: 'reward-1',
        titulo: 'Gorra',
        compradores: [{
          userId: {
            _id: 'buyer-1', nickname: 'AbleFan', nombre: '', email: 'fan@able.test',
          },
          validado: false,
        }],
      }],
    };
  };

  const app = express();
  app.use(express.json());
  app.use('/api/rewards', rewardsRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    if (previousSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    User.findById = originalUserFindById;
    Reward.find = originalRewardFind;
    await new Promise((resolve) => server.close(resolve));
  });

  const call = (path, role) => fetch(`${base}${path}`, {
    headers: {
      Authorization: `Bearer ${jwt.sign({ id: role }, process.env.JWT_SECRET)}`,
    },
  });

  const adminResponse = await call('/api/rewards/compras', 'admin');
  assert.equal(adminResponse.status, 200);
  assert.deepEqual(seenQueries[0], {
    $or: [{ creadoPorAdmin: true }, { comercioId: null }],
  });
  assert.equal((await adminResponse.json())[0].compradorNombre, 'AbleFan');

  const commerceResponse = await call('/api/rewards/compras/comercio', 'comercio');
  assert.equal(commerceResponse.status, 200);
  assert.deepEqual(seenQueries[1], { comercioId: 'comercio' });

  assert.equal(
    (await call('/api/rewards/compras/otro-comercio', 'comercio')).status,
    403,
  );
});

test('the web reward flow never sends an empty bearer token', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../public/js/dashboard.js'),
    'utf8',
  );
  assert.doesNotMatch(source, /const token = ["']{2}/);
  assert.match(source, /const res = await fetch\(url\);/);
});
