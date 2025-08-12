const mongoose = require('mongoose');

const UfoSchema = new mongoose.Schema({
  nombre: String,
  imagenOvni: String,
  vida: Number,
  imagenBala: String,
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
