const mongoose = require('mongoose');

const redemptionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  establishmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Establishment', required: true },
  redeemedAt: { type: Date, default: Date.now },
}, { _id: false });

const mapPromoCodeSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, trim: true, uppercase: true },
  description: { type: String, trim: true, maxlength: 300, default: '' },
  discountPercent: { type: Number, min: 0, max: 100, default: 0 },
  freeMonths: { type: Number, min: 0, max: 120, default: 0 },
  active: { type: Boolean, default: true, index: true },
  validFrom: Date,
  validUntil: Date,
  maxRedemptions: { type: Number, min: 1 },
  redemptions: { type: [redemptionSchema], default: [] },
}, { timestamps: true });

module.exports = mongoose.model('MapPromoCode', mapPromoCodeSchema);
