const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEMO_DURATION_MONTHS,
  LOCATIONS,
  OWNER_EMAIL,
} = require('../scripts/seed-zaragoza-demo-locations');

test('the Zaragoza demo seed keeps all locations under the dedicated commerce account', () => {
  assert.equal(OWNER_EMAIL, 'comercio@gmail.com');
  assert.equal(DEMO_DURATION_MONTHS, 12);
  assert.equal(LOCATIONS.length, 12);
  assert.equal(new Set(LOCATIONS.map((item) => item.publicName)).size, LOCATIONS.length);
});

test('the three food and coffee demos have valid map and proximity data', () => {
  const expected = new Map([
    ['Salad Boutique', 'salad-boutique.png'],
    ['Baobab', 'baobab.png'],
    ['Elio & Coco Specialty Coffee', 'elio-and-coco.png'],
  ]);

  for (const [publicName, label] of expected) {
    const location = LOCATIONS.find((item) => item.publicName === publicName);
    assert.ok(location, `${publicName} must be present`);
    assert.equal(location.label, label);
    assert.ok(location.address.includes('Zaragoza'));
    assert.ok(location.description.length > 0);
    assert.ok(location.proximityMessage.length > 0);
    assert.ok(location.proximityMessage.length <= 50);
    assert.ok(location.lat >= -90 && location.lat <= 90);
    assert.ok(location.lng >= -180 && location.lng <= 180);
  }
});
