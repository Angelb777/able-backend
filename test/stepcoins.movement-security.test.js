const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../api/models/User');
const StepcoinTransaction = require('../api/models/StepcoinTransaction');
const stepcoinsRouter = require('../api/routes/stepcoins');

test('authenticated users cannot mint walking rewards with arbitrary claim ids', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  const originalFindById = User.findById;
  const originalStartSession = User.startSession;
  process.env.JWT_SECRET = 'movement-security-test-secret-32-characters';
  const userId = '507f1f77bcf86cd799439011';
  const token = jwt.sign({ id: userId, role: 'cliente' }, process.env.JWT_SECRET);
  let transactionAttempts = 0;
  User.findById = (id) => ({
    select() { return this; },
    lean: async () => ({ _id: id, role: 'cliente', email: 'walker@test', firebaseUid: null }),
  });
  User.startSession = async () => {
    transactionAttempts += 1;
    throw new Error('an arbitrary movement request must be rejected before a transaction');
  };

  const app = express();
  app.use(express.json());
  app.use('/api/stepcoins', stepcoinsRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    if (previousSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    User.findById = originalFindById;
    User.startSession = originalStartSession;
    await new Promise((resolve) => server.close(resolve));
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/stepcoins/adjust`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId,
        cantidad: 500,
        tipo: 'recompensa',
        source: 'walking_pedometer',
        claimId: `random-attacker-claim-${attempt}`,
      }),
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /no valida/i);
  }
  assert.equal(transactionAttempts, 0);
});

test('server movement session consumes each sequence once and keeps retries idempotent', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  const originals = {
    findById: User.findById,
    startSession: User.startSession,
    transactionFindOne: StepcoinTransaction.findOne,
    transactionSave: StepcoinTransaction.prototype.save,
  };
  process.env.JWT_SECRET = 'movement-sequence-test-secret-32-characters';
  const userId = '507f1f77bcf86cd799439011';
  const sessionId = 'server-issued-movement-session';
  const token = jwt.sign({ id: userId, role: 'cliente' }, process.env.JWT_SECRET);
  const user = {
    _id: userId,
    role: 'cliente',
    email: 'walker@test',
    firebaseUid: null,
    stepcoins: 1000,
    movementSessions: [{
      source: 'walking_pedometer',
      id: sessionId,
      issuedAt: new Date(Date.now() - 10 * 60 * 1000),
      nextSequence: 1,
      totalClaimed: 0,
    }],
    async save() {},
  };
  const ledger = new Map();
  const query = (value) => {
    const result = {
      select() { return result; },
      session() { return result; },
      lean: async () => value,
      then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
    };
    return result;
  };
  User.findById = () => query(user);
  User.startSession = async () => {
    let active = false;
    return {
      startTransaction() { active = true; },
      inTransaction() { return active; },
      async commitTransaction() { active = false; },
      async abortTransaction() { active = false; },
      async endSession() {},
    };
  };
  StepcoinTransaction.findOne = ({ operationKey }) => query(ledger.get(operationKey) || null);
  StepcoinTransaction.prototype.save = async function save() {
    ledger.set(this.operationKey, this.toObject());
    return this;
  };

  const app = express();
  app.use(express.json());
  app.use('/api/stepcoins', stepcoinsRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    if (previousSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    User.findById = originals.findById;
    User.startSession = originals.startSession;
    StepcoinTransaction.findOne = originals.transactionFindOne;
    StepcoinTransaction.prototype.save = originals.transactionSave;
    await new Promise((resolve) => server.close(resolve));
  });

  const claim = (sequence, claimId, cantidad = 100) => fetch(`${baseUrl}/api/stepcoins/adjust`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      userId,
      cantidad,
      tipo: 'recompensa',
      source: 'walking_pedometer',
      claimId,
      movementSessionId: sessionId,
      movementSequence: sequence,
    }),
  });

  const first = await claim(1, 'durable-client-claim-1');
  assert.equal(first.status, 200);
  assert.equal(user.stepcoins, 1100);
  assert.equal(user.movementSessions[0].nextSequence, 2);

  const retry = await claim(1, 'durable-client-claim-1');
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, true);
  assert.equal(user.stepcoins, 1100);

  const second = await claim(2, 'durable-client-claim-2');
  assert.equal(second.status, 200);
  assert.equal(user.stepcoins, 1200);
  assert.equal(user.movementSessions[0].nextSequence, 3);

  user.movementSessions[0].availableReward = 500;
  user.movementSessions[0].allowanceUpdatedAt = new Date();
  const allowedBurst = await claim(3, 'server-authorized-burst', 500);
  assert.equal(allowedBurst.status, 200);
  assert.equal(user.stepcoins, 1700);
  const repeatedBurst = await claim(4, 'new-random-attacker-claim', 500);
  assert.equal(repeatedBurst.status, 429);
  assert.equal(user.stepcoins, 1700);

  user.movementSessions.push({
    source: 'cycling_gps',
    id: 'server-issued-cycling-session',
    issuedAt: new Date(),
    nextSequence: 1,
    totalClaimed: 0,
  });
  const implausible = await fetch(`${baseUrl}/api/stepcoins/adjust`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      userId,
      cantidad: 500,
      tipo: 'recompensa',
      source: 'cycling_gps',
      claimId: 'implausible-immediate-cycling-claim',
      movementSessionId: 'server-issued-cycling-session',
      movementSequence: 1,
    }),
  });
  assert.equal(implausible.status, 429);
  assert.equal((await implausible.json()).code, 'ANOMALOUS_STEPCOIN_REWARD');
  assert.equal(user.stepcoins, 1700);
});
