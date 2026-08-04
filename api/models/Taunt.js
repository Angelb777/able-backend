const mongoose = require('mongoose');

const tauntSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, trim: true, maxlength: 64 },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  imageUrl: { type: String, default: '', trim: true, maxlength: 1000 },
  animationUrl: { type: String, default: '', trim: true, maxlength: 1000 },
  price: { type: Number, required: true, min: 0 },
  durationMs: { type: Number, default: 3000, min: 500, max: 10000 },
  active: { type: Boolean, default: true, index: true },
}, { timestamps: true });

module.exports = mongoose.model('Taunt', tauntSchema);
