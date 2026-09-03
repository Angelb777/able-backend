const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../api/models/User');
const { buildGoogleUserDocument } = require('../api/utils/googleAccount');

test('login never generates a nickname or returns the private name', async (t) => {
  const originalFindOne = User.findOne;
  const originalCompare = bcrypt.compare;
  const originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'nickname-auth-test';
  const stored = {
    _id: '66b0b91187f9f1a0b30db490',
    nombre: 'Nombre Muy Privado',
    email: 'legacy@example.test',
    password: 'hash',
    role: 'cliente',
    termsVersionAccepted: '1.0',
    termsAcceptedAt: new Date(),
  };
  User.findOne = async () => stored;
  bcrypt.compare = async () => true;
  t.after(() => {
    User.findOne = originalFindOne;
    bcrypt.compare = originalCompare;
    if (originalSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../api/routes/auth'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: stored.email, password: 'secret' }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.user.needsNickname, true);
  assert.equal(body.user.nickname, '');
  assert.equal(Object.hasOwn(body.user, 'nombre'), false);
  assert.doesNotMatch(JSON.stringify(body), /Nombre Muy Privado/);
  assert.equal(stored.nickname, undefined);
});

test('new Google accounts retain private name but never derive a nickname from it', () => {
  const document = buildGoogleUserDocument({
    privateName: 'Nombre de Google',
    email: 'google@example.test',
    uid: 'google-uid',
    passwordHash: 'hash',
  });
  assert.equal(document.nombre, 'Nombre de Google');
  assert.equal(Object.hasOwn(document, 'nickname'), false);
  assert.equal(Object.hasOwn(document, 'normalizedNickname'), false);
});
