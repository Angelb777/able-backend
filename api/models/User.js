const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  nombre: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },

  role: {
    type: String,
    enum: ['cliente', 'comercio', 'admin'],
    required: true
  },

  stepcoins: { type: Number, default: 1000 },

  cartas: [
    { type: mongoose.Schema.Types.ObjectId, ref: 'Card' }
  ],

  rewardsComprados: [
    { type: mongoose.Schema.Types.ObjectId, ref: 'Reward' }
  ],

  skinsCompradas: [
    { type: mongoose.Schema.Types.ObjectId, ref: 'Skin' }
  ],

  mazo: [
    { type: mongoose.Schema.Types.ObjectId, ref: 'Card' }
  ],

  // ✅ Skin actualmente activa
  skinSeleccionada: { type: mongoose.Schema.Types.ObjectId, ref: 'Skin' },

  // ✅ Aquí está la imagen subida (por ejemplo `/uploads/profiles/abc123.jpg`)
  fotoPerfil: { type: String }

}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
