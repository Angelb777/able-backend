const mongoose = require('mongoose');

const uberConnectionSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true,
  },
  accessTokenEncrypted: { type: String, required: true, select: false },
  refreshTokenEncrypted: { type: String, default: '', select: false },
  accessTokenExpiresAt: { type: Date, required: true },
  scopes: { type: [String], default: [] },
  currentRequestId: { type: String, default: '' },
  connectedAt: { type: Date, default: Date.now },
  lastRefreshAt: { type: Date },
}, { timestamps: true });

module.exports = mongoose.model('UberConnection', uberConnectionSchema);
