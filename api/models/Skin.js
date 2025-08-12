const mongoose = require("mongoose");

const skinSchema = new mongoose.Schema({
  titulo: { type: String, required: true },
  descripcion: { type: String, required: true },
  portada: { type: String, required: true },
  scripts: {
    muriendo: [String],
    moviendose: [String],
    parado: [String],
    disparando: [String],
    rapido: [String],
  },
  precio: { type: Number, required: true },
  fechaCreacion: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Skin", skinSchema);
