const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');

const {
  createSocketHandshakeLimiter,
} = require('../api/middlewares/securityLimits');

function waitForConnection(client) {
  return new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('connect_error', reject);
  });
}

function waitForConnectionError(client) {
  return new Promise((resolve, reject) => {
    client.once('connect_error', resolve);
    client.once('connect', () => reject(new Error('La conexion debia limitarse')));
  });
}

test('el limitador nativo permite el handshake y conserva el limite por IP', async () => {
  const httpServer = http.createServer();
  const socketServer = new Server(httpServer, {
    transports: ['websocket'],
  });
  socketServer.engine.use(createSocketHandshakeLimiter({
    windowMs: 60_000,
    limit: 1,
  }));

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  const url = `http://127.0.0.1:${port}`;

  const first = createClient(url, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 2_000,
  });
  await waitForConnection(first);
  assert.equal(first.connected, true);
  first.close();

  const second = createClient(url, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 2_000,
  });
  const error = await waitForConnectionError(second);
  assert.match(error.message, /websocket error/i);
  second.close();

  await new Promise((resolve) => socketServer.close(resolve));
});
