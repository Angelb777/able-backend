const mongoose = require('mongoose');

const rewardSchema = new mongoose.Schema({
  tipo: { type: String, enum: ['descuento', 'premio'], required: true },
  titulo: String,
  descripcion: String,
  direccion: String,
  comercioId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Si es de un comercio
  porcentaje: Number, // si es descuento %
  cantidadEuros: Number, // si es descuento en €
  stepcoins: { type: Number, required: true },
  // null mantiene sin limite los rewards antiguos; los premios nuevos
  // siempre guardan un numero entero de unidades disponibles.
  unidades: { type: Number, min: 0, default: null },
  imagenes: [String], // rutas locales o URLs
  validado: { type: Boolean, default: false },
  fechaCreacion: { type: Date, default: Date.now },
  compradores: [
    {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      validado: { type: Boolean, default: false },
      purchasedAt: { type: Date, default: Date.now },
      validatedAt: Date,
      validatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
    }
  ],
  destacado: { type: Boolean, default: false }, // ✅ Para destacar
  nivelDestacado: { type: Number, default: null }, // 1: top5, 2: top10, 3: top20

  creadoPorAdmin: { type: Boolean, default: false } // ✅ Nuevo campo para distinguir los del admin
  ,
  commercialRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'CommercialRequest', index: true },
  publicationStatus: {
    type: String,
    enum: ['pending', 'published', 'disabled', 'retired'],
    default: 'pending'
  },
  publishedAt: Date,
  retiredAt: Date,
  // Posicion elegida por el Superadmin para el catalogo publico (Flutter).
  // Los registros antiguos sin valor se muestran despues de los ordenados.
  ordenCatalogo: { type: Number, min: 0, default: null, index: true }
});

module.exports = mongoose.model('Reward', rewardSchema);
