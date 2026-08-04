const mongoose = require('mongoose');

const bountySchema = new mongoose.Schema({
  targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  amount: { type: Number, required: true, min: 1 },
  status: {
    type: String,
    enum: ['active', 'claimed', 'expired', 'cancelled'],
    default: 'active',
    index: true,
  },
  expiresAt: { type: Date, required: true, index: true },
  claimedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  claimedAt: Date,
  killEventId: { type: String, trim: true },
  creationKey: { type: String, required: true, trim: true },
  refundedAt: Date,
}, { timestamps: true });

bountySchema.index({ createdByUserId: 1, creationKey: 1 }, { unique: true });
bountySchema.index({ targetUserId: 1, status: 1, expiresAt: 1 });

module.exports = mongoose.model('Bounty', bountySchema);
