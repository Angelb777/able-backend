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
  imagenes: [String], // rutas locales o URLs
  validado: { type: Boolean, default: false },
  fechaCreacion: { type: Date, default: Date.now },
  compradores: [
    {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      validado: { type: Boolean, default: false }
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
  retiredAt: Date
});

module.exports = mongoose.model('Reward', rewardSchema);
