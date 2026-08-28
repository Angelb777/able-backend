const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcryptjs');
const { createAuthRouter } = require('../api/routes/auth');
const {
  AuthenticationError,
  normalizeRole,
  userFromFirebaseToken,
  userFromLegacyToken,
} = require('../api/services/authIdentity');

test('authentication roles are canonicalized without accepting unknown values', () => {
  assert.equal(normalizeRole(' Comercio '), 'comercio');
  assert.equal(normalizeRole('ADMIN'), 'admin');
  assert.equal(normalizeRole('superadmin'), '');
});

function query(value) {
  return {
    select() { return this; },
    lean: async () => value,
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
}

function firebaseAuth(decoded = {}) {
  return {
    async verifyIdToken() { return decoded; },
    async createSessionCookie() { return 'session-cookie'; },
    async verifySessionCookie() { return decoded; },
    async revokeRefreshTokens() {},
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

test('Firebase registration creates a profile with uid, nickname and public role', async () => {
  const created = [];
  class FakeUser {
    constructor(value) { Object.assign(this, value, { _id: 'mongo-new' }); }
    async save() { created.push({ ...this }); }
    static findOne(filter) {
      if (filter.firebaseUid) return query(null);
      return query(null);
    }
    static async exists() { return false; }
  }
  const router = createAuthRouter({
    UserModel: FakeUser,
    firebaseAuth: firebaseAuth({
      uid: 'firebase-new', email: 'new@example.test', email_verified: false,
      firebase: { sign_in_provider: 'password' },
    }),
    disableRateLimit: true,
  });
  await withServer(router, async (base) => {
    const response = await fetch(`${base}/api/auth/firebase/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer firebase-token' },
      body: JSON.stringify({ nickname: 'Nuevo_73', role: 'cliente' }),
    });
    assert.equal(response.status, 201);
  });
  assert.equal(created[0].firebaseUid, 'firebase-new');
  assert.equal(created[0].nickname, 'Nuevo_73');
  assert.equal(created[0].role, 'cliente');
  assert.equal(Object.hasOwn(created[0], 'password'), false);
});

test('public Firebase registration rejects admin and legacy registration is disabled', async () => {
  class FakeUser {
    static findOne() { return query(null); }
    static async exists() { return false; }
  }
  const router = createAuthRouter({
    UserModel: FakeUser,
    firebaseAuth: firebaseAuth({ uid: 'uid', email: 'x@example.test' }),
    disableRateLimit: true,
  });
  await withServer(router, async (base) => {
    const admin = await fetch(`${base}/api/auth/firebase/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: 'token', nickname: 'AdminFake', role: 'admin' }),
    });
    assert.equal(admin.status, 403);
    const legacy = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(legacy.status, 410);
  });
});

