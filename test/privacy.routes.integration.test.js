const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const fs = require('node:fs');
const path = require('node:path');
const User = require('../api/models/User');
const Clan = require('../api/models/Clan');
const Bounty = require('../api/models/Bounty');
const Notification = require('../api/models/Notification');
const StepcoinTransaction = require('../api/models/StepcoinTransaction');

class FakeQuery {
  constructor(value) { this.value = value; }
  select() { return this; }
  populate() { return this; }
  lean() { return Promise.resolve({ ...this.value }); }
  then(resolve, reject) { return Promise.resolve(this.value).then(resolve, reject); }
}

test('social me and users/:id expose only minimal public/self fields', async (t) => {
  const id = new mongoose.Types.ObjectId();
  const originalFindById = User.findById;
  const originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'privacy-test-secret';
  const stored = {
    _id: id,
    nickname: '',
    nombre: 'Nombre Real Secreto',
    email: 'secret@example.test',
    fotoPerfil: '/avatar.png',
    stepcoins: 321,
    role: 'cliente',
    profile: { address: 'Dirección privada' },
    skinSeleccionada: null,
  };
  User.findById = () => new FakeQuery(stored);
  t.after(() => {
    User.findById = originalFindById;
    if (originalSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  const app = express();
  app.use(express.json());
  app.use('/api/social', require('../api/routes/social'));
  app.use('/api/users', require('../api/routes/users'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const token = jwt.sign({ id: String(id), role: 'cliente' }, process.env.JWT_SECRET);
  const headers = { authorization: `Bearer ${token}` };

  const socialResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/social/me`, { headers });
  const social = await socialResponse.json();
  assert.deepEqual(Object.keys(social).sort(), [
    'avatarUrl', 'hasChosenNickname', 'id', 'needsNickname', 'nickname', 'role', 'stepcoins',
  ]);
  assert.equal(social.nickname, `Jugador-${String(id).slice(-5).toUpperCase()}`);
  assert.equal(social.needsNickname, true);
  assert.equal(social.role, 'cliente');
  assert.doesNotMatch(JSON.stringify(social), /Nombre Real|secret@example|Dirección/);

  const publicWithoutToken = await fetch(`http://127.0.0.1:${server.address().port}/api/users/${id}`);
  assert.equal(publicWithoutToken.status, 401);
  const selfResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/users/${id}`, { headers });
  const self = await selfResponse.json();
  assert.deepEqual(Object.keys(self).sort(), [
    'avatarUrl', 'hasChosenNickname', 'id', 'needsNickname', 'nickname', 'skinSeleccionada', 'stepcoins',
  ]);
  assert.doesNotMatch(JSON.stringify(self), /Nombre Real|secret@example|Dirección/);
});

test('social relations are keyed by ObjectId, never nickname', () => {
  assert.equal(Clan.schema.path('members').schema.path('userId').instance, 'ObjectId');
  assert.equal(Bounty.schema.path('targetUserId').instance, 'ObjectId');
  assert.equal(Bounty.schema.path('createdByUserId').instance, 'ObjectId');
  assert.equal(Notification.schema.path('userId').instance, 'ObjectId');
  assert.equal(StepcoinTransaction.schema.path('userId').instance, 'ObjectId');
});

test('public social serializers never reference the private nombre field', () => {
  for (const relative of [
    '../api/routes/social.js',
    '../api/routes/clans.js',
    '../sockets/pvp.socket.js',
  ]) {
    const source = fs.readFileSync(path.join(__dirname, relative), 'utf8');
    assert.doesNotMatch(source, /\.nombre\b|\[['"]nombre['"]\]|\bnombre\s*:/);
  }
});
