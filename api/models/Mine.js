const mongoose = require('mongoose');

const mineSchema = new mongoose.Schema({
  ownerUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  cardId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Card',
    required: true,
  },
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  zoneId: { type: String, required: true, index: true },
  radioActivacion: { type: Number, required: true },
  dano: { type: Number, required: true },
  usoUnico: { type: Boolean, default: true },
  expiresAt: { type: Date, required: true, index: true },
  imagenPortada: { type: String, default: '' },
  imagenesActivacion: [String],
  imagenesExplosion: [String],
}, { timestamps: true });

module.exports = mongoose.model('Mine', mineSchema);
