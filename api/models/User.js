const mongoose = require('mongoose');

// 🆕 Subdocumento para la info de perfil que rellena el usuario desde Flutter
const profileSchema = new mongoose.Schema({
  name: { type: String, default: '' },        // Nombre (campo en Flutter)
  lastName: { type: String, default: '' },    // Apellidos
  address: { type: String, default: '' },     // Dirección
  city: { type: String, default: '' },        // Ciudad
  country: { type: String, default: '' },     // País

  // Documentos (idealmente serán URLs cuando implementes subida de imágenes)
  idCardFront: { type: String, default: '' },
  idCardBack: { type: String, default: '' },
  licenseFront: { type: String, default: '' },
  licenseBack: { type: String, default: '' },
}, { _id: false });

const userSchema = new mongoose.Schema({
  nombre: { type: String, required: true },   // Nombre básico (login, display)
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },

  role: {
    type: String,
    enum: ['cliente', 'comercio', 'admin'],
    required: true
  },

  stepcoins: { type: Number, default: 1000 },
  stepcoinsTorretaPendientes: { type: Number, default: 0 },

  cartas: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Card' }],
  rewardsComprados: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Reward' }],
  skinsCompradas: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Skin' }],
  mazo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Card' }],

  // ✅ Skin actualmente activa
  skinSeleccionada: { type: mongoose.Schema.Types.ObjectId, ref: 'Skin' },

  // ✅ Imagen de perfil
  fotoPerfil: { type: String },

  // 🆕 Información detallada de usuario
  profile: { type: profileSchema, default: () => ({}) }

}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
