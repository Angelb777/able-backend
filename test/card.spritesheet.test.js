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

test('legacy turret cards remain classic without requiring spritesheets', () => {
  const card = new Card({
    titulo: 'Legacy turret',
    tipoArma: 'Arrastre',
    imagenPortada: '/uploads/cards/turret-cover.png',
    imagenesMovimiento: ['/uploads/cards/turret.png'],
  });

  assert.equal(card.validateSync(), undefined);
  assert.equal(card.turretRenderType, 'classic');
  assert.equal(card.turretIdleSpritesheet, undefined);
  assert.equal(card.turretDeathSpritesheet, undefined);
  assert.equal(card.imagenesMovimiento[0], '/uploads/cards/turret.png');
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

test('animated turret keeps Idle and Death Flame metadata with safe loop defaults', () => {
  const card = new Card({
    titulo: 'Flame turret',
    tipoArma: 'Arrastre',
    turretRenderType: 'flame_spritesheet',
    turretIdleSpritesheet: {
      url: '/uploads/cards/turret-idle.png',
      columns: 4,
      rows: 2,
      frames: 8,
      frameTime: 1 / 12,
      fps: 12,
      readOrder: 'row-major',
    },
    turretDeathSpritesheet: {
      url: '/uploads/cards/turret-death.png',
      columns: 5,
      rows: 1,
      frames: 5,
      frameTime: 0.1,
      fps: 10,
      loop: false,
      readOrder: 'row-major-reverse',
    },
  });

  assert.equal(card.validateSync(), undefined);
  assert.equal(card.turretIdleSpritesheet.loop, true);
  assert.equal(card.turretDeathSpritesheet.loop, false);
  assert.equal(card.turretIdleSpritesheet.frames, 8);
  assert.equal(card.turretDeathSpritesheet.readOrder, 'row-major-reverse');
});
