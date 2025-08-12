const mongoose = require("mongoose");

const candadoSchema = new mongoose.Schema({
  // Datos base
  nombre:       { type: String, required: true },
  mac:          { type: String, required: true, unique: true, index: true }, // único
  nombreBLE:    { type: String, required: true },
  password:     { type: String, required: true }, // clave BLE (4 dígitos)
  ubicacion:    { type: String },                 // nombre/lugar opcional

  // Propiedad
  creadoPor:    { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, // null = liberado
  fechaCreacion:{ type: Date, default: Date.now },

  // Última posición reportada
  lastLat:      { type: Number },
  lastLng:      { type: Number },
  lastSeenAt:   { type: Date },

  // Visibilidad en el mapa
  visibleEnMapa:{ type: Boolean, default: false },

  // Gestión de liberado (opcional)
  releasedAt:   { type: Date }
});

// Normaliza MAC (mayúsculas)
candadoSchema.pre("save", function(next) {
  if (this.mac && typeof this.mac === "string") {
    this.mac = this.mac.toUpperCase();
  }
  next();
});

module.exports = mongoose.model("Candado", candadoSchema);
