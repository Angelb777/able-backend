const test = require('node:test');
const assert = require('node:assert/strict');

const {
  effectiveCard,
  upgradeLevelForUser,
  upgradedValue,
} = require('../api/services/cardUpgrades');

test('calcula cada nivel desde el valor base, sin acumular porcentajes', () => {
  assert.equal(upgradedValue(100, 0), 100);
  assert.equal(upgradedValue(100, 1), 110);
  assert.equal(upgradedValue(100, 2), 120);
  assert.equal(upgradedValue(100, 3), 130);
});

test('proyectil mejora dano y alcance pero conserva el resto', () => {
  const card = effectiveCard({
    _id: 'card-1',
    tipoArma: 'Proyectil',
    dano: 100,
    alcance: 50,
    tiempoEspera: 8,
  }, 2);

  assert.equal(card.upgradeLevel, 2);
  assert.equal(card.dano, 120);
  assert.equal(card.alcance, 60);
  assert.equal(card.tiempoEspera, 8);
  assert.deepEqual(card.baseValues, {
    dano: 100,
    alcance: 50,
    vidaQueDa: 0,
  });
});

test('vida mejora la curacion y las cartas antiguas quedan en nivel cero', () => {
  const user = { cardUpgrades: [] };
  assert.equal(upgradeLevelForUser(user, 'card-life'), 0);

  const card = effectiveCard({
    _id: 'card-life',
    tipoArma: 'Vida',
    dano: 0,
    alcance: 0,
    vida: 125,
    vidaQueDa: 125,
  }, 3);
  assert.equal(card.vida, 163);
  assert.equal(card.vidaQueDa, 163);
});

test('una carta de dano no proyectil no modifica su alcance', () => {
  const card = effectiveCard({
    tipoArma: 'Arrastre',
    dano: 80,
    alcance: 90,
  }, 1);
  assert.equal(card.dano, 88);
  assert.equal(card.alcance, 90);
});
