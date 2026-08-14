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

const cardUpgradeSchema = new mongoose.Schema({
  card: { type: mongoose.Schema.Types.ObjectId, ref: 'Card', required: true },
  upgradeLevel: { type: Number, min: 0, max: 3, default: 0 },
}, { _id: false });

const userSchema = new mongoose.Schema({
  nickname: { type: String, trim: true, maxlength: 20 },
  normalizedNickname: { type: String, trim: true, maxlength: 20 },
  // Dato privado heredado. Nunca debe utilizarse como identidad social.
  nombre: { type: String, default: '' },
  email: { type: String, required: true, unique: true, trim: true, lowercase: true },
  // Solo las cuentas anteriores a la migracion conservan hash local. Los
  // usuarios Firebase nunca guardan contrasenas en MongoDB.
  password: {
    type: String,
    required() { return !this.firebaseUid; },
  },
  firebaseUid: { type: String, trim: true, unique: true, sparse: true },
  authProviders: { type: [String], default: [] },

  role: {
    type: String,
    enum: ['cliente', 'comercio', 'admin'],
    required: true
  },

  stepcoins: { type: Number, default: 1000 },
  stepcoinsTorretaPendientes: { type: Number, default: 0 },
  // Ausencia/legacy se interpreta como activado en todos los puntos de uso.
  gameModeEnabled: { type: Boolean, default: true },

  cartas: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Card' }],
  cardUpgrades: { type: [cardUpgradeSchema], default: [] },
  cardUpgradeRequestIds: { type: [String], default: [], select: false },
  rouletteRequestIds: { type: [String], default: [], select: false },
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

userSchema.index(
  { normalizedNickname: 1 },
  {
    unique: true,
    partialFilterExpression: { normalizedNickname: { $type: 'string' } },
    name: 'normalizedNickname_unique_partial',
  }
);

module.exports = mongoose.model('User', userSchema);
