const express = require("express");
const router = express.Router();
const multer = require("multer");
const mongoose = require("mongoose");
const Card = require("../models/Card");
const User = require("../models/User");
const {
  verifyToken,
  checkRole,
  requireSelfOrAdmin,
} = require("../middlewares/authMiddleware");
const adminOnly = [verifyToken, checkRole(['admin'])];
const {
  MAX_UPGRADE_LEVEL,
  UPGRADE_COSTS,
  effectiveCard,
  upgradeLevelForUser,
} = require("../services/cardUpgrades");
const { saveImage } = require("../utils/mediaStorage");

const SPRITESHEET_FIELDS = new Set([
  "projectileSpritesheetPng",
  "explosionSpritesheetPng",
  "turretIdleSpritesheetPng",
  "turretDeathSpritesheetPng"
]);

class SpritesheetValidationError extends Error {}

function invalidSpritesheet(message) {
  throw new SpritesheetValidationError(message);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (SPRITESHEET_FIELDS.has(file.fieldname)) {
      const isPng = file.mimetype === "image/png";
      return cb(isPng ? null : new SpritesheetValidationError("Los spritesheets deben ser PNG"), isPng);
    }
    if (!file.mimetype?.startsWith("image/")) {
      return cb(new Error("Sólo se permiten archivos de imagen"));
    }
    cb(null, true);
  }
});

// 🔧 Normalizar rutas
function normalizarRuta(file) {
  return file?.path || "";
}

function asBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === "true" || value === "1" || value === "on";
}

