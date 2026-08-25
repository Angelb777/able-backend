const mongoose = require('mongoose');

const userActivityDaySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  day: {
    type: String,
    required: true,
    match: /^\d{4}-\d{2}-\d{2}$/,
  },
}, { versionKey: false });

userActivityDaySchema.index(
  { userId: 1, day: 1 },
  { unique: true, name: 'user_activity_day_unique' }
);
userActivityDaySchema.index({ day: 1, userId: 1 }, { name: 'activity_period_users' });

module.exports = mongoose.model('UserActivityDay', userActivityDaySchema);
