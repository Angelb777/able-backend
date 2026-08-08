const mongoose = require("mongoose");

// Shared Flame spritesheet metadata used by skins, cards and persisted entities.
module.exports = new mongoose.Schema({
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
