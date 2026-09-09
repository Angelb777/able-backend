const mongoose = require('mongoose');

const mapPlanSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, trim: true, uppercase: true },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, trim: true, maxlength: 500, default: '' },
  durationMonths: { type: Number, required: true, min: 1, max: 120 },
  // Campo legado para leer planes anteriores. Las nuevas contrataciones de
  // presencia de locales usan exclusivamente Stepcoins.
  priceEuros: { type: Number, min: 0 },
  priceStepcoins: { type: Number, required: true, min: 0 },
  referencePriceEuros: { type: Number, required: true, min: 0 },
  active: { type: Boolean, default: true, index: true },
  sortOrder: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('MapPlan', mapPlanSchema);
