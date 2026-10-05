const mongoose = require('mongoose');

const mapPlanSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, trim: true, uppercase: true },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, trim: true, maxlength: 500, default: '' },
  durationMonths: { type: Number, required: true, min: 1, max: 120 },
  priceEuros: { type: Number, required: true, min: 0 },
  priceCents: { type: Number, required: true, min: 1 },
  currency: { type: String, enum: ['EUR'], default: 'EUR' },
  recurringInterval: { type: String, enum: ['month', 'year'], required: true },
  recurringIntervalCount: { type: Number, min: 1, max: 12, default: 1 },
  // Campos antiguos conservados solo para poder leer documentos previos.
  priceStepcoins: { type: Number, min: 0 },
  referencePriceEuros: { type: Number, min: 0 },
  active: { type: Boolean, default: true, index: true },
  sortOrder: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('MapPlan', mapPlanSchema);