test('Firebase Web config is available without deployment-specific environment variables', async (t) => {
  const names = [
    'FIREBASE_WEB_API_KEY',
    'FIREBASE_WEB_AUTH_DOMAIN',
    'FIREBASE_WEB_APP_ID',
    'FIREBASE_MESSAGING_SENDER_ID',
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
  const router = createAuthRouter({ disableRateLimit: true });
  await withServer(router, async (base) => {
    const response = await fetch(`${base}/api/auth/firebase-config`);
    const config = await response.json();
    assert.equal(response.status, 200);
    assert.equal(config.projectId, 'able-8a1b8');
    assert.match(config.appId, /^1:502569781663:web:/);
    assert.ok(config.apiKey);
    assert.equal(config.authDomain, 'able-8a1b8.firebaseapp.com');
  });
});

test('an unverified Firebase email never auto-links an existing profile', async () => {
  const existing = { _id: 'legacy', email: 'same@example.test', password: 'hash', role: 'cliente' };
  class FakeUser {
    static findOne(filter) { return query(filter.firebaseUid ? null : existing); }
    static async exists() { return false; }
  }
  const router = createAuthRouter({
    UserModel: FakeUser,
    firebaseAuth: firebaseAuth({ uid: 'new-uid', email: existing.email }),
    disableRateLimit: true,
  });
  await withServer(router, async (base) => {
    const response = await fetch(`${base}/api/auth/firebase/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: 'token', nickname: 'NoLink', role: 'cliente' }),
    });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.code, 'EXISTING_PROFILE_REQUIRES_LEGACY');
  });
  assert.equal(existing.firebaseUid, undefined);
});

test('verified Google login links an existing profile and preserves its identity', async () => {
  const existing = {
    _id: 'legacy-google',
    email: 'same@example.test',
    password: 'existing-hash',
    nickname: 'ExistingPlayer',
    role: 'comercio',
    authProviders: [],
    async save() {},
  };
  class FakeUser {
    static findOne(filter) { return query(filter.firebaseUid ? null : existing); }
  }
  const router = createAuthRouter({
    UserModel: FakeUser,
    firebaseAuth: firebaseAuth({
      uid: 'google-uid',
      email: existing.email,
      email_verified: true,
      firebase: { sign_in_provider: 'google.com' },
    }),
    disableRateLimit: true,
  });
  await withServer(router, async (base) => {
    const response = await fetch(`${base}/api/auth/firebase/status`, {
      method: 'POST',
      headers: { authorization: 'Bearer firebase-token' },
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, 'linked');
    assert.equal(body.user.id, existing._id);
    assert.equal(body.user.nickname, existing.nickname);
    assert.equal(body.user.role, existing.role);
  });
  assert.equal(existing.firebaseUid, 'google-uid');
  assert.deepEqual(existing.authProviders, ['google.com']);
  assert.equal(existing.password, 'existing-hash');
});

test('legacy login accepts only existing profiles without firebaseUid and hides enumeration', async (t) => {
  const originalCompare = bcrypt.compare;
  bcrypt.compare = async () => true;
  t.after(() => { bcrypt.compare = originalCompare; });
  const legacy = { _id: 'legacy', email: 'legacy@example.test', password: 'hash', role: 'cliente' };
  class FakeUser {
    static findOne(filter) { return query(String(filter.email?.$regex).includes('legacy') ? legacy : null); }
  }
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-secret';
  t.after(() => { process.env.JWT_SECRET = previousSecret; });
  const router = createAuthRouter({ UserModel: FakeUser, disableRateLimit: true });
  await withServer(router, async (base) => {
    const ok = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: legacy.email, password: ' password with spaces ' }),
    });
    assert.equal(ok.status, 200);
    const missing = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'missing@example.test', password: 'wrong' }),
    });
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).error, 'El correo o la contrasena no son correctos');
  });
});

test('linked admins retain password fallback when Firebase Web is unavailable', async (t) => {
  const originalCompare = bcrypt.compare;
  bcrypt.compare = async () => true;
  t.after(() => { bcrypt.compare = originalCompare; });
  const admin = {
    _id: 'linked-admin', email: 'admin@example.test', password: 'hash',
    role: 'admin', firebaseUid: 'google-admin',
  };
  class FakeUser { static findOne() { return query(admin); } }
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'admin-fallback-secret';
  t.after(() => { process.env.JWT_SECRET = previousSecret; });
  const router = createAuthRouter({ UserModel: FakeUser, disableRateLimit: true });
  await withServer(router, async (base) => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: admin.email, password: 'secret' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.role, 'admin');
  });
});

test('Firebase token requires verified password email and role comes from MongoDB', async () => {
  const UserModel = {
    findOne() { return query({ _id: 'mongo-id', role: 'admin', firebaseUid: 'uid', email: 'a@b.test' }); },
  };
  await assert.rejects(
    userFromFirebaseToken('token', {
      UserModel,
      firebaseAuth: firebaseAuth({
        uid: 'uid', email_verified: false, firebase: { sign_in_provider: 'password' },
      }),
    }),
    (error) => error instanceof AuthenticationError && error.code === 'EMAIL_NOT_VERIFIED',
  );
  const identity = await userFromFirebaseToken('token', {
    UserModel,
    firebaseAuth: firebaseAuth({
      uid: 'uid', email_verified: true, role: 'cliente', firebase: { sign_in_provider: 'password' },
    }),
  });
  assert.equal(identity.role, 'admin');
});

test('historical mixed-case Mongo roles authorize with their canonical value', async () => {
  const UserModel = {
    findOne() {
      return query({
        _id: 'commerce-id', role: ' Comercio ', firebaseUid: 'commerce-uid',
        email: 'commerce@example.test',
      });
    },
  };
  const identity = await userFromFirebaseToken('token', {
    UserModel,
    firebaseAuth: firebaseAuth({
      uid: 'commerce-uid', email_verified: true,
      firebase: { sign_in_provider: 'password' },
    }),
  });
  assert.equal(identity.role, 'comercio');
});

test('legacy token is rejected as soon as the Mongo profile has firebaseUid', async (t) => {
  const jwt = require('jsonwebtoken');
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'legacy-secret';
  t.after(() => { process.env.JWT_SECRET = previousSecret; });
  const UserModel = {
    findById() { return query({ _id: 'mongo-id', role: 'cliente', firebaseUid: 'linked' }); },
  };
  const token = jwt.sign({ id: 'mongo-id', role: 'admin' }, process.env.JWT_SECRET);
  await assert.rejects(
    userFromLegacyToken(token, { UserModel }),
    (error) => error.code === 'LEGACY_ACCOUNT_NOT_ELIGIBLE',
  );
});

test('legacy admin token remains valid for a linked admin fallback session', async (t) => {
  const jwt = require('jsonwebtoken');
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'linked-admin-secret';
  t.after(() => { process.env.JWT_SECRET = previousSecret; });
  const UserModel = {
    findById() {
      return query({
        _id: 'linked-admin', role: 'admin', firebaseUid: 'google-admin',
        email: 'admin@example.test',
      });
    },
  };
  const token = jwt.sign({ id: 'linked-admin', legacy: true }, process.env.JWT_SECRET);
  const identity = await userFromLegacyToken(token, { UserModel });
  assert.equal(identity.role, 'admin');
  assert.equal(identity.authType, 'legacy');
});

test('authentication endpoint rate limits repeated attempts', async () => {
  class FakeUser { static findOne() { return query(null); } }
  const router = createAuthRouter({ UserModel: FakeUser });
  await withServer(router, async (base) => {
    let last;
    for (let index = 0; index < 11; index += 1) {
      last = await fetch(`${base}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'missing@example.test', password: 'wrong' }),
      });
    }
    assert.equal(last.status, 429);
  });
});

