const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const Clan = require('../api/models/Clan');
const User = require('../api/models/User');
const Notification = require('../api/models/Notification');
const clansRouter = require('../api/routes/clans');

class FakeQuery {
  constructor(value) { this.value = value; }
  select() { return this; }
  populate() { return this; }
  sort() { return this; }
  limit() { return this; }
  async lean() {
    if (Array.isArray(this.value)) return this.value.map((item) => item?.toObject ? item.toObject() : item);
    return this.value?.toObject ? this.value.toObject() : this.value;
  }
  then(resolve, reject) { return Promise.resolve(this.value).then(resolve, reject); }
}

test('clan REST lifecycle supports multi-membership, permissions and duplicate prevention', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'clan-route-test-secret';
  const originals = {
    clanCreate: Clan.create,
    clanFindOne: Clan.findOne,
    clanFind: Clan.find,
    userFindById: User.findById,
    userFindOne: User.findOne,
    notificationCreate: Notification.create,
    notificationFindOne: Notification.findOne,
  };

  const users = new Map();
  const addUser = (nickname) => {
    const user = new User({
      _id: new mongoose.Types.ObjectId(),
      nombre: `Privado ${nickname}`,
      nickname,
      normalizedNickname: nickname.toLowerCase(),
      email: `${nickname.toLowerCase()}@example.test`,
      password: 'hashed',
      role: 'cliente',
    });
    users.set(String(user._id), user);
    return user;
  };
  const creator = addUser('Creator');
  const member = addUser('Member');
  const applicant = addUser('Applicant');
  const outsider = addUser('Outsider');
  const clans = new Map();

  Clan.create = async (payload) => {
    const clan = new Clan({ _id: new mongoose.Types.ObjectId(), ...payload });
    clan.save = async () => clan;
    clans.set(String(clan._id), clan);
    return clan;
  };
  Clan.findOne = (query) => {
    const clan = clans.get(String(query._id));
    if (!clan || (query.status && clan.status !== query.status)) return new FakeQuery(null);
    return new FakeQuery(clan);
  };
  Clan.find = () => new FakeQuery([...clans.values()]);
  User.findById = (id) => new FakeQuery(users.get(String(id)) || null);
  User.findOne = (query) => new FakeQuery(
    [...users.values()].find((user) =>
      query.normalizedNickname && user.normalizedNickname === query.normalizedNickname
    ) || null
  );
  Notification.create = async (payload) => ({
    ...payload,
    _id: new mongoose.Types.ObjectId(),
    toObject() { return { ...this }; },
  });
  Notification.findOne = () => new FakeQuery(null);

  const app = express();
  app.use(express.json());
  app.use('/api/clans', clansRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const tokenFor = (user) => jwt.sign({ id: String(user._id), role: user.role }, process.env.JWT_SECRET);
  const call = async (user, method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenFor(user)}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    return { status: response.status, data };
  };

  t.after(async () => {
    Clan.create = originals.clanCreate;
    Clan.findOne = originals.clanFindOne;
    Clan.find = originals.clanFind;
    User.findById = originals.userFindById;
    User.findOne = originals.userFindOne;
    Notification.create = originals.notificationCreate;
    Notification.findOne = originals.notificationFindOne;
    if (previousSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    await new Promise((resolve) => server.close(resolve));
  });

  const createdOne = await call(creator, 'POST', '/api/clans', {
    name: 'Clan Uno',
    description: 'Primero',
    imageUrl: '',
    visibility: 'public',
  });
  assert.equal(createdOne.status, 201);
  assert.doesNotMatch(JSON.stringify(createdOne.data), /Privado/);
  const clanOneId = createdOne.data.clan.id;
  assert.equal(clans.get(clanOneId).members.length, 1);
  assert.equal(String(clans.get(clanOneId).members[0].userId), String(creator._id));

  const selfInvite = await call(creator, 'POST', `/api/clans/${clanOneId}/invitations`, { nickname: 'Creator' });
  assert.equal(selfInvite.status, 400);
  const unknownInvite = await call(creator, 'POST', `/api/clans/${clanOneId}/invitations`, { nickname: 'Nobody' });
  assert.equal(unknownInvite.status, 404);

  const inviteOne = await call(creator, 'POST', `/api/clans/${clanOneId}/invitations`, { nickname: 'Member' });
  assert.equal(inviteOne.status, 201);
  const duplicateInvite = await call(creator, 'POST', `/api/clans/${clanOneId}/invitations`, { nickname: 'member' });
  assert.equal(duplicateInvite.status, 409);
  const acceptOne = await call(member, 'POST', `/api/clans/${clanOneId}/invitations/${inviteOne.data.invitationId}/accept`);
  assert.equal(acceptOne.status, 200);
  assert.equal(clans.get(clanOneId).members.some((item) => String(item.userId) === String(member._id)), true);

  const createdTwo = await call(creator, 'POST', '/api/clans', {
    name: 'Clan Dos',
    description: '',
    imageUrl: '',
    visibility: 'public',
  });
  const clanTwoId = createdTwo.data.clan.id;
  const inviteTwo = await call(creator, 'POST', `/api/clans/${clanTwoId}/invitations`, { userId: String(member._id) });
  await call(member, 'POST', `/api/clans/${clanTwoId}/invitations/${inviteTwo.data.invitationId}/accept`);
  assert.equal(
    [...clans.values()].filter((clan) => clan.members.some((item) => String(item.userId) === String(member._id))).length,
    2
  );

  const memberCannotInvite = await call(member, 'POST', `/api/clans/${clanTwoId}/invitations`, { nickname: 'Outsider' });
  assert.equal(memberCannotInvite.status, 403);

  const joinRequest = await call(applicant, 'POST', `/api/clans/${clanOneId}/join-requests`);
  assert.equal(joinRequest.status, 201);
  const duplicateRequest = await call(applicant, 'POST', `/api/clans/${clanOneId}/join-requests`);
  assert.equal(duplicateRequest.status, 409);
  const memberCannotAccept = await call(member, 'POST', `/api/clans/${clanOneId}/join-requests/${joinRequest.data.requestId}/accept`);
  assert.equal(memberCannotAccept.status, 403);
  const acceptedRequest = await call(creator, 'POST', `/api/clans/${clanOneId}/join-requests/${joinRequest.data.requestId}/accept`);
  assert.equal(acceptedRequest.status, 200);

  const privateClan = await call(creator, 'POST', '/api/clans', {
    name: 'Clan Privado',
    description: '',
    imageUrl: '',
    visibility: 'private',
  });
  const privateRequest = await call(outsider, 'POST', `/api/clans/${privateClan.data.clan.id}/join-requests`);
  assert.equal(privateRequest.status, 403);

  const outsiderRequest = await call(outsider, 'POST', `/api/clans/${clanOneId}/join-requests`);
  const rejectedRequest = await call(creator, 'POST', `/api/clans/${clanOneId}/join-requests/${outsiderRequest.data.requestId}/reject`);
  assert.equal(rejectedRequest.status, 200);

  const creatorCannotLeave = await call(creator, 'POST', `/api/clans/${clanOneId}/leave`);
  assert.equal(creatorCannotLeave.status, 409);
  const memberLeaves = await call(member, 'POST', `/api/clans/${clanOneId}/leave`);
  assert.equal(memberLeaves.status, 200);
  assert.equal(clans.get(clanOneId).members.some((item) => String(item.userId) === String(member._id)), false);

  const kicked = await call(creator, 'DELETE', `/api/clans/${clanTwoId}/members/${member._id}`);
  assert.equal(kicked.status, 200);
  assert.equal(clans.get(clanTwoId).members.some((item) => String(item.userId) === String(member._id)), false);

  const deleted = await call(creator, 'DELETE', `/api/clans/${clanOneId}`);
  assert.equal(deleted.status, 200);
  assert.equal(clans.get(clanOneId).status, 'deleted');
});
