const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup(status, screen = 'register') {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      value: id === 'rol' || id === 'google-role' ? 'cliente' : '',
      hidden: true, checked: false, disabled: false, textContent: '',
      handlers: {}, addEventListener(event, handler) { this.handlers[event] = handler; },
    });
    return nodes.get(id);
  }
  const calls = [];
  const user = { email: 'google@example.test' };
  const context = {
    document: { getElementById: node },
    location: { assign: (path) => calls.push(['redirect', path]) },
    GoogleAuthProvider: class {},
    firebaseAuth: async () => ({}),
    signInWithPopup: async () => { calls.push(['google']); return { user }; },
    firebaseStatus: async () => ({ status }),
    createAbleProfile: async (...args) => calls.push(['profile', ...args]),
    acceptCurrentTerms: async () => calls.push(['terms']),
    createWebSession: async () => calls.push(['session']),
    friendlyError: (error) => error.message,
  };
  const source = fs.readFileSync(`${__dirname}/../public/js/${screen}.js`, 'utf8')
    .replace(/^import\s*\{[\s\S]*?\}\s*from\s*'[^']+';\s*/, '');
  vm.runInNewContext(source, context);
  return { node, calls, user };
}

test('existing Google account enters with empty email signup fields', async () => {
  const { node, calls } = setup('linked');
  await node('google-register').handlers.click();
  assert.deepEqual(calls, [['google'], ['session'], ['redirect', '/dashboard.html']]);
  assert.equal(node('google-onboarding').hidden, true);
});

test('new Google account asks nickname after Google then creates profile', async () => {
  const { node, calls, user } = setup('needs_profile');
  await node('google-register').handlers.click();
  assert.deepEqual(calls, [['google']]);
  assert.equal(node('google-onboarding').hidden, false);
  await node('complete-google-profile').handlers.click();
  assert.deepEqual(calls, [['google']]);
  node('google-nickname').value = 'Nuevo_73';
  node('google-role').value = 'comercio';
  await node('complete-google-profile').handlers.click();
  assert.deepEqual(calls, [
    ['google'], ['profile', user, 'Nuevo_73', 'comercio'],
    ['session'], ['redirect', '/dashboard.html'],
  ]);
});

test('existing Google account completes pending terms and enters', async () => {
  const { node, calls } = setup('terms_required');
  await node('google-register').handlers.click();
  assert.deepEqual(calls, [['google'], ['terms'], ['session'], ['redirect', '/dashboard.html']]);
});

test('Google login also enters an existing account with empty form fields', async () => {
  const { node, calls } = setup('linked', 'login');
  await node('google-login').handlers.click();
  assert.deepEqual(calls, [['google'], ['session'], ['redirect', '/dashboard.html']]);
});

test('Google login also asks a new account for nickname after authentication', async () => {
  const { node, calls, user } = setup('needs_profile', 'login');
  await node('google-login').handlers.click();
  assert.deepEqual(calls, [['google']]);
  assert.equal(node('google-onboarding').hidden, false);
  node('google-nickname').value = 'Nuevo_73';
  node('google-role').value = 'cliente';
  await node('complete-google-profile').handlers.click();
  assert.deepEqual(calls, [
    ['google'], ['profile', user, 'Nuevo_73', 'cliente'],
    ['session'], ['redirect', '/dashboard.html'],
  ]);
});
