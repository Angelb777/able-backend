const test = require('node:test');
const assert = require('node:assert/strict');

const Card = require('../api/models/Card');

test('legacy cards remain classic without requiring spritesheets', () => {
  const card = new Card({
    titulo: 'Legacy projectile',
    tipoArma: 'Proyectil',
    imagenesArma: ['/uploads/cards/legacy.png'],
  });

  assert.equal(card.validateSync(), undefined);
  assert.equal(card.projectileRenderType, 'classic');
  assert.equal(card.explosionRenderType, 'classic');
  assert.equal(card.imagenesArma[0], '/uploads/cards/legacy.png');
});

test('animated projectile and explosion keep complete Flame metadata', () => {
  const sheet = (url, loop) => ({
    url,
    columns: 4,
    rows: 2,
    frames: 4,
    sourceWidth: 2021,
    sourceHeight: 128,
    frameWidth: 2021 / 4,
    frameHeight: 64,
    frameTime: 1 / 12,
    fps: 12,
    loop,
    multipleOrientations: true,
    readOrder: 'row-major',
    orientationRows: ['north', 'south'],
    frameOrder: [0, 1, 2, 3],
  });
  const card = new Card({
    titulo: 'Flame projectile',
    tipoArma: 'Proyectil',
    projectileRenderType: 'flame_spritesheet',
    explosionRenderType: 'flame_spritesheet',
    projectileSpritesheet: sheet('/uploads/cards/projectile.png', true),
    explosionSpritesheet: sheet('/uploads/cards/explosion.png', false),
  });

  assert.equal(card.validateSync(), undefined);
  assert.equal(card.projectileSpritesheet.columns, 4);
  assert.equal(card.projectileSpritesheet.frameWidth, 505.25);
  assert.equal(card.projectileSpritesheet.loop, true);
  assert.equal(card.explosionSpritesheet.loop, false);
  assert.deepEqual(card.projectileSpritesheet.frameOrder, [0, 1, 2, 3]);
});
