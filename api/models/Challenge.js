const mongoose = require('mongoose');

const participanteSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  stepcoinsInicio: { type: Number, default: 0 },
  stepcoinsFinal: { type: Number, default: 0 },
  evidenciaUrl: { type: String },
  esGanador: { type: Boolean, default: false }
});

const challengeSchema = new mongoose.Schema({
  titulo: { type: String, required: true },
  descripcion: { type: String },
  premio: { type: String },
  imagenPremioUrl: { type: String },
  requisitosEspeciales: { type: String },
  fechaInicio: { type: Date, required: true },
  fechaFin: { type: Date, required: true },
  criterio: { type: String, enum: ['stepcoins'], default: 'stepcoins' },
  participantes: [participanteSchema],
  activo: { type: Boolean, default: true },
  creadoEn: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Challenge', challengeSchema);
