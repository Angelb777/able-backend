// models/PromocionNegocio.js
const mongoose = require("mongoose");

const promocionNegocioSchema = new mongoose.Schema({
  titulo: { type: String, required: true },
  descripcion: String,
  imagen: { type: String, required: true }, // PNG del diseño base
  opcionesDuracion: [
    {
      duracionMeses: Number, // ej: 1, 3, 12
      precioEuros: Number    // ej: 10, 20, 50
    }
  ],
  fechaExpiracionMaxima: Date, // Hasta cuándo puede contratarse
  creadoEn: { type: Date, default: Date.now }
});

module.exports = mongoose.model("PromocionNegocio", promocionNegocioSchema);
