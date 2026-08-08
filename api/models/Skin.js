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
    damage: spritesheetSchema,
    getUp: spritesheetSchema
  },
  precio: { type: Number, required: true },
  validada: { type: Boolean, default: false },
  fechaCreacion: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Skin", skinSchema);
