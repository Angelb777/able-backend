const mongoose = require('mongoose');

const establishmentSchema = new mongoose.Schema({
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true,
  },
  legalName: { type: String, trim: true, maxlength: 160, default: '' },
  publicName: { type: String, trim: true, maxlength: 100, required: true },
  description: { type: String, trim: true, maxlength: 1200, default: '' },
  address: { type: String, trim: true, maxlength: 240, required: true },
  city: { type: String, trim: true, maxlength: 100, default: '' },
  country: { type: String, trim: true, maxlength: 100, default: '' },
  phone: { type: String, trim: true, maxlength: 40, default: '' },
  website: { type: String, trim: true, maxlength: 300, default: '' },
  logoUrl: { type: String, default: '' },
  lat: { type: Number, min: -90, max: 90, required: true },
  lng: { type: Number, min: -180, max: 180, required: true },
  status: {
    type: String,
    enum: ['draft', 'pending_review', 'changes_requested', 'approved', 'rejected', 'disabled'],
    default: 'pending_review',
    index: true,
  },
  reviewNotes: { type: String, maxlength: 2000, default: '' },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
  approvedAt: Date,
  disabledAt: Date,
}, { timestamps: true });

establishmentSchema.set('toJSON', {
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    return ret;
  },
});

module.exports = mongoose.model('Establishment', establishmentSchema);
