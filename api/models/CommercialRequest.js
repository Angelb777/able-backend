const mongoose = require('mongoose');

const materialSchema = new mongoose.Schema({
  url: { type: String, required: true },
  originalName: { type: String, maxlength: 240, default: '' },
  mimeType: { type: String, maxlength: 120, default: '' },
  size: { type: Number, min: 0, default: 0 },
  label: { type: String, maxlength: 100, default: 'material' },
  uploadedAt: { type: Date, default: Date.now },
}, { _id: true });

const historySchema = new mongoose.Schema({
  action: { type: String, required: true },
  fromStatus: String,
  toStatus: String,
  notes: { type: String, maxlength: 2000, default: '' },
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  actorRole: String,
  at: { type: Date, default: Date.now },
}, { _id: false });

const commercialRequestSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  establishmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Establishment' },
  type: {
    type: String,
    enum: ['positioning', 'commercial_skin', 'commercial_weapon', 'reward'],
    required: true,
    index: true,
  },
  subtype: {
    type: String,
    enum: ['', 'short', 'medium', 'long', 'discount', 'prize'],
    default: '',
  },
  title: { type: String, trim: true, maxlength: 160, required: true },
  status: {
    type: String,
    enum: [
      'draft', 'pending_payment', 'pending_material', 'pending_review',
      'changes_requested', 'approved', 'rejected', 'published', 'disabled',
      'withdrawn', 'renewal_due', 'renewed', 'retired',
      'expired',
    ],
    default: 'pending_review',
    index: true,
  },
  price: { type: Number, min: 0, required: true },
  currency: { type: String, enum: ['EUR'], default: 'EUR' },
  paymentStatus: {
    type: String,
    enum: ['not_required', 'pending', 'confirmed', 'failed', 'refunded', 'waived'],
    default: 'pending',
    index: true,
  },
  paymentReference: { type: String, maxlength: 240, default: '' },
  paymentConfirmedAt: Date,
  formData: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  materials: { type: [materialSchema], default: [] },
  reviewNotes: { type: String, maxlength: 4000, default: '' },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
  approvedAt: Date,
  publishedAt: Date,
  reviewDueAt: Date,
  retiredAt: Date,
  targetModel: { type: String, enum: ['', 'PromocionComprada', 'Skin', 'Card', 'Reward'], default: '' },
  targetId: { type: mongoose.Schema.Types.ObjectId },
  legacySource: { type: String, maxlength: 100, default: '' },
  legacyId: { type: mongoose.Schema.Types.ObjectId },
  revision: { type: Number, min: 1, default: 1 },
  history: { type: [historySchema], default: [] },
}, { timestamps: true, optimisticConcurrency: true });

commercialRequestSchema.index({ ownerId: 1, createdAt: -1 });
commercialRequestSchema.index({ legacySource: 1, legacyId: 1 }, {
  unique: true,
  partialFilterExpression: { legacyId: { $type: 'objectId' } },
});
commercialRequestSchema.set('toJSON', {
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    if (ret.targetId) ret.targetId = String(ret.targetId);
    return ret;
  },
});

module.exports = mongoose.model('CommercialRequest', commercialRequestSchema);
