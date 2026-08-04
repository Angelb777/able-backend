const EventEmitter = require('events');
const Clan = require('../models/Clan');

const TTL_MS = 60 * 1000;
const cache = new Map();
const events = new EventEmitter();
events.setMaxListeners(50);

async function getClanIds(userId) {
  const key = String(userId);
  const current = cache.get(key);
  if (current && current.expiresAt > Date.now()) return current.ids;
  const rows = await Clan.find({
    status: 'active',
    'members.userId': userId,
  }).select('_id').lean();
  const ids = new Set(rows.map((row) => String(row._id)));
  cache.set(key, { ids, expiresAt: Date.now() + TTL_MS });
  return ids;
}

async function shareActiveClan(firstUserId, secondUserId) {
  if (!firstUserId || !secondUserId || String(firstUserId) === String(secondUserId)) {
    return false;
  }
  const [first, second] = await Promise.all([
    getClanIds(firstUserId),
    getClanIds(secondUserId),
  ]);
  const smaller = first.size <= second.size ? first : second;
  const larger = smaller === first ? second : first;
  for (const clanId of smaller) {
    if (larger.has(clanId)) return true;
  }
  return false;
}

function invalidate(userIds) {
  const unique = [...new Set((userIds || []).filter(Boolean).map(String))];
  for (const userId of unique) cache.delete(userId);
  if (unique.length) events.emit('invalidated', unique);
}

module.exports = { getClanIds, shareActiveClan, invalidate, events };
