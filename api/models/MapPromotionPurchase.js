const mongoose = require('mongoose');

const mapPromotionPurchaseSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  establishmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Establishment',
    required: true,
    index: true,
  },
  mapSubscriptionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PromocionComprada',
    index: true,
  },
  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', index: true },
  provider: { type: String, enum: ['app_store', 'google_play'], required: true },
  providerReference: { type: String, required: true, unique: true, trim: true },
  productId: { type: String, required: true, trim: true },
  transactionId: { type: String, trim: true },
  purchaseToken: { type: String, trim: true, select: false },
  environment: { type: String, trim: true },
  planCode: { type: String, required: true, trim: true },
  durationDays: { type: Number, required: true, min: 1 },
  entitlementStart: { type: Date, required: true },
  entitlementEnd: { type: Date, required: true },
  promotionCode: { type: String, trim: true },
  status: {
    type: String,
    enum: ['confirmed', 'refunded', 'revoked'],
    default: 'confirmed',
    index: true,
  },
  revokedAt: Date,
  revocationReason: { type: String, trim: true, maxlength: 240 },
}, { timestamps: true });

mapPromotionPurchaseSchema.index({ establishmentId: 1, createdAt: 1 });

module.exports = mongoose.model('MapPromotionPurchase', mapPromotionPurchaseSchema);
