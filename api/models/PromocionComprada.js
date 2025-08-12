const mongoose = require("mongoose");

const promocionCompradaSchema = new mongoose.Schema({
  comercioId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  promoId: { type: mongoose.Schema.Types.ObjectId, ref: "PromocionNegocio", required: true },

  titulo: String,               // caché por si luego se borra la base
  imagenBase: String,           // PNG del admin
  logoComercio: String,         // ruta al logo subido por el comercio

  lat: Number,
  lng: Number,

  duracionMeses: Number,
  precioEuros: Number,

  fechaInicio: { type: Date, default: Date.now },
  fechaFin: { type: Date, required: true },

  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "Payment" },

  activo: { type: Boolean, default: true }, // por si quieres desactivarla manualmente
}, { timestamps: true });

module.exports = mongoose.model("PromocionComprada", promocionCompradaSchema);
