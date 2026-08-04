const { EventEmitter } = require('events');

const socketsByUserId = new Map();
const events = new EventEmitter();
events.setMaxListeners(20);

function register(userId, socket) {
  const key = String(userId);
  if (!socketsByUserId.has(key)) socketsByUserId.set(key, new Set());
  socketsByUserId.get(key).add(socket);
}

function unregister(userId, socket) {
  const key = String(userId);
  const sockets = socketsByUserId.get(key);
  if (!sockets) return;
  sockets.delete(socket);
  if (sockets.size === 0) socketsByUserId.delete(key);
}

function emitToUser(userId, event, payload) {
  const sockets = socketsByUserId.get(String(userId));
  if (!sockets?.size) return 0;
  let delivered = 0;
  for (const socket of sockets) {
    if (!socket.connected) continue;
    socket.emit(event, payload);
    delivered += 1;
  }
  return delivered;
}

function isOnline(userId) {
  return [...(socketsByUserId.get(String(userId)) || [])]
    .some((socket) => socket.connected);
}

function broadcast(event, payload) {
  let delivered = 0;
  const seen = new Set();
  for (const sockets of socketsByUserId.values()) {
    for (const socket of sockets) {
      if (!socket.connected || seen.has(socket.id)) continue;
      seen.add(socket.id);
      socket.emit(event, payload);
      delivered += 1;
    }
  }
  return delivered;
}

function nicknameChanged(userId, nickname) {
  events.emit('nickname-changed', { userId: String(userId), nickname: String(nickname) });
}

module.exports = { register, unregister, emitToUser, isOnline, broadcast, nicknameChanged, events };