function pngDimensions(file) {
  const buffer = file?.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 ||
      buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    invalidSpritesheet("El spritesheet no es un PNG válido");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function parseSpritesheetConfig(raw, label, url, uploadedFile, previous = null, defaultLoop = true) {
  let parsed;
  try {
    parsed = raw === undefined || raw === null || raw === ""
      ? (typeof previous?.toObject === "function" ? previous.toObject() : previous)
      : (typeof raw === "string" ? JSON.parse(raw) : raw);
  } catch (_) {
    invalidSpritesheet(`Configuración JSON no válida para ${label}`);
  }
  if (!parsed || typeof parsed !== "object" || !url) {
    invalidSpritesheet(`Falta el PNG o la configuración de ${label}`);
  }

  const columns = Number(parsed.columns);
  const rows = Number(parsed.rows);
  const frames = Number(parsed.frames);
  const fps = Number(parsed.fps);
  const explicitFrameTime = Number(parsed.frameTime);
  const frameTime = explicitFrameTime > 0
    ? explicitFrameTime
    : (fps > 0 ? 1 / fps : NaN);
  if (![columns, rows, frames].every(Number.isInteger) ||
      columns < 1 || rows < 1 || frames < 1 || !(frameTime > 0)) {
    invalidSpritesheet(`Columnas, filas, frames y FPS/tiempo son obligatorios para ${label}`);
  }

  const dimensions = uploadedFile ? pngDimensions(uploadedFile) : null;
  const sourceWidth = dimensions?.width || previous?.sourceWidth;
  const sourceHeight = dimensions?.height || previous?.sourceHeight;

  const multipleOrientations = asBoolean(parsed.multipleOrientations, false);
  const readOrder = parsed.readOrder || "row-major";
  if (!["row-major", "row-major-reverse", "column-major"].includes(readOrder)) {
    invalidSpritesheet(`${label}: orden de lectura no válido`);
  }
  const availableFrames = multipleOrientations
    ? (readOrder === "column-major" ? rows : columns)
    : columns * rows;
  if (frames > availableFrames) {
    invalidSpritesheet(`${label}: frames supera la cuadrícula configurada`);
  }
  const orientationRows = Array.isArray(parsed.orientationRows)
    ? parsed.orientationRows.map(String)
    : String(parsed.orientationRows || "").split(",")
      .map((value) => value.trim()).filter(Boolean);
  const rawFrameOrder = Array.isArray(parsed.frameOrder)
    ? parsed.frameOrder
    : String(parsed.frameOrder || "").split(",")
      .map((value) => value.trim()).filter(Boolean);
  const frameOrder = rawFrameOrder.map(Number).filter(Number.isInteger);
  if (frameOrder.some((frame) => frame < 0 || frame >= availableFrames)) {
    invalidSpritesheet(`${label}: el orden de frames sale de la cuadrícula`);
  }

  return {
    url,
    columns,
    rows,
    frames,
    sourceWidth,
    sourceHeight,
    frameWidth: sourceWidth ? sourceWidth / columns : undefined,
    frameHeight: sourceHeight ? sourceHeight / rows : undefined,
    frameTime,
    fps: fps > 0 ? fps : 1 / frameTime,
    loop: asBoolean(parsed.loop, defaultLoop),
    multipleOrientations,
    readOrder,
    orientationRows,
    frameOrder
  };
}

function normalizedRenderType(value) {
  return value === "flame_spritesheet" ? "flame_spritesheet" : "classic";
}

async function guardarImagenes(files) {
  const entries = await Promise.all(
    Object.entries(files).map(async ([campo, archivos]) => {
      const guardados = await Promise.all(
        archivos.map(async (file) => ({
          ...file,
          path: await saveImage(file, "cards")
        }))
      );
      return [campo, guardados];
    })
  );
  return Object.fromEntries(entries);
}

router.post(
  "/",
  ...adminOnly,
  upload.fields([
    { name: "imagenPortada", maxCount: 1 },
    { name: "imagenesArma", maxCount: 4 },
    { name: "imagenesExplosion", maxCount: 4 },
    { name: "projectileSpritesheetPng", maxCount: 1 },
    { name: "explosionSpritesheetPng", maxCount: 1 },
    { name: "turretIdleSpritesheetPng", maxCount: 1 },
    { name: "turretDeathSpritesheetPng", maxCount: 1 },
    { name: "imagenesExtras", maxCount: 5 },

    { name: "imagenesMovimiento", maxCount: 4 },
    { name: "imagenesDisparo",   maxCount: 4 }, // nombre correcto
    { name: "imagenesBala",      maxCount: 4 }, // alias por si el front lo envía
    { name: "imagenesMuerte", maxCount: 4 },

    { name: "imagenesActivacion", maxCount: 4 },
    { name: "imagenesExplosionTrampa", maxCount: 4 },
    { name: "imagenesInvocacion", maxCount: 4 },
    { name: "imagenesAvion", maxCount: 4 },
    { name: "imagenesBomba", maxCount: 4 },
    { name: "imagenesExplosionInvocacion", maxCount: 4 },
    { name: "imagenesVida", maxCount: 4 },
    { name: "imagenesDefensa", maxCount: 4 }
  ]),
  async (req, res) => {
    try {
      let files = req.files || {};
      const body  = req.body  || {};

      // 👀 DEBUG ÚTIL
      console.log("📨 body:", body);
      console.log("📎 files:", Object.fromEntries(Object.entries(files).map(([k,v]) => [k, v.length])));

      // Helpers de parseo seguro
      const toInt   = (v, d=0) => (v === undefined || v === null || v === "" ? d : parseInt(v, 10));
      const toFloat = (v, d=0) => (v === undefined || v === null || v === "" ? d : parseFloat(v));
      const projectileRenderType = normalizedRenderType(body.projectileRenderType);
      const explosionRenderType = normalizedRenderType(body.explosionRenderType);
      const turretRenderType = normalizedRenderType(body.turretRenderType);

      // ✅ Validaciones mínimas (evita 500 de Mongoose)
      if (!body.titulo || !body.tipoArma) {
        return res.status(400).json({ error: "Faltan campos obligatorios: título y tipoArma." });
      }
      if (!files.imagenPortada || files.imagenPortada.length === 0) {
        return res.status(400).json({ error: "Debes subir una imagen de portada." });
      }
      if (body.tipoArma === "Proyectil" && projectileRenderType === "classic" && (!files.imagenesArma || files.imagenesArma.length === 0)) {
        return res.status(400).json({ error: "Debes subir al menos una imagen del proyectil (imagenesArma)." });
      }
      if (body.tipoArma === "Proyectil" && projectileRenderType === "flame_spritesheet" && !files.projectileSpritesheetPng?.length) {
        return res.status(400).json({ error: "Debes subir un PNG spritesheet para el proyectil Flame." });
      }
      if (body.tipoArma === "Proyectil" && explosionRenderType === "flame_spritesheet" && !files.explosionSpritesheetPng?.length) {
        return res.status(400).json({ error: "Debes subir un PNG spritesheet para la explosión Flame." });
      }
      if (body.tipoArma === "Arrastre" && turretRenderType === "flame_spritesheet" && !files.turretIdleSpritesheetPng?.length) {
        return res.status(400).json({ error: "Debes subir un PNG spritesheet para el Idle Flame de la torre." });
      }
      if (body.tipoArma === "Arrastre" &&
          (toInt(body.alcance, 0) <= 0 || toInt(body.dano, 0) <= 0)) {
        return res.status(400).json({
          error: "Las cartas Arrastre necesitan alcance y daño mayores que 0."
        });
      }
      if (body.tipoArma === "Vida" && toInt(body.vida, 0) <= 0) {
        return res.status(400).json({
          error: "Las cartas Vida necesitan otorgar una cantidad de vida mayor que 0."
        });
      }
      if (body.tipoArma === "Trampa" &&
          (toFloat(body.radioActivacion, 0) <= 0 ||
           toInt(body.dano, 0) <= 0 ||
           toInt(body.duracion, 0) <= 0)) {
        return res.status(400).json({
          error: "Las cartas Trampa necesitan radio, daño y duración mayores que 0."
        });
      }
      if (body.tipoArma === "Invocacion" &&
          (toFloat(body.radioExplosion, 0) <= 0 ||
           toInt(body.dano, 0) <= 0 ||
           toInt(body.tiempoHastaAtaque, 0) <= 0)) {
        return res.status(400).json({
          error: "Las cartas Invocación necesitan radio, daño y tiempo hasta el ataque mayores que 0."
        });
      }
      // ❗ Evita duplicados
      const yaExiste = await Card.findOne({
        titulo: body.titulo,
        tipoArma: body.tipoArma,
        dispositivo: body.dispositivo || "Ambos"
      });
      if (yaExiste) {
        return res.status(400).json({ error: "Ya existe una carta con ese título, tipo y dispositivo." });
      }

      // Unificar imágenes de disparo
      files = await guardarImagenes(files);
      const projectileSheetFile = files.projectileSpritesheetPng?.[0];
      const explosionSheetFile = files.explosionSpritesheetPng?.[0];
      const turretIdleSheetFile = files.turretIdleSpritesheetPng?.[0];
      const turretDeathSheetFile = files.turretDeathSpritesheetPng?.[0];
      const projectileSpritesheet = projectileRenderType === "flame_spritesheet"
        ? parseSpritesheetConfig(body.projectileSpritesheetConfig, "proyectil", normalizarRuta(projectileSheetFile), projectileSheetFile)
        : undefined;
      const explosionSpritesheet = explosionRenderType === "flame_spritesheet"
        ? parseSpritesheetConfig(body.explosionSpritesheetConfig, "explosión", normalizarRuta(explosionSheetFile), explosionSheetFile)
        : undefined;
      const turretIdleSpritesheet = turretRenderType === "flame_spritesheet"
        ? parseSpritesheetConfig(body.turretIdleSpritesheetConfig, "Idle de torre", normalizarRuta(turretIdleSheetFile), turretIdleSheetFile, null, true)
        : undefined;
      const turretDeathSpritesheet = turretRenderType === "flame_spritesheet" && turretDeathSheetFile
        ? parseSpritesheetConfig(body.turretDeathSpritesheetConfig, "Death de torre", normalizarRuta(turretDeathSheetFile), turretDeathSheetFile, null, false)
        : undefined;
      const imgsDisparo = [];
      if (files.imagenesDisparo) imgsDisparo.push(...files.imagenesDisparo.map(normalizarRuta));
      if (files.imagenesBala)     imgsDisparo.push(...files.imagenesBala.map(normalizarRuta));

      const card = new Card({
        // Básicos
        titulo: body.titulo,
        descripcion: body.descripcion,
        imagenPortada: normalizarRuta(files.imagenPortada[0]),

        // Tipo y dispositivo
        tipoArma: body.tipoArma,
        dispositivo: body.dispositivo || "Ambos",

        // Comunes
        alcance: toInt(body.alcance, 0),
        dano: toInt(body.dano, 0),
        tiempoEspera: toInt(body.tiempoEspera, 0),
        sePuedeSaltar: body.sePuedeSaltar === "true",
        duracion: body.duracion ? toInt(body.duracion, 0) * 60 : 0, // minutos → segundos

        // Imágenes
        imagenesArma:        (files.imagenesArma        || []).map(normalizarRuta),
        imagenesExplosion:   (files.imagenesExplosion   || []).map(normalizarRuta),
        imagenesExtras:      (files.imagenesExtras      || []).map(normalizarRuta),
        imagenesMovimiento:  (files.imagenesMovimiento  || []).map(normalizarRuta),
        imagenesDisparo:      imgsDisparo,
        imagenesMuerte:      (files.imagenesMuerte      || []).map(normalizarRuta),
        imagenesActivacion:  (files.imagenesActivacion  || []).map(normalizarRuta),
        imagenesExplosionTrampa:
          (files.imagenesExplosionTrampa || []).map(normalizarRuta),
        imagenesInvocacion:  (files.imagenesInvocacion  || []).map(normalizarRuta),
        imagenesAvion:       (files.imagenesAvion       || []).map(normalizarRuta),
        imagenesBomba:       (files.imagenesBomba       || []).map(normalizarRuta),
        imagenesExplosionInvocacion:
          (files.imagenesExplosionInvocacion || []).map(normalizarRuta),
        imagenesVida:        (files.imagenesVida        || []).map(normalizarRuta),
        imagenesDefensa:     (files.imagenesDefensa     || []).map(normalizarRuta),
        projectileRenderType,
        explosionRenderType,
        projectileSpritesheet,
        explosionSpritesheet,
        turretRenderType,
        turretIdleSpritesheet,
        turretDeathSpritesheet,

        // Específicos
        vida: toInt(body.vida, 0),
        cadenciaDisparo: Math.max(1, toInt(body.cadenciaDisparo, 10)),
        premioBajaTorreta: Math.max(0, toInt(body.premioBajaTorreta, 100)),
        vidaQueDa: body.tipoArma === "Vida"
          ? toInt(body.vida, 0)
          : toInt(body.vidaQueDa, 0),
        radioRecogida: toFloat(body.radioRecogida, 1),
        radioActivacion: toFloat(body.radioActivacion, 1),
        radioExplosion: toFloat(body.radioExplosion, 1),
        tiempoHastaAtaque: toInt(body.tiempoHastaAtaque, 0),
        usoUnico: body.usoUnico === "true",
        velocidadMovimiento: body.velocidadMovimiento ? toFloat(body.velocidadMovimiento) : undefined,
        iaComportamiento: body.iaComportamiento || undefined,
        duracionDefensa: toInt(body.duracionDefensa, 0),
        tipoDefensa: body.tipoDefensa || "Inmunidad",
        porcentajeReduccion: toInt(body.porcentajeReduccion, 0),
      });

      // Por si faltó imagen en Proyectil (fallback)
      if (card.tipoArma === "Proyectil" && card.imagenesArma.length === 0) {
        card.imagenesArma = projectileSpritesheet?.url
          ? [projectileSpritesheet.url]
          : ["/img/arrow.png"];
      }
      if (card.imagenesExplosion.length === 0 && explosionSpritesheet?.url) {
        card.imagenesExplosion = [explosionSpritesheet.url];
      }

      await card.save();
      return res.json({ message: "✅ Carta creada correctamente", card });
    } catch (err) {
      if (err instanceof SpritesheetValidationError) {
        return res.status(400).json({ error: err.message });
      }
      // Si es validación de Mongoose, devuélvela clara al cliente
      if (err.name === "ValidationError") {
        console.error("❌ ValidationError:", err.message);
        return res.status(400).json({ error: "Validación fallida", details: err.message });
      }
      console.error("❌ Error al guardar carta:", err);
      return res.status(500).json({ error: "Error interno al guardar carta", details: err.message });
    }
  }
);

// ✏️ Editar carta. Los archivos solo se sustituyen cuando llegan otros nuevos.
router.put(
  "/:id",
  ...adminOnly,
  upload.fields([
    { name: "imagenPortada", maxCount: 1 },
    { name: "imagenesArma", maxCount: 4 },
    { name: "imagenesExplosion", maxCount: 4 },
    { name: "projectileSpritesheetPng", maxCount: 1 },
    { name: "explosionSpritesheetPng", maxCount: 1 },
    { name: "turretIdleSpritesheetPng", maxCount: 1 },
    { name: "turretDeathSpritesheetPng", maxCount: 1 },
    { name: "imagenesExtras", maxCount: 5 },
    { name: "imagenesMovimiento", maxCount: 4 },
    { name: "imagenesDisparo", maxCount: 4 },
    { name: "imagenesBala", maxCount: 4 },
    { name: "imagenesMuerte", maxCount: 4 },
    { name: "imagenesActivacion", maxCount: 4 },
    { name: "imagenesExplosionTrampa", maxCount: 4 },
    { name: "imagenesInvocacion", maxCount: 4 },
    { name: "imagenesAvion", maxCount: 4 },
    { name: "imagenesBomba", maxCount: 4 },
    { name: "imagenesExplosionInvocacion", maxCount: 4 },
    { name: "imagenesVida", maxCount: 4 },
    { name: "imagenesDefensa", maxCount: 4 }
  ]),
  async (req, res) => {
    try {
      const card = await Card.findById(req.params.id);
      if (!card) {
        return res.status(404).json({ error: "Carta no encontrada" });
      }

      let files = req.files || {};
      const body = req.body || {};
      const toInt = (value, fallback = 0) =>
        value === undefined || value === null || value === ""
          ? fallback
          : parseInt(value, 10);
      const toFloat = (value, fallback = 0) =>
        value === undefined || value === null || value === ""
          ? fallback
          : parseFloat(value);

      if (!body.titulo || !body.tipoArma) {
        return res.status(400).json({
          error: "Faltan campos obligatorios: título y tipoArma."
        });
      }
      if (body.tipoArma === "Arrastre" &&
          (toInt(body.alcance, 0) <= 0 || toInt(body.dano, 0) <= 0)) {
        return res.status(400).json({
          error: "Las cartas Arrastre necesitan alcance y daño mayores que 0."
        });
      }
      if (body.tipoArma === "Vida" && toInt(body.vida, 0) <= 0) {
        return res.status(400).json({
          error: "Las cartas Vida necesitan otorgar una cantidad de vida mayor que 0."
        });
      }
      if (body.tipoArma === "Trampa" &&
          (toFloat(body.radioActivacion, 0) <= 0 ||
           toInt(body.dano, 0) <= 0 ||
           toInt(body.duracion, 0) <= 0)) {
        return res.status(400).json({
          error: "Las cartas Trampa necesitan radio, daño y duración mayores que 0."
        });
      }
      if (body.tipoArma === "Invocacion" &&
          (toFloat(body.radioExplosion, 0) <= 0 ||
           toInt(body.dano, 0) <= 0 ||
           toInt(body.tiempoHastaAtaque, 0) <= 0)) {
        return res.status(400).json({
          error: "Las cartas Invocación necesitan radio, daño y tiempo hasta el ataque mayores que 0."
        });
      }

      const duplicada = await Card.findOne({
        _id: { $ne: card._id },
        titulo: body.titulo,
        tipoArma: body.tipoArma,
        dispositivo: body.dispositivo || "Ambos"
      });
      if (duplicada) {
        return res.status(400).json({
          error: "Ya existe otra carta con ese título, tipo y dispositivo."
        });
      }

      files = await guardarImagenes(files);
      const projectileRenderType = normalizedRenderType(body.projectileRenderType || card.projectileRenderType);
      const explosionRenderType = normalizedRenderType(body.explosionRenderType || card.explosionRenderType);
      const turretRenderType = normalizedRenderType(body.turretRenderType || card.turretRenderType);
      const projectileSheetFile = files.projectileSpritesheetPng?.[0];
      const explosionSheetFile = files.explosionSpritesheetPng?.[0];
      const turretIdleSheetFile = files.turretIdleSpritesheetPng?.[0];
      const turretDeathSheetFile = files.turretDeathSpritesheetPng?.[0];
      const projectileSpritesheet = projectileRenderType === "flame_spritesheet"
        ? parseSpritesheetConfig(body.projectileSpritesheetConfig, "proyectil", normalizarRuta(projectileSheetFile) || card.projectileSpritesheet?.url, projectileSheetFile, card.projectileSpritesheet)
        : card.projectileSpritesheet;
      const explosionSpritesheet = explosionRenderType === "flame_spritesheet"
        ? parseSpritesheetConfig(body.explosionSpritesheetConfig, "explosión", normalizarRuta(explosionSheetFile) || card.explosionSpritesheet?.url, explosionSheetFile, card.explosionSpritesheet)
        : card.explosionSpritesheet;
      const turretIdleSpritesheet = turretRenderType === "flame_spritesheet"
        ? parseSpritesheetConfig(body.turretIdleSpritesheetConfig, "Idle de torre", normalizarRuta(turretIdleSheetFile) || card.turretIdleSpritesheet?.url, turretIdleSheetFile, card.turretIdleSpritesheet, true)
        : card.turretIdleSpritesheet;
      const hasTurretDeath = Boolean(turretDeathSheetFile || card.turretDeathSpritesheet?.url);
      const turretDeathSpritesheet = turretRenderType === "flame_spritesheet" && hasTurretDeath
        ? parseSpritesheetConfig(body.turretDeathSpritesheetConfig, "Death de torre", normalizarRuta(turretDeathSheetFile) || card.turretDeathSpritesheet?.url, turretDeathSheetFile, card.turretDeathSpritesheet, false)
        : card.turretDeathSpritesheet;
      Object.assign(card, {
        titulo: body.titulo,
        descripcion: body.descripcion || "",
        tipoArma: body.tipoArma,
        dispositivo: body.dispositivo || "Ambos",
        alcance: toInt(body.alcance, 0),
        dano: toInt(body.dano, 0),
        tiempoEspera: toInt(body.tiempoEspera, 0),
        sePuedeSaltar: body.sePuedeSaltar === "true",
        duracion: toInt(body.duracion, 0) * 60,
        vida: toInt(body.vida, 0),
        cadenciaDisparo: Math.max(1, toInt(body.cadenciaDisparo, 10)),
        premioBajaTorreta: Math.max(0, toInt(body.premioBajaTorreta, 100)),
        vidaQueDa: body.tipoArma === "Vida"
          ? toInt(body.vida, card.vidaQueDa || 0)
          : toInt(body.vidaQueDa, card.vidaQueDa || 0),
        radioRecogida: toFloat(body.radioRecogida, card.radioRecogida || 1),
        radioActivacion: toFloat(body.radioActivacion, 1),
        radioExplosion: toFloat(body.radioExplosion, card.radioExplosion || 1),
        tiempoHastaAtaque: toInt(
          body.tiempoHastaAtaque,
          card.tiempoHastaAtaque || 0
        ),
        usoUnico: body.usoUnico === "true",
        velocidadMovimiento: body.velocidadMovimiento
          ? toFloat(body.velocidadMovimiento)
          : undefined,
        iaComportamiento: body.iaComportamiento || undefined,
        duracionDefensa: toInt(body.duracionDefensa, 0),
        tipoDefensa: body.tipoDefensa || "Inmunidad",
        porcentajeReduccion: toInt(body.porcentajeReduccion, 0),
        projectileRenderType,
        explosionRenderType,
        projectileSpritesheet,
        explosionSpritesheet,
        turretRenderType,
        turretIdleSpritesheet,
        turretDeathSpritesheet
      });

      if (files.imagenPortada?.length) {
        card.imagenPortada = normalizarRuta(files.imagenPortada[0]);
      }

      const camposImagenes = [
        "imagenesArma",
        "imagenesExplosion",
        "imagenesExtras",
        "imagenesMovimiento",
        "imagenesMuerte",
        "imagenesActivacion",
        "imagenesExplosionTrampa",
        "imagenesInvocacion",
        "imagenesAvion",
        "imagenesBomba",
        "imagenesExplosionInvocacion",
        "imagenesVida",
        "imagenesDefensa"
      ];
      camposImagenes.forEach((campo) => {
        if (files[campo]?.length) {
          card[campo] = files[campo].map(normalizarRuta);
        }
      });

      const imagenesDisparo = [
        ...(files.imagenesDisparo || []),
        ...(files.imagenesBala || [])
      ];
      if (imagenesDisparo.length) {
        card.imagenesDisparo = imagenesDisparo.map(normalizarRuta);
      }
      if ((!card.imagenesArma || card.imagenesArma.length === 0) && projectileSpritesheet?.url) {
        card.imagenesArma = [projectileSpritesheet.url];
      }
      if ((!card.imagenesExplosion || card.imagenesExplosion.length === 0) && explosionSpritesheet?.url) {
        card.imagenesExplosion = [explosionSpritesheet.url];
      }

      await card.save();
      return res.json({ message: "✅ Carta actualizada correctamente", card });
    } catch (err) {
      if (err instanceof SpritesheetValidationError) {
        return res.status(400).json({ error: err.message });
      }
      if (err.name === "ValidationError") {
        return res.status(400).json({
          error: "Validación fallida",
          details: err.message
        });
      }
      console.error("❌ Error al actualizar carta:", err);
      return res.status(500).json({
        error: "Error interno al actualizar la carta",
        details: err.message
      });
    }
  }
);

// 📥 Obtener todas las cartas
router.get("/", async (req, res) => {
  try {
    const cards = await Card.find().sort({ creadoEn: -1 });
    res.json(cards);
  } catch (err) {
    console.error("❌ Error al obtener cartas:", err);
    res.status(500).json({ error: "Error al obtener cartas" });
  }
});

// ❌ Eliminar carta
router.delete("/:id", ...adminOnly, async (req, res) => {
  try {
    await Card.findByIdAndDelete(req.params.id);
    res.json({ message: "✅ Carta eliminada" });
  } catch (err) {
    console.error("❌ Error al eliminar carta:", err);
    res.status(500).json({ error: "Error al eliminar carta" });
  }
});

// 🧠 Obtener cartas del usuario
// Mejora una carta del usuario. Nivel y coste se calculan exclusivamente aqui.
router.post("/user-cards/:cardId/upgrade", verifyToken, async (req, res) => {
  const userId = String(req.user.id || "");
  const cardId = String(req.params.cardId || "");
  const requestId = String(req.body?.requestId || "").trim();

  if (!mongoose.isValidObjectId(cardId)) {
    return res.status(400).json({ error: "Carta invalida" });
  }
  if (!requestId || requestId.length > 120) {
    return res.status(400).json({ error: "Falta un identificador de operacion valido" });
  }

  try {
    const cardObjectId = new mongoose.Types.ObjectId(cardId);
    const baseCard = await Card.findById(cardObjectId).lean();
    if (!baseCard) return res.status(404).json({ error: "Carta no encontrada" });

    const upgradesExpression = { $ifNull: ["$cardUpgrades", []] };
    const currentLevelExpression = {
      $ifNull: [
        {
          $arrayElemAt: [
            {
              $map: {
                input: {
                  $filter: {
                    input: upgradesExpression,
                    as: "upgrade",
                    cond: { $eq: ["$$upgrade.card", cardObjectId] },
                  },
                },
                as: "upgrade",
                in: "$$upgrade.upgradeLevel",
              },
            },
            0,
          ],
        },
        0,
      ],
    };
    const costExpression = {
      $arrayElemAt: [UPGRADE_COSTS, currentLevelExpression],
    };

    const user = await User.findOneAndUpdate(
      {
        _id: userId,
        cartas: cardObjectId,
        cardUpgradeRequestIds: { $ne: requestId },
        $expr: {
          $and: [
            { $lt: [currentLevelExpression, MAX_UPGRADE_LEVEL] },
            { $gte: ["$stepcoins", costExpression] },
          ],
        },
      },
      [
        {
          $set: {
            stepcoins: { $subtract: ["$stepcoins", costExpression] },
            cardUpgrades: {
              $concatArrays: [
                {
                  $filter: {
                    input: upgradesExpression,
                    as: "upgrade",
                    cond: { $ne: ["$$upgrade.card", cardObjectId] },
                  },
                },
                [{
                  card: cardObjectId,
                  upgradeLevel: { $add: [currentLevelExpression, 1] },
                }],
              ],
            },
            cardUpgradeRequestIds: {
              $slice: [
                {
                  $concatArrays: [
                    { $ifNull: ["$cardUpgradeRequestIds", []] },
                    [requestId],
                  ],
                },
                -100,
              ],
            },
          },
        },
      ],
      { new: true }
    ).select("stepcoins cardUpgrades").lean();

    if (user) {
      const upgradeLevel = upgradeLevelForUser(user, cardId);
      return res.json({
        card: effectiveCard(baseCard, upgradeLevel),
        upgradeLevel,
        cost: UPGRADE_COSTS[upgradeLevel - 1],
        stepcoins: user.stepcoins,
      });
    }

    const currentUser = await User.findById(userId)
      .select("+cardUpgradeRequestIds stepcoins cardUpgrades cartas")
      .lean();
    if (!currentUser) return res.status(404).json({ error: "Usuario no encontrado" });
    if (!currentUser.cartas.some((id) => String(id) === cardId)) {
      return res.status(403).json({ error: "La carta no pertenece al usuario" });
    }

    const currentLevel = upgradeLevelForUser(currentUser, cardId);
    if (currentUser.cardUpgradeRequestIds?.includes(requestId)) {
      return res.json({
        card: effectiveCard(baseCard, currentLevel),
        upgradeLevel: currentLevel,
        cost: 0,
        stepcoins: currentUser.stepcoins,
        duplicate: true,
      });
    }
    if (currentLevel >= MAX_UPGRADE_LEVEL) {
      return res.status(409).json({ error: "Nivel m\u00e1ximo", code: "MAX_LEVEL" });
    }
    return res.status(409).json({
      error: "No tienes suficientes Stepcoins",
      code: "INSUFFICIENT_STEPCOINS",
      required: UPGRADE_COSTS[currentLevel],
      stepcoins: currentUser.stepcoins,
    });
  } catch (err) {
    console.error("Error al mejorar carta:", err);
    return res.status(500).json({ error: "No se pudo mejorar la carta" });
  }
});

router.get("/user-cards/:userId", verifyToken, requireSelfOrAdmin(), async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).populate("cartas");
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    res.json(user.cartas.map((card) =>
      effectiveCard(card, upgradeLevelForUser(user, card._id))
    ));
  } catch (err) {
    console.error("❌ Error al obtener cartas del usuario:", err.message);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// 🧩 Actualizar mazo activo
router.put("/user-cards/:userId", verifyToken, requireSelfOrAdmin(), async (req, res) => {
  try {
    const { mazo } = req.body;

    if (!Array.isArray(mazo) || mazo.length !== 4) {
      return res.status(400).json({ error: "El mazo debe tener exactamente 4 cartas" });
    }

    const user = await User.findByIdAndUpdate(
      req.params.userId,
      { mazo },
      { new: true }
    ).populate("mazo");

    res.json({ message: "✅ Mazo actualizado", mazo: user.mazo });
  } catch (err) {
    console.error("❌ Error al actualizar el mazo:", err.message);
    res.status(500).json({ error: "Error al actualizar el mazo" });
  }
});

// 🔍 Obtener mazo activo
router.get("/user-cards/:userId/mazo", verifyToken, requireSelfOrAdmin(), async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).populate("mazo");
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    res.json(user.mazo.map((card) =>
      effectiveCard(card, upgradeLevelForUser(user, card._id))
    ));
  } catch (err) {
    console.error("❌ Error al obtener el mazo:", err.message);
    res.status(500).json({ error: "Error al obtener el mazo" });
  }
});

router.get("/fix-extensions", ...adminOnly, (_req, res) => {
  res.json({
    message: "Las imágenes nuevas se guardan en MongoDB y conservan su tipo original.",
    renombrados: []
  });
});

module.exports = router;
