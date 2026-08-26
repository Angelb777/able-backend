const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  nombre: { type: String, required: true },
  // Importe monetario del pago. El ticket medio se calcula por transaccion.
  cantidad: { type: Number, required: true, min: 0.01 },
  motivo: { type: String, maxlength: 240, default: '' },
  currency: { type: String, enum: ['EUR', 'USD'], default: 'EUR' },
  fecha: { type: Date, default: Date.now }, // ⬅️ esto genera una fecha válida
  verified: { type: Boolean, default: false },
  verifiedAt: { type: Date },
  source: {
    type: String,
    enum: ['admin_manual', 'payment_provider', 'platform_checkout'],
  },
  providerReference: { type: String, trim: true, unique: true, sparse: true },
  commercialRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'CommercialRequest', index: true },
});

module.exports = mongoose.model("Payment", paymentSchema);
