const mongoose = require("mongoose");

const spritesheetSchema = new mongoose.Schema({
  url: { type: String, required: true },
  columns: { type: Number, required: true, min: 1 },
  rows: { type: Number, required: true, min: 1 },
  frames: { type: Number, required: true, min: 1 },
  sourceWidth: { type: Number, min: 1 },
  sourceHeight: { type: Number, min: 1 },
  frameWidth: { type: Number, min: 1 },
  frameHeight: { type: Number, min: 1 },
  frameTime: { type: Number, required: true, min: 0.001 },
  fps: { type: Number, min: 0.001 },
  loop: { type: Boolean, default: true },
  multipleOrientations: { type: Boolean, default: false },
  readOrder: {
    type: String,
    enum: ["row-major", "row-major-reverse", "column-major"],
    default: "row-major"
  },
  orientationRows: [{ type: String }],
  frameOrder: [{ type: Number, min: 0 }]
}, { _id: false });

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
