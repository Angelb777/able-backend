const mongoose = require('mongoose');

const uberOAuthAttemptSchema = new mongoose.Schema({
  stateHash: { type: String, required: true, unique: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true });

module.exports = mongoose.model('UberOAuthAttempt', uberOAuthAttemptSchema);
