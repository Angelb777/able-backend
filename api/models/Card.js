const mongoose = require("mongoose");

const cardSpritesheetSchema = new mongoose.Schema({
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

const CardSchema = new mongoose.Schema({
  // Información básica
  titulo: { type: String, required: true },
  descripcion: { type: String },
  imagenPortada: { type: String },
  imagenesExtras: [String], // Hasta 5 imágenes opcionales

  // Tipo de carta
  tipoArma: {
    type: String,
    enum: ["Proyectil", "Arrastre", "Trampa", "Invocacion", "Vida", "Defensa"],
    required: true
  },

  dispositivo: {
    type: String,
    enum: ["Ambos", "Móvil", "Ordenador"],
    default: "Ambos"
  },

  // Atributos comunes
  dano: { type: Number, default: 0 },
  alcance: { type: Number, default: 0 },
  tiempoEspera: { type: Number, default: 0 }, // En segundos
  sePuedeSaltar: { type: Boolean, default: false },
  duracion: { type: Number, default: 0 },     // ⏳ En segundos. Usado por Arrastre, Trampa e Invocacion

  // ===== Proyectil =====
  imagenesArma: [String],         // 4 imágenes
  imagenesExplosion: [String],    // 4 imágenes
  projectileRenderType: {
    type: String,
    enum: ["classic", "flame_spritesheet"],
    default: "classic"
  },
  explosionRenderType: {
    type: String,
    enum: ["classic", "flame_spritesheet"],
    default: "classic"
  },
  projectileSpritesheet: cardSpritesheetSchema,
  explosionSpritesheet: cardSpritesheetSchema,

  // ===== Arrastre =====
  imagenesMovimiento: [String],   // 4 imágenes de movimiento
  imagenesDisparo: [String],      // si dispara proyectiles
  imagenesMuerte: [String],       // 4 imágenes al morir
  vida: { type: Number, default: 0 },
  cadenciaDisparo: { type: Number, default: 10 }, // segundos entre disparos
  premioBajaTorreta: { type: Number, default: 100 },

  // ===== Trampa =====
  radioActivacion: { type: Number, default: 1 }, // metros
  usoUnico: { type: Boolean, default: true },
  imagenesActivacion: [String], // al explotar o activarse
  imagenesExplosionTrampa: [String],

  // ===== Invocacion =====
  // (duracion se usa también aquí; queda definido arriba como común)
  velocidadMovimiento: { type: Number },
  iaComportamiento: { type: String }, // ejemplo: "avanza y ataca"
  imagenesInvocacion: [String],
  imagenesAvion: [String],
  imagenesBomba: [String],
  imagenesExplosionInvocacion: [String],
  radioExplosion: { type: Number, default: 1 },
  tiempoHastaAtaque: { type: Number, default: 0 },

  // ===== Vida =====
  vidaQueDa: { type: Number, default: 0 },
  radioRecogida: { type: Number, default: 1 }, // distancia para recoger
  imagenesVida: [String],

  // ===== Defensa =====
  duracionDefensa: { type: Number, default: 5 }, // segundos
  tipoDefensa: {
    type: String,
    enum: ["Inmunidad", "Reducir daño", "Reflejo"],
    default: "Inmunidad"
  },
  porcentajeReduccion: { type: Number, default: 0 },
  imagenesDefensa: [String],

  creadoEn: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Card", CardSchema);
