const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  nombre: { type: String, required: true },
  cantidad: { type: Number, required: true },
  fecha: { type: Date, default: Date.now }, // ⬅️ esto genera una fecha válida
});

module.exports = mongoose.model("Payment", paymentSchema);
