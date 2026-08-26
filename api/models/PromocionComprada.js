const mongoose = require("mongoose");

const promocionCompradaSchema = new mongoose.Schema({
  comercioId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  promoId: { type: mongoose.Schema.Types.ObjectId, ref: "PromocionNegocio" },
  establishmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Establishment" },
  mapPlanId: { type: mongoose.Schema.Types.ObjectId, ref: "MapPlan" },
  planCode: { type: String, trim: true },

  titulo: String,               // caché por si luego se borra la base
  imagenBase: String,           // PNG del admin
  logoComercio: String,         // ruta al logo subido por el comercio
  publicName: String,
  address: String,
  description: String,
  proximityMessage: String,
  proximityRadiusMeters: { type: Number, min: 25, max: 5000, default: 250 },

  lat: Number,
  lng: Number,

  duracionMeses: Number,
  precioEuros: Number,

  fechaInicio: { type: Date, default: Date.now },
  fechaFin: { type: Date, required: true },

  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "Payment" },
  autoRenew: { type: Boolean, default: false },
  cancelAtPeriodEnd: { type: Boolean, default: false },
  stoppedAt: Date,
  promotionCode: { type: String, trim: true },
  checkoutReference: { type: String, trim: true, index: true },
  originalPriceEuros: Number,

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

promocionCompradaSchema.index({ comercioId: 1, establishmentId: 1, updatedAt: -1 });
promocionCompradaSchema.index({ establishmentId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("PromocionComprada", promocionCompradaSchema);
