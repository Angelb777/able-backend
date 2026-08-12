const test = require('node:test');
const assert = require('node:assert/strict');
const Skin = require('../api/models/Skin');

const animation = (url, columns, frames) => ({
  url,
  columns,
  rows: 5,
  frames,
  sourceWidth: columns * 460,
  sourceHeight: 2300,
  frameWidth: 460,
  frameHeight: 460,
  frameTime: 0.125,
  fps: 8,
  loop: true,
  multipleOrientations: true,
  readOrder: 'row-major',
  orientationRows: ['south', 'southWest', 'west', 'northWest', 'north']
});

test('legacy skins remain valid and default to the classic renderer', () => {
  const skin = new Skin({
    titulo: 'Legacy',
    descripcion: 'Existing skin',
    portada: '/uploads/skins/cover.png',
    precio: 100,
    scripts: { parado: ['/uploads/skins/idle-frame.png'] }
  });

  assert.equal(skin.validateSync(), undefined);
  assert.equal(skin.renderType, 'classic');
  assert.deepEqual(skin.scripts.parado, ['/uploads/skins/idle-frame.png']);
});

test('an animated skin accepts a different grid for every action', () => {
  const skin = new Skin({
    titulo: 'Character 0',
    descripcion: 'Flame spritesheets',
    portada: '/uploads/skins/cover.png',
    precio: 500,
    renderType: 'flame_spritesheet',
    renderVersion: 2,
    spritesheets: {
      idle: animation('/idle.png', 8, 8),
      walk: animation('/walk.png', 6, 6),
      shoot: { ...animation('/shoot.png', 6, 6), loop: false },
      die: { ...animation('/die.png', 6, 6), loop: false },
      cycling: animation('/cycling.png', 8, 8),
      damage: { ...animation('/damage.png', 2, 2), loop: false },
      getUp: { ...animation('/get-up.png', 4, 4), loop: false }
    }
  });

  assert.equal(skin.validateSync(), undefined);
  assert.equal(skin.spritesheets.idle.columns, 8);
  assert.equal(skin.spritesheets.damage.columns, 2);
  assert.equal(skin.spritesheets.cycling.url, '/cycling.png');
  assert.equal(skin.spritesheets.run, undefined);
});

test('classic skins persist the optional bicycle script', () => {
  const skin = new Skin({
    titulo: 'Classic cyclist',
    descripcion: 'Classic bicycle sprite',
    portada: '/uploads/skins/cover.png',
    precio: 100,
    scripts: {
      parado: ['/uploads/skins/idle-frame.png'],
      bicicleta: ['/uploads/skins/bicycle-frame.png']
    }
  });

  assert.equal(skin.validateSync(), undefined);
  assert.deepEqual(
    skin.scripts.bicicleta,
    ['/uploads/skins/bicycle-frame.png']
  );
});

test('invalid spritesheet grids are rejected without touching legacy fields', () => {
  const skin = new Skin({
    titulo: 'Invalid',
    descripcion: 'Invalid grid',
    portada: '/cover.png',
    precio: 1,
    renderType: 'flame_spritesheet',
    scripts: { parado: ['/legacy.png'] },
    spritesheets: { idle: animation('/idle.png', 0, 1) }
  });

  assert.ok(skin.validateSync());
  assert.deepEqual(skin.scripts.parado, ['/legacy.png']);
});
