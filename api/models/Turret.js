const mongoose = require('mongoose');
const spritesheetSchema = require('./spritesheetSchema');

const turretSchema = new mongoose.Schema({
  ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  cardId: { type: mongoose.Schema.Types.ObjectId, ref: 'Card', required: true },
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  zoneId: { type: String, required: true, index: true },
  vida: { type: Number, required: true },
  vidaMaxima: { type: Number, required: true },
  alcance: { type: Number, required: true },
  dano: { type: Number, required: true },
  cadenciaDisparo: { type: Number, required: true },
  premioBaja: { type: Number, default: 100 },
  nextShotAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true, index: true },
  imagenesMovimiento: [String],
  imagenesDisparo: [String],
  imagenesMuerte: [String],
  renderType: {
    type: String,
    enum: ['classic', 'flame_spritesheet'],
    default: 'classic',
  },
  idleSpritesheet: spritesheetSchema,
  deathSpritesheet: spritesheetSchema,
}, { timestamps: true });

module.exports = mongoose.model('Turret', turretSchema);
