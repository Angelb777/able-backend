const mongoose = require("mongoose");

const stepcoinTransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  cantidad: { type: Number, required: true }, // positivo o negativo
  tipo: {
    type: String,
    enum: ["canje", "recompensa", "compra", "admin", "ruleta", "racha", "muerte", "burla", "reembolso_burla", "recompensa_pvp", "devolucion_recompensa", "cobro_recompensa", "duelo_apuesta", "duelo_bote", "reembolso_duelo"],
    required: true
  },
  descripcion: { type: String },
  fecha: { type: Date, default: Date.now },
  operationKey: { type: String, trim: true, maxlength: 200 },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
});

stepcoinTransactionSchema.index(
  { operationKey: 1 },
  { unique: true, partialFilterExpression: { operationKey: { $type: "string" } } }
);
stepcoinTransactionSchema.index({ userId: 1, fecha: -1 });

module.exports = mongoose.model("StepcoinTransaction", stepcoinTransactionSchema);
