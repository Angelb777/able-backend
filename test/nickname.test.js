const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeNickname,
  validateNickname,
} = require('../api/utils/nickname');
const { technicalAlias, publicNickname } = require('../api/utils/publicIdentity');
const User = require('../api/models/User');

test('nickname normalization is case-insensitive and NFKC-stable', () => {
  assert.equal(normalizeNickname(' Angel73 '), 'angel73');
  assert.equal(normalizeNickname('ANGEL73'), 'angel73');
  assert.equal(normalizeNickname('Ａｎｇｅｌ７３'), 'angel73');
  const uniqueIndex = User.schema.indexes().find(([fields]) => fields.normalizedNickname === 1);
  assert.equal(uniqueIndex?.[1]?.unique, true);
  assert.equal(normalizeNickname('Angel73'), normalizeNickname('ANGEL73'));
});

test('nickname validation rejects spaces and invalid lengths', () => {
  assert.equal(validateNickname('ab').ok, false);
  assert.equal(validateNickname('dos palabras').ok, false);
  assert.equal(validateNickname('Ángel_73').ok, true);
  assert.equal(validateNickname('____________________').ok, false);
  assert.equal(validateNickname('abcdefghijklmnopqrstu').ok, false);
});

test('technical aliases are deterministic and never use private names', () => {
  const user = { _id: '66b0b91187f9f1a0b30db490', nombre: 'Nombre Privado' };
  assert.equal(technicalAlias(user), 'Jugador-DB490');
  assert.equal(publicNickname(user), 'Jugador-DB490');
  assert.equal(publicNickname({ ...user, nickname: 'Publico73' }), 'Publico73');
});
