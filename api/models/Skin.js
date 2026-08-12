const mongoose = require("mongoose");
const spritesheetSchema = require("./spritesheetSchema");

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
    bicicleta: [String],
    recibiendoDano: [String],
    reapareciendo: [String],
  },
  renderType: {
    type: String,
    enum: ["classic", "flame_spritesheet"],
    default: "classic"
  },
  renderVersion: { type: Number, default: 1 },
  spritesheets: {
    idle: spritesheetSchema,
    walk: spritesheetSchema,
    shoot: spritesheetSchema,
    die: spritesheetSchema,
    run: spritesheetSchema,
    cycling: spritesheetSchema,
    damage: spritesheetSchema,
    getUp: spritesheetSchema
  },
  precio: { type: Number, required: true },
  validada: { type: Boolean, default: false },
  fechaCreacion: { type: Date, default: Date.now },
  commercialRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "CommercialRequest", index: true },
  commercialOwnerId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  isCommercial: { type: Boolean, default: false },
  publishedAt: Date,
  reviewDueAt: Date,
  retiredAt: Date
});

module.exports = mongoose.model("Skin", skinSchema);
