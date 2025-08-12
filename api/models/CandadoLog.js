const mongoose = require("mongoose");

const candadoLogSchema = new mongoose.Schema({
  candadoId: { type: mongoose.Schema.Types.ObjectId, ref: "Candado", required: true },
  usuarioId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

  // Acción: 'abrir', 'cerrar', 'conectar', 'desconectar', 'liberar', 'posicion'
  accion:     { type: String, required: true },

  // Datos extra
  detalle:    { type: String },

  // Ubicación opcional
  lat:        { type: Number },
  lng:        { type: Number },

  createdAt:  { type: Date, default: Date.now }
});

candadoLogSchema.index({ candadoId: 1, createdAt: -1 });
candadoLogSchema.index({ usuarioId: 1, createdAt: -1 });

module.exports = mongoose.model("CandadoLog", candadoLogSchema);
