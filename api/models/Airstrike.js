const mongoose = require('mongoose');

const airstrikeSchema = new mongoose.Schema({
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
  radioExplosion: { type: Number, required: true },
  dano: { type: Number, required: true },
  attackAt: { type: Date, required: true, index: true },
  impactAt: { type: Date, required: true, index: true },
  launched: { type: Boolean, default: false },
  heading: { type: Number, required: true },
  imagenesAvion: [String],
  imagenesBomba: [String],
  imagenesExplosion: [String],
}, { timestamps: true });

module.exports = mongoose.model('Airstrike', airstrikeSchema);
