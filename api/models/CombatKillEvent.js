const mongoose = require('mongoose');

const combatKillEventSchema = new mongoose.Schema({
  killEventId: { type: String, required: true, unique: true, trim: true },
  attackerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  source: { type: String, required: true, trim: true },
  bountyPaid: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('CombatKillEvent', combatKillEventSchema);
