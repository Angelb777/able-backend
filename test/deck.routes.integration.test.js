const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const User = require('../api/models/User');
const cardsRouter = require('../api/routes/cards');

test('deck route accepts between one and four owned cards', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  const originalFindById = User.findById;
  const originalFindOneAndUpdate = User.findOneAndUpdate;
  process.env.JWT_SECRET = 'deck-route-test-secret';

  const userId = '507f1f77bcf86cd799439011';
  const cardIds = [
    '507f1f77bcf86cd799439021',
    '507f1f77bcf86cd799439022',
    '507f1f77bcf86cd799439023',
    '507f1f77bcf86cd799439024',
    '507f1f77bcf86cd799439025',
  ];
  const token = jwt.sign({ id: userId, role: 'cliente' }, process.env.JWT_SECRET);
  let savedDeck;

  User.findById = (id) => ({
    select() { return this; },
    lean: async () => ({ _id: id, role: 'cliente' }),
  });
  User.findOneAndUpdate = (query, update) => {
    savedDeck = update.mazo;
    return {
      populate: async () => ({
        _id: query._id,
        mazo: update.mazo.map((id) => ({ _id: id, titulo: `Carta ${id}` })),
      }),
    };
  };

  const app = express();
  app.use(express.json());
  app.use('/api/cards', cardsRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    if (previousSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    User.findById = originalFindById;
    User.findOneAndUpdate = originalFindOneAndUpdate;
    await new Promise((resolve) => server.close(resolve));
  });

  const saveDeck = (mazo) => fetch(`${baseUrl}/api/cards/user-cards/${userId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ mazo }),
  });

  const partialResponse = await saveDeck(cardIds.slice(0, 3));
  assert.equal(partialResponse.status, 200);
  assert.deepEqual(savedDeck, cardIds.slice(0, 3));
  assert.equal((await partialResponse.json()).mazo.length, 3);

  assert.equal((await saveDeck([])).status, 400);
  assert.equal((await saveDeck(cardIds)).status, 400);
});
