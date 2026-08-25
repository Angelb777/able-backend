const mongoose = require('mongoose');
const spritesheetSchema = require('./spritesheetSchema');

const UfoSchema = new mongoose.Schema({
  nombre: String,
  imagenOvni: String,
  ufoRenderType: {
    type: String,
    enum: ['classic', 'flame_spritesheet'],
    default: 'classic'
  },
  ufoSpritesheet: spritesheetSchema,
  vida: Number,
  imagenBala: String,
  bulletRenderType: {
    type: String,
    enum: ['classic', 'flame_spritesheet'],
    default: 'classic'
  },
  bulletSpritesheet: spritesheetSchema,
  velocidadBala: Number,
  velocidadMovimiento: Number,
  tiempoAparicion: Number,
  duracionPantalla: Number,

  // 🔥 Nuevos campos
  stepcoinsPremio: {
    type: Number,
    default: 0
  },
  segundosEntreDisparos: {
    type: Number,
    default: 3
  },
  danoBala: {
    type: Number,
    default: 50
  }

}, {
  timestamps: true   // ✅ Esto añade createdAt y updatedAt automáticamente
});

module.exports = mongoose.model('Ufo', UfoSchema);
