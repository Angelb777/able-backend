const mongoose = require('mongoose');

const streakRewardClaimSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  rewardKey: { type: String, required: true },
  milestone: { type: Number, required: true },
  rewardType: { type: String, enum: ['stepcoins', 'card'], required: true },
  cardId: { type: mongoose.Schema.Types.ObjectId, ref: 'Card' },
  status: { type: String, enum: ['processing', 'completed'], default: 'processing' },
}, { timestamps: true });

streakRewardClaimSchema.index(
  { userId: 1, rewardKey: 1 },
  { unique: true, name: 'streak_reward_claim_unique' }
);

module.exports = mongoose.model('StreakRewardClaim', streakRewardClaimSchema);
