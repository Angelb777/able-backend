const mongoose = require("mongoose");

const MobilitySnapshotSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model("MobilitySnapshot", MobilitySnapshotSchema);
