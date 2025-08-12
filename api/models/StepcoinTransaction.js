const mongoose = require("mongoose");

const stepcoinTransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  cantidad: { type: Number, required: true }, // positivo o negativo
  tipo: {
    type: String,
    enum: ["canje", "recompensa", "compra", "admin", "ruleta", "muerte"],
    required: true
  },
  descripcion: { type: String },
  fecha: { type: Date, default: Date.now }
});

module.exports = mongoose.model("StepcoinTransaction", stepcoinTransactionSchema);
