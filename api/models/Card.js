const mongoose = require("mongoose");
const cardSpritesheetSchema = require("./spritesheetSchema");

const CardSchema = new mongoose.Schema({
  // Información básica
  titulo: { type: String, required: true },
  descripcion: { type: String },
  imagenPortada: { type: String },
  imagenesExtras: [String], // Hasta 5 imágenes opcionales

  // Tipo de carta
  tipoArma: {
    type: String,
    enum: ["Proyectil", "Arrastre", "Trampa", "Invocacion", "Vida", "Defensa", "TROPA"],
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
  turretRenderType: {
    type: String,
    enum: ["classic", "flame_spritesheet"],
    default: "classic"
  },
  turretIdleSpritesheet: cardSpritesheetSchema,
  turretDeathSpritesheet: cardSpritesheetSchema,
  vida: { type: Number, default: 0 },
  cadenciaDisparo: { type: Number, default: 10 }, // segundos entre disparos
  premioBajaTorreta: { type: Number, default: 100 },

  // ===== Trampa =====
  radioActivacion: { type: Number, default: 1 }, // metros
  usoUnico: { type: Boolean, default: true },
  imagenesActivacion: [String], // al explotar o activarse
  imagenesExplosionTrampa: [String],
  mineRenderType: {
    type: String,
    enum: ["classic", "flame_spritesheet"],
    default: "classic"
  },
  mineSpritesheet: cardSpritesheetSchema,
  mineExplosionRenderType: {
    type: String,
    enum: ["classic", "flame_spritesheet"],
    default: "classic"
  },
  mineExplosionSpritesheet: cardSpritesheetSchema,

  // ===== Invocacion =====
  // (duracion se usa también aquí; queda definido arriba como común)
  velocidadMovimiento: { type: Number },
  iaComportamiento: { type: String }, // ejemplo: "avanza y ataca"
  imagenesInvocacion: [String],
  imagenesAvion: [String],
  imagenesBomba: [String],
  imagenesExplosionInvocacion: [String],
  airstrikePlaneRenderType: {
    type: String,
    enum: ["classic", "flame_spritesheet"],
    default: "classic"
  },
  airstrikePlaneSpritesheet: cardSpritesheetSchema,
  airstrikeBombRenderType: {
    type: String,
    enum: ["classic", "flame_spritesheet"],
    default: "classic"
  },
  airstrikeBombSpritesheet: cardSpritesheetSchema,
  airstrikeExplosionRenderType: {
    type: String,
    enum: ["classic", "flame_spritesheet"],
    default: "classic"
  },
  airstrikeExplosionSpritesheet: cardSpritesheetSchema,
  radioExplosion: { type: Number, default: 1 },
  tiempoHastaAtaque: { type: Number, default: 0 },

  // ===== TROPA =====
  numeroUnidades: { type: Number, default: 1, min: 1 },
  separacionUnidades: { type: Number, default: 3, min: 0 },
  distanciaMaximaColocacion: { type: Number, default: 500, min: 1 },
  rangoDeteccion: { type: Number, default: 100, min: 1 },
  rangoAtaque: { type: Number, default: 2, min: 0.1 },
  distanciaMaximaPersecucion: { type: Number, default: 250, min: 1 },
  cooldownAtaque: { type: Number, default: 1, min: 0.1 },
  unitIdleSpritesheet: cardSpritesheetSchema,
  unitWalkSpritesheet: cardSpritesheetSchema,
  unitAttackSpritesheet: cardSpritesheetSchema,

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

  creadoEn: { type: Date, default: Date.now },
  commercialRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "CommercialRequest", index: true },
  commercialOwnerId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  commercialTier: { type: String, enum: ["", "short", "medium", "long"], default: "" },
  isCommercial: { type: Boolean, default: false },
  commercialPublicationStatus: {
    type: String,
    enum: ["published", "disabled", "retired"],
    default: "published"
  },
  publishedAt: Date,
  reviewDueAt: Date,
  retiredAt: Date
});

module.exports = mongoose.model("Card", CardSchema);
