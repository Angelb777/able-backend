const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, required: true, trim: true, maxlength: 64 },
  title: { type: String, default: '', trim: true, maxlength: 120 },
  message: { type: String, required: true, trim: true, maxlength: 500 },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  dedupeKey: { type: String, trim: true, maxlength: 200 },
  readAt: Date,
}, { timestamps: true });

notificationSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } }
);
notificationSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
