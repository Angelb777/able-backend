const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const User = require('../api/models/User');
const Taunt = require('../api/models/Taunt');
const StepcoinTransaction = require('../api/models/StepcoinTransaction');
const socialRealtime = require('../api/services/socialRealtime');
const socialRouter = require('../api/routes/social');

class FakeQuery {
  constructor(value) { this.value = value; }
  session() { return this; }
  select() { return this; }
  async lean() { return this.value ? { ...this.value } : this.value; }
  then(resolve, reject) { return Promise.resolve(this.value).then(resolve, reject); }
}

test('taunts use server price, atomic balance checks, cooldown and realtime delivery', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'taunt-route-test-secret';
  const senderId = new mongoose.Types.ObjectId();
  const poorSenderId = new mongoose.Types.ObjectId();
  const targetId = new mongoose.Types.ObjectId();
  const tauntId = new mongoose.Types.ObjectId();
  const users = new Map([
    [String(senderId), { _id: senderId, nickname: 'Sender', stepcoins: 300 }],
    [String(poorSenderId), { _id: poorSenderId, nickname: 'Poor', stepcoins: 5 }],
    [String(targetId), { _id: targetId, nickname: 'Target', stepcoins: 100 }],
  ]);
  const ledger = new Map();
  const received = [];
  const targetSocket = {
    id: 'target-socket',
    connected: true,
    emit(event, payload) { received.push({ event, payload }); },
  };
  socialRealtime.register(targetId, targetSocket);

  const originals = {
    startSession: mongoose.startSession,
    userFindById: User.findById,
    userFindOneAndUpdate: User.findOneAndUpdate,
    userUpdateOne: User.updateOne,
    tauntFindOne: Taunt.findOne,
    stepcoinFindOne: StepcoinTransaction.findOne,
    stepcoinCreate: StepcoinTransaction.create,
  };
  mongoose.startSession = async () => ({
    async withTransaction(callback) { return callback(); },
    async endSession() {},
  });
  User.findById = (id) => new FakeQuery(users.get(String(id)) || null);
  User.findOneAndUpdate = (query, update) => {
    const user = users.get(String(query._id));
    if (!user || user.stepcoins < query.stepcoins.$gte) return new FakeQuery(null);
    user.stepcoins += update.$inc.stepcoins;
    return new FakeQuery({ ...user });
  };
  User.updateOne = async (query, update) => {
    const user = users.get(String(query._id));
    if (user) user.stepcoins += update.$inc?.stepcoins || 0;
  };
  Taunt.findOne = (query) => new FakeQuery(
    String(query._id) === String(tauntId) && query.active
      ? { _id: tauntId, name: 'Reto', price: 250, durationMs: 2500, active: true }
      : null
  );
  StepcoinTransaction.findOne = (query) => new FakeQuery(ledger.get(query.operationKey) || null);
  StepcoinTransaction.create = async (rows) => {
    const list = Array.isArray(rows) ? rows : [rows];
    for (const row of list) ledger.set(row.operationKey, row);
    return list;
  };

  const app = express();
  app.use(express.json());
  app.use('/api/social', socialRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const call = async (userId, body) => {
    const token = jwt.sign({ id: String(userId), role: 'cliente' }, process.env.JWT_SECRET);
    const response = await fetch(`${baseUrl}/api/social/taunts/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };

  t.after(async () => {
    socialRealtime.unregister(targetId, targetSocket);
    mongoose.startSession = originals.startSession;
    User.findById = originals.userFindById;
    User.findOneAndUpdate = originals.userFindOneAndUpdate;
    User.updateOne = originals.userUpdateOne;
    Taunt.findOne = originals.tauntFindOne;
    StepcoinTransaction.findOne = originals.stepcoinFindOne;
    StepcoinTransaction.create = originals.stepcoinCreate;
    if (previousSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    await new Promise((resolve) => server.close(resolve));
  });

  const self = await call(senderId, {
    targetUserId: String(senderId),
    tauntId: String(tauntId),
    requestKey: 'self',
  });
  assert.equal(self.status, 400);

  const sent = await call(senderId, {
    targetUserId: String(targetId),
    tauntId: String(tauntId),
    price: 1,
    requestKey: 'send-1',
  });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.balance, 50);
  assert.equal(users.get(String(senderId)).stepcoins, 50);
  assert.equal(ledger.get(`taunt:${senderId}:send-1`).cantidad, -250);
  assert.equal(received.filter((item) => item.event === 'taunt:received').length, 1);

  const cooldown = await call(senderId, {
    targetUserId: String(targetId),
    tauntId: String(tauntId),
    requestKey: 'send-2',
  });
  assert.equal(cooldown.status, 429);
  assert.equal(users.get(String(senderId)).stepcoins, 50);

  const insufficient = await call(poorSenderId, {
    targetUserId: String(targetId),
    tauntId: String(tauntId),
    requestKey: 'poor-1',
  });
  assert.equal(insufficient.status, 409);
  assert.equal(users.get(String(poorSenderId)).stepcoins, 5);
});