test('web legacy session uses HttpOnly cookie and requires CSRF', async (t) => {
  const originalCompare = bcrypt.compare;
  bcrypt.compare = async () => true;
  t.after(() => { bcrypt.compare = originalCompare; });
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'web-legacy-secret';
  t.after(() => { process.env.JWT_SECRET = previousSecret; });
  const user = { _id: 'legacy', email: 'legacy@example.test', password: 'hash', role: 'cliente' };
  class FakeUser { static findOne() { return query(user); } }
  const router = createAuthRouter({ UserModel: FakeUser, disableRateLimit: true });
  await withServer(router, async (base) => {
    const csrfResponse = await fetch(`${base}/api/auth/csrf`);
    const csrfBody = await csrfResponse.json();
    const csrfCookie = csrfResponse.headers.get('set-cookie').split(';')[0];
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: csrfCookie,
        'x-csrf-token': csrfBody.csrfToken,
      },
      body: JSON.stringify({ email: user.email, password: 'secret', webSession: true }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /able73_legacy=/);
    assert.match(cookie, /HttpOnly/i);
    assert.doesNotMatch(await response.text(), /"token"/);
  });
});

test('web Firebase session cookie is HttpOnly and logout revokes and clears sessions', async () => {
  const revoked = [];
  const now = Math.floor(Date.now() / 1000);
  const decoded = {
    uid: 'firebase-web', email: 'web@example.test', email_verified: true,
    auth_time: now, firebase: { sign_in_provider: 'password' },
  };
  const auth = {
    async verifyIdToken() { return decoded; },
    async createSessionCookie() { return 'firebase-session-value'; },
    async verifySessionCookie() { return decoded; },
    async revokeRefreshTokens(uid) { revoked.push(uid); },
  };
  class FakeUser {
    static findOne() {
      return query({
        _id: 'mongo-web', role: 'cliente', firebaseUid: decoded.uid,
        email: decoded.email, nickname: 'WebFirebase',
      });
    }
  }
  const router = createAuthRouter({
    UserModel: FakeUser, firebaseAuth: auth, disableRateLimit: true,
  });
  await withServer(router, async (base) => {
    const csrfResponse = await fetch(`${base}/api/auth/csrf`);
    const csrf = await csrfResponse.json();
    const csrfCookie = csrfResponse.headers.get('set-cookie').split(';')[0];
    const login = await fetch(`${base}/api/auth/session-login`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer firebase-id-token',
        cookie: csrfCookie,
        'x-csrf-token': csrf.csrfToken,
      },
    });
    assert.equal(login.status, 200);
    const sessionSetCookie = login.headers.get('set-cookie');
    assert.match(sessionSetCookie, /able73_session=firebase-session-value/);
    assert.match(sessionSetCookie, /HttpOnly/i);
    const sessionCookie = sessionSetCookie.split(';')[0];

    const logout = await fetch(`${base}/api/auth/session-logout`, {
      method: 'POST',
      headers: {
        cookie: `${csrfCookie}; ${sessionCookie}`,
        'x-csrf-token': csrf.csrfToken,
      },
    });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get('set-cookie'), /able73_session=;/);
  });
  assert.deepEqual(revoked, ['firebase-web']);
});

test('invalid Firebase token is rejected', async () => {
  const auth = { async verifyIdToken() { throw new Error('invalid'); } };
  await assert.rejects(
    userFromFirebaseToken('bad-token', { firebaseAuth: auth, UserModel: {} }),
    (error) => error.code === 'INVALID_FIREBASE_TOKEN',
  );
});

test('missing Firebase Admin credentials are reported as server configuration', async () => {
  const credentialError = new Error(
    'Could not load the default credentials. Browse to Google Cloud auth.',
  );
  credentialError.code = 'app/invalid-credential';
  const auth = {
    async verifyIdToken() { throw credentialError; },
  };
  await assert.rejects(
    userFromFirebaseToken('valid-looking-token', {
      firebaseAuth: auth,
      UserModel: {},
    }),
    (error) =>
      error.code === 'FIREBASE_ADMIN_NOT_CONFIGURED' && error.status === 503,
  );
});

test('Google provider does not require email verification and retains Mongo role', async () => {
  const UserModel = {
    findOne() { return query({ _id: 'google-mongo', role: 'comercio', firebaseUid: 'google-uid', email: 'g@test' }); },
  };
  const identity = await userFromFirebaseToken('token', {
    UserModel,
    firebaseAuth: firebaseAuth({
      uid: 'google-uid', email_verified: false,
      firebase: { sign_in_provider: 'google.com' },
    }),
  });
  assert.equal(identity.role, 'comercio');
  assert.deepEqual(identity.providers, ['google.com']);
});
