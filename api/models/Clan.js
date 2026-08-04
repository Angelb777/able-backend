const mongoose = require('mongoose');

const memberSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  joinedAt: { type: Date, default: Date.now, required: true },
}, { _id: false });

const invitationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  invitedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'rejected', 'cancelled', 'invalidated'],
    default: 'pending',
  },
  createdAt: { type: Date, default: Date.now },
  respondedAt: Date,
}, { _id: true });

const joinRequestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'rejected', 'cancelled', 'invalidated'],
    default: 'pending',
  },
  createdAt: { type: Date, default: Date.now },
  respondedAt: Date,
}, { _id: true });

const clanSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, minlength: 3, maxlength: 48 },
  normalizedName: { type: String, required: true, trim: true, maxlength: 48 },
  description: { type: String, default: '', trim: true, maxlength: 500 },
  imageUrl: { type: String, default: '', trim: true, maxlength: 1000 },
  creatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  members: { type: [memberSchema], default: [] },
  pendingInvitations: { type: [invitationSchema], default: [] },
  pendingJoinRequests: { type: [joinRequestSchema], default: [] },
  visibility: { type: String, enum: ['public', 'private'], default: 'public', index: true },
  status: { type: String, enum: ['active', 'deleted'], default: 'active', index: true },
  deletedAt: Date,
}, { timestamps: true });

clanSchema.index({ 'members.userId': 1, status: 1 });
clanSchema.index({ 'pendingInvitations.userId': 1, status: 1 });
clanSchema.index({ 'pendingJoinRequests.userId': 1, status: 1 });
clanSchema.index({ status: 1, visibility: 1, normalizedName: 1 });

module.exports = mongoose.model('Clan', clanSchema);
