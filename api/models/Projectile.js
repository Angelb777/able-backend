const mongoose = require("mongoose");

const projectileSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  cartaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Card",
    required: true,
  },
  origen: {
    lat: Number,
    lng: Number,
  },
  destino: {
    lat: Number,
    lng: Number,
  },
  creadoEn: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("Projectile", projectileSchema);
