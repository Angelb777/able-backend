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
  status: {
    type: String,
    enum: ["pending", "published", "disabled", "retired", "expired"],
    default: "pending"
  },
  paymentStatus: {
    type: String,
    enum: ["pending", "confirmed", "waived", "legacy_confirmed"],
    default: "pending"
  },
  commercialRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "CommercialRequest", index: true },
  approvedAt: Date,
  publishedAt: Date,
  retiredAt: Date,
}, { timestamps: true });

module.exports = mongoose.model("PromocionComprada", promocionCompradaSchema);
