const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const Skin = require('../api/models/Skin');
const mediaStorage = require('../api/utils/mediaStorage');

function png(name) {
  const bytes = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  bytes.writeUInt32BE(8, 16);
  bytes.writeUInt32BE(8, 20);
  return new Blob([bytes], { type: 'image/png' });
}

function animationConfig() {
  return JSON.stringify({
    columns: 1,
    rows: 1,
    frames: 1,
    fps: 8,
    loop: true
  });
}

test('skin create and edit endpoints accept cycling and bicicleta uploads', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  const originalSaveImage = mediaStorage.saveImage;
  const originalSave = Skin.prototype.save;
  const originalFindById = Skin.findById;
  process.env.JWT_SECRET = 'skin-cycling-route-test-secret';

  let savedSkin;
  mediaStorage.saveImage = async (file) => `/uploads/skins/${file.originalname}`;
  Skin.prototype.save = async function save() {
    savedSkin = this;
    return this;
  };
  Skin.findById = async () => savedSkin;

  delete require.cache[require.resolve('../api/routes/skins')];
  const skinsRouter = require('../api/routes/skins');
  const app = express();
  app.use('/api/skins', skinsRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const token = jwt.sign(
    { id: '507f1f77bcf86cd799439011', role: 'admin' },
    process.env.JWT_SECRET
  );

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    mediaStorage.saveImage = originalSaveImage;
    Skin.prototype.save = originalSave;
    Skin.findById = originalFindById;
    delete require.cache[require.resolve('../api/routes/skins')];
    if (previousSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  const createBody = new FormData();
  createBody.set('titulo', 'Cyclist');
  createBody.set('descripcion', 'Cycling skin');
  createBody.set('precio', '100');
  createBody.set('renderType', 'flame_spritesheet');
  createBody.set('portada', png(), 'cover.png');
  createBody.set('idle', png(), 'idle.png');
  createBody.set('config_idle', animationConfig());
  createBody.set('cycling', png(), 'cycling.png');
  createBody.set('config_cycling', animationConfig());

  const created = await fetch(`${baseUrl}/api/skins`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: createBody
  });
  assert.equal(created.status, 201);
  const createdPayload = await created.json();
  assert.deepEqual(createdPayload.skin.scripts.bicicleta, [
    '/uploads/skins/cycling.png'
  ]);
  assert.equal(
    createdPayload.skin.spritesheets.cycling.url,
    '/uploads/skins/cycling.png'
  );

  const editBody = new FormData();
  editBody.set('renderType', 'flame_spritesheet');
  editBody.set('bicicleta', png(), 'bicycle-updated.png');
  editBody.set('config_cycling', animationConfig());

  const edited = await fetch(`${baseUrl}/api/skins/skin-id`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: editBody
  });
  assert.equal(edited.status, 200);
  const editedPayload = await edited.json();
  assert.deepEqual(editedPayload.skin.scripts.bicicleta, [
    '/uploads/skins/bicycle-updated.png'
  ]);
  assert.equal(
    editedPayload.skin.spritesheets.cycling.url,
    '/uploads/skins/bicycle-updated.png'
  );
});
