const mongoose = require("mongoose");
const MobilitySnapshot = require("../models/MobilitySnapshot");

function createPersistentMobilityCache({
  model = MobilitySnapshot,
  connection = mongoose.connection,
  now = () => Date.now(),
} = {}) {
  function available() {
    return connection?.readyState === 1;
  }

  async function put(key, payload) {
    if (!available()) return false;
    await model.findOneAndUpdate(
      { key },
      { $set: { payload } },
      { upsert: true, setDefaultsOnInsert: true },
    );
    return true;
  }

  async function get(key, { maxAgeMs = Infinity } = {}) {
    if (!available()) return null;
    const snapshot = await model.findOne({ key }).lean();
    if (!snapshot?.payload || !snapshot.updatedAt) return null;
    const cachedAt = new Date(snapshot.updatedAt);
    if (
      Number.isFinite(maxAgeMs) &&
      now() - cachedAt.getTime() > maxAgeMs
    ) {
      return null;
    }
    return {
      ...snapshot.payload,
      fromCache: true,
      stale: true,
      persistentCache: true,
      cachedAt: cachedAt.toISOString(),
    };
  }

  return { get, put };
}

module.exports = { createPersistentMobilityCache };
