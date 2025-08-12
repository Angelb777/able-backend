const mongoose = require('mongoose');

const userLifeSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    unique: true,
    required: true
  },
  vida: {
    type: Number,
    default: 1000
  },
  yaPenalizado: {
    type: Boolean,
    default: false // ✅ Se marca en true al morir y se resetea al revivir
  }
});

module.exports = mongoose.model('UserLife', userLifeSchema);
