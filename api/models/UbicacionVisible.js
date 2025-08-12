// models/UbicacionVisible.js
const mongoose = require("mongoose");

const ubicacionVisibleSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  actualizadoEn: { type: Date, default: Date.now }
});

module.exports = mongoose.model("UbicacionVisible", ubicacionVisibleSchema);
