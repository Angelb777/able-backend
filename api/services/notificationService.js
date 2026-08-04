const Notification = require('../models/Notification');
const socialRealtime = require('./socialRealtime');

async function createNotification({ userId, type, title = '', message, data = {}, dedupeKey }) {
  try {
    const notification = await Notification.create({
      userId,
      type,
      title,
      message,
      data,
      dedupeKey,
    });
    const payload = notification.toObject();
    socialRealtime.emitToUser(userId, 'notification:new', payload);
    return payload;
  } catch (error) {
    if (error?.code === 11000 && dedupeKey) {
      return Notification.findOne({ dedupeKey }).lean();
    }
    throw error;
  }
}

module.exports = { createNotification };
