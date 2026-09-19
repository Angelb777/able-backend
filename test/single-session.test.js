const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { io: client } = require('socket.io-client');
const User = require('../api/models/User');
const { issueAccountSession, accountSessionIdentity, userFromFirebaseToken, userFromLegacyToken } = require('../api/services/authIdentity');
const { createAuthRouter } = require('../api/routes/auth');
const { verifyToken } = require('../api/middlewares/authMiddleware');
const registerPvp = require('../sockets/pvp.socket');

const query = value => ({ select() { return this; }, lean: async () => value,
  then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
function model(profile) {
  return {
    findById: id => query(String(id) === profile._id ? profile : null),
    findOne: filter => query(filter.firebaseUid === profile.firebaseUid ? profile : null),
    async updateOne(filter, update) {
      if (filter.activeSessionId?.$exists === false && profile.activeSessionId !== undefined) return { matchedCount: 0, modifiedCount: 0 };
      if (typeof filter.activeSessionId === 'string' && filter.activeSessionId !== profile.activeSessionId) return { matchedCount: 0, modifiedCount: 0 };
      if (filter.$or && profile.latestFirebaseAuthTime !== undefined && profile.latestFirebaseAuthTime >= filter.$or[1].latestFirebaseAuthTime.$lt) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(profile, update.$set); return { matchedCount: 1, modifiedCount: 1 };
    },
  };
}
const profile = () => ({ _id: '507f1f77bcf86cd799439011', firebaseUid: 'uid', role: 'cliente',
  email: 'test@example.test', nickname: 'Test', termsVersionAccepted: '1.0', termsAcceptedAt: new Date() });
process.env.JWT_SECRET = 'single-session-test-only';

test('new session replaces the old one, including raw Firebase and legacy credentials', async () => {
  const user = profile(), UserModel = model(user);
  const a = await issueAccountSession(user, UserModel);
  const b = await issueAccountSession(user, UserModel);
  await assert.rejects(accountSessionIdentity(a, { UserModel }), { code: 'SESSION_REPLACED' });
  assert.equal((await accountSessionIdentity(b, { UserModel })).id, user._id);
  await assert.rejects(userFromFirebaseToken('raw', { UserModel, firebaseAuth: {
    verifyIdToken: async () => ({ uid: 'uid', email_verified: true }) } }), { code: 'SESSION_REPLACED' });
  delete user.firebaseUid;
  await assert.rejects(userFromLegacyToken(jwt.sign({ id: user._id }, process.env.JWT_SECRET), { UserModel }), { code: 'SESSION_REPLACED' });
});

test('displaced sessions cannot refresh or claim rewards; current session survives a restart', async t => {
  const user = profile(), UserModel = model(user);
  const original = User.findById;
  User.findById = UserModel.findById;
  t.after(() => { User.findById = original; });
  const now = Math.floor(Date.now() / 1000);
  const firebaseAuth = { verifyIdToken: async () => ({ uid: 'uid', auth_time: now, email_verified: true, firebase: { sign_in_provider: 'password' } }) };
  const app = express(); app.use(express.json());
  app.use('/auth', createAuthRouter({ UserModel, firebaseAuth, disableRateLimit: true }));
  let rewards = 0;
  app.post('/reward', verifyToken, (_, res) => { rewards++; res.json({ ok: true }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${url}/auth/firebase/status`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer firebase' }, body: JSON.stringify({ newSession: true }) });
  assert.equal(login.status, 200);
  const a = (await login.json()).token;
  const b = await issueAccountSession(user, UserModel);
  const reward = await fetch(`${url}/reward`, { method: 'POST', headers: { authorization: `Bearer ${a}` } });
  assert.equal(reward.status, 401); assert.equal(rewards, 0);
  const restore = token => fetch(`${url}/auth/firebase/status`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer firebase', 'x-able-session': token }, body: JSON.stringify({ newSession: false }) });
  assert.equal((await restore(a)).status, 401);
  const resumed = await restore(b); assert.equal(resumed.status, 200);
  assert.equal(jwt.decode((await resumed.json()).token).sessionId, jwt.decode(b).sessionId);
  assert.equal((await accountSessionIdentity(b, { UserModel })).id, user._id);
  const noProof = await restore(''); assert.equal(noProof.status, 401);
  const replay = await fetch(`${url}/auth/firebase/status`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer firebase' }, body: JSON.stringify({ newSession: true }) });
  assert.equal(replay.status, 401);
});

test('authenticated map socket disconnects when its session is replaced', async t => {
  const user = profile(), UserModel = model(user);
  const token = await issueAccountSession(user, UserModel);
  const server = http.createServer(); const io = new Server(server);
  registerPvp(io, { UserModel, requireAuth: true,
    resolveAuthToken: token => accountSessionIdentity(token, { UserModel }) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => io.close(r)));
  const socket = client(`http://127.0.0.1:${server.address().port}/pvp`, { transports: ['websocket'], auth: { token }, reconnection: false });
  t.after(() => socket.disconnect());
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  await issueAccountSession(user, UserModel);
  const disconnected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket remained connected')), 11000);
    socket.once('disconnect', () => { clearTimeout(timer); resolve(); });
  });
  socket.emit('presence:move', {});
  await disconnected; assert.equal(socket.connected, false);
});
