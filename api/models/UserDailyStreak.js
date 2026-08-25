const mongoose = require('mongoose');

const pendingRewardSchema = new mongoose.Schema({
  key: { type: String, required: true },
  milestone: { type: Number, required: true, min: 7 },
  streakStartedDay: { type: String, required: true },
}, { _id: false });

const userDailyStreakSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },
  currentStreak: { type: Number, default: 0, min: 0 },
  lastActiveDay: { type: String, default: '' },
  streakStartedDay: { type: String, default: '' },
  lastPopupDay: { type: String, default: '' },
  pendingRewards: { type: [pendingRewardSchema], default: [] },
}, { timestamps: true });

module.exports = mongoose.model('UserDailyStreak', userDailyStreakSchema);
