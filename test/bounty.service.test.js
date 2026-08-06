const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Bounty = require('../api/models/Bounty');
const User = require('../api/models/User');
const StepcoinTransaction = require('../api/models/StepcoinTransaction');
const CombatKillEvent = require('../api/models/CombatKillEvent');
const Notification = require('../api/models/Notification');
const clanMembershipCache = require('../api/services/clanMembershipCache');
const bountyService = require('../api/services/bountyService');

class FakeQuery {
  constructor(value) { this.value = value; }
  session() { return this; }
  select() { return this; }
  async lean() {
    if (Array.isArray(this.value)) return this.value.map((item) => ({ ...item }));
    return this.value ? { ...this.value } : this.value;
  }
  then(resolve, reject) { return Promise.resolve(this.value).then(resolve, reject); }
}

test('bounty claims and expiration are idempotent and enforce antifraud rules', async (t) => {
  const ids = {
    killer: new mongoose.Types.ObjectId(),
    target: new mongoose.Types.ObjectId(),
    creator: new mongoose.Types.ObjectId(),
    creatorTwo: new mongoose.Types.ObjectId(),
    protectedTarget: new mongoose.Types.ObjectId(),
  };
  const balances = new Map([
    [String(ids.killer), 0],
    [String(ids.creator), 0],
    [String(ids.creatorTwo), 0],
  ]);
  const bounties = [
    {
      _id: new mongoose.Types.ObjectId(),
      targetUserId: ids.target,
      createdByUserId: ids.creatorTwo,
      amount: 100,
      status: 'active',
      expiresAt: new Date(Date.now() + 60000),
      async save() { return this; },
    },
    {
      _id: new mongoose.Types.ObjectId(),
      targetUserId: ids.target,
      createdByUserId: ids.creator,
      amount: 60,
      status: 'active',
      expiresAt: new Date(Date.now() + 60000),
      async save() { return this; },
    },
    {
      _id: new mongoose.Types.ObjectId(),
      targetUserId: ids.protectedTarget,
      createdByUserId: ids.killer,
      amount: 40,
      status: 'active',
      expiresAt: new Date(Date.now() + 60000),
      async save() { return this; },
    },
    {
      _id: new mongoose.Types.ObjectId(),
      targetUserId: ids.target,
      createdByUserId: ids.killer,
      amount: 40,
      status: 'active',
      expiresAt: new Date(Date.now() + 60000),
      async save() { return this; },
    },
  ];
  const killEvents = new Map();
  const transactions = new Map();
  const originals = {
    startSession: mongoose.startSession,
    bountyFind: Bounty.find,
    bountyFindOneAndUpdate: Bounty.findOneAndUpdate,
    bountyAggregate: Bounty.aggregate,
    userUpdateOne: User.updateOne,
    stepcoinFindOne: StepcoinTransaction.findOne,
    stepcoinCreate: StepcoinTransaction.create,
    killFindOne: CombatKillEvent.findOne,
    killCreate: CombatKillEvent.create,
    notificationCreate: Notification.create,
    notificationFindOne: Notification.findOne,
    shareActiveClan: clanMembershipCache.shareActiveClan,
  };

  mongoose.startSession = async () => ({
    async withTransaction(callback) { return callback(); },
    async endSession() {},
  });
  let protectedPair = false;
  clanMembershipCache.shareActiveClan = async () => protectedPair;
  Bounty.find = (query) => new FakeQuery(bounties.filter((item) =>
    String(item.targetUserId) === String(query.targetUserId) &&
    item.status === query.status &&
    item.expiresAt > query.expiresAt.$gt
  ));
  Bounty.aggregate = async (pipeline) => {
    const match = pipeline[0].$match;
    const total = bounties
      .filter((item) =>
        String(item.targetUserId) === String(match.targetUserId) &&
        item.status === 'active' &&
        item.expiresAt > match.expiresAt.$gt
      )
      .reduce((sum, item) => sum + item.amount, 0);
    return total ? [{ total }] : [];
  };
  Bounty.findOneAndUpdate = (query) => {
    const item = bounties.find((candidate) =>
      candidate.status === query.status && candidate.expiresAt <= query.expiresAt.$lte
    );
    if (item) {
      item.status = 'expired';
      item.refundedAt = new Date();
    }
    return new FakeQuery(item || null);
  };
  User.updateOne = async (query, update) => {
    const key = String(query._id);
    balances.set(key, (balances.get(key) || 0) + (update.$inc?.stepcoins || 0));
  };
  StepcoinTransaction.findOne = (query) => new FakeQuery(transactions.get(query.operationKey) || null);
  StepcoinTransaction.create = async (rows) => {
    const list = Array.isArray(rows) ? rows : [rows];
    for (const row of list) transactions.set(row.operationKey, row);
    return list;
  };
  CombatKillEvent.findOne = (query) => new FakeQuery(killEvents.get(query.killEventId) || null);
  CombatKillEvent.create = async (rows) => {
    for (const row of rows) killEvents.set(row.killEventId, row);
    return rows;
  };
  Notification.create = async (payload) => ({
    ...payload,
    _id: new mongoose.Types.ObjectId(),
    toObject() { return { ...this }; },
  });
  Notification.findOne = () => new FakeQuery(null);

  t.after(() => {
    mongoose.startSession = originals.startSession;
    Bounty.find = originals.bountyFind;
    Bounty.findOneAndUpdate = originals.bountyFindOneAndUpdate;
    Bounty.aggregate = originals.bountyAggregate;
    User.updateOne = originals.userUpdateOne;
    StepcoinTransaction.findOne = originals.stepcoinFindOne;
    StepcoinTransaction.create = originals.stepcoinCreate;
    CombatKillEvent.findOne = originals.killFindOne;
    CombatKillEvent.create = originals.killCreate;
    Notification.create = originals.notificationCreate;
    Notification.findOne = originals.notificationFindOne;
    clanMembershipCache.shareActiveClan = originals.shareActiveClan;
  });

  const first = await bountyService.claimForKill({
    attackerUserId: String(ids.killer),
    targetUserId: String(ids.target),
    killEventId: 'kill-1',
    source: 'bullet',
  });
  assert.equal(first.paid, 160, 'multiple valid bounties are accumulated');
  assert.equal(first.refunded, 40, 'the killer recovers their own bounty');
  assert.equal(first.claimed, 3);
  assert.equal(balances.get(String(ids.killer)), 200);
  assert.equal(bounties[0].status, 'claimed');
  assert.equal(bounties[1].status, 'claimed');
  assert.equal(bounties[3].status, 'cancelled', 'own bounty is closed and refunded');

  const duplicate = await bountyService.claimForKill({
    attackerUserId: String(ids.killer),
    targetUserId: String(ids.target),
    killEventId: 'kill-1',
    source: 'bullet',
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(balances.get(String(ids.killer)), 200, 'duplicate kill cannot pay or refund twice');

  protectedPair = true;
  const protectedResult = await bountyService.claimForKill({
    attackerUserId: String(ids.killer),
    targetUserId: String(ids.protectedTarget),
    killEventId: 'kill-protected',
    source: 'mine',
  });
  assert.equal(protectedResult.protected, true);
  assert.equal(killEvents.has('kill-protected'), false);
  protectedPair = false;

  bounties[2].expiresAt = new Date(Date.now() - 1000);
  const processed = await bountyService.processExpiredBounties({ limit: 10 });
  assert.equal(processed, 1);
  assert.equal(balances.get(String(ids.killer)), 240);
  const processedAgain = await bountyService.processExpiredBounties({ limit: 10 });
  assert.equal(processedAgain, 0);
  assert.equal(balances.get(String(ids.killer)), 240, 'refund happens once');
});
