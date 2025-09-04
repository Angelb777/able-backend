const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const Card = require("../models/Card");
const User = require("../models/User");

// 📁 Asegurar que la carpeta exista antes de usarla
const dir = path.join(__dirname, "../uploads/cards");
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
  console.log("📁 Carpeta 'uploads/cards' creada");
}

// 🧼 Renombrar archivos sin extensión
fs.readdirSync(dir).forEach(file => {
  const ext = path.extname(file);
  if (!ext) {
    const oldPath = path.join(dir, file);
    const newPath = path.join(dir, file + ".png");
    fs.renameSync(oldPath, newPath);
    console.log(`✅ Renombrado: ${file} → ${file}.png`);
  }
});

// 🧱 Configurar almacenamiento con multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/cards");
  },
  filename: (req, file, cb) => {
  const ext = path.extname(file.originalname) || ".png";
  const baseName = path.basename(file.originalname, ext).replace(/\s+/g, "_"); // quita espacios
  const uniqueSuffix = Date.now();
  const finalName = `${baseName}-${uniqueSuffix}${ext}`;
  cb(null, finalName);
}
});

const upload = multer({ storage });

// 🔧 Normalizar rutas
function normalizarRuta(file) {
  let ruta = file.path.replace(/\\/g, "/");
  if (!ruta.startsWith("/")) ruta = "/" + ruta;
  return ruta;
}

router.post(
  "/",
  upload.fields([
    { name: "imagenPortada", maxCount: 1 },
    { name: "imagenesArma", maxCount: 4 },
    { name: "imagenesExplosion", maxCount: 4 },
    { name: "imagenesExtras", maxCount: 5 },

    { name: "imagenesMovimiento", maxCount: 4 },
    { name: "imagenesDisparo",   maxCount: 4 }, // nombre correcto
    { name: "imagenesBala",      maxCount: 4 }, // alias por si el front lo envía
    { name: "imagenesMuerte", maxCount: 4 },

    { name: "imagenesActivacion", maxCount: 4 },
    { name: "imagenesInvocacion", maxCount: 4 },
    { name: "imagenesVida", maxCount: 4 },
    { name: "imagenesDefensa", maxCount: 4 }
  ]),
  async (req, res) => {
    try {
      const files = req.files || {};
      const body  = req.body  || {};

      // 👀 DEBUG ÚTIL
      console.log("📨 body:", body);
      console.log("📎 files:", Object.fromEntries(Object.entries(files).map(([k,v]) => [k, v.length])));

      // Helpers de parseo seguro
      const toInt   = (v, d=0) => (v === undefined || v === null || v === "" ? d : parseInt(v, 10));
      const toFloat = (v, d=0) => (v === undefined || v === null || v === "" ? d : parseFloat(v));

      // ✅ Validaciones mínimas (evita 500 de Mongoose)
      if (!body.titulo || !body.tipoArma) {
        return res.status(400).json({ error: "Faltan campos obligatorios: título y tipoArma." });
      }
      if (!files.imagenPortada || files.imagenPortada.length === 0) {
        return res.status(400).json({ error: "Debes subir una imagen de portada." });
      }
      if (body.tipoArma === "Proyectil" && (!files.imagenesArma || files.imagenesArma.length === 0)) {
        return res.status(400).json({ error: "Debes subir al menos una imagen del proyectil (imagenesArma)." });
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
        imagenesInvocacion:  (files.imagenesInvocacion  || []).map(normalizarRuta),
        imagenesVida:        (files.imagenesVida        || []).map(normalizarRuta),
        imagenesDefensa:     (files.imagenesDefensa     || []).map(normalizarRuta),

        // Específicos
        vida: toInt(body.vida, 0),
        vidaQueDa: toInt(body.vidaQueDa, 0),
        radioRecogida: toFloat(body.radioRecogida, 1),
        radioActivacion: toFloat(body.radioActivacion, 1),
        usoUnico: body.usoUnico === "true",
        velocidadMovimiento: body.velocidadMovimiento ? toFloat(body.velocidadMovimiento) : undefined,
        iaComportamiento: body.iaComportamiento || undefined,
        duracionDefensa: toInt(body.duracionDefensa, 0),
        tipoDefensa: body.tipoDefensa || "Inmunidad",
        porcentajeReduccion: toInt(body.porcentajeReduccion, 0),
      });

      // Por si faltó imagen en Proyectil (fallback)
      if (card.tipoArma === "Proyectil" && card.imagenesArma.length === 0) {
        card.imagenesArma = ["/img/arrow.png"];
      }

      await card.save();
      return res.json({ message: "✅ Carta creada correctamente", card });
    } catch (err) {
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
router.delete("/:id", async (req, res) => {
  try {
    await Card.findByIdAndDelete(req.params.id);
    res.json({ message: "✅ Carta eliminada" });
  } catch (err) {
    console.error("❌ Error al eliminar carta:", err);
    res.status(500).json({ error: "Error al eliminar carta" });
  }
});

// 🧠 Obtener cartas del usuario
router.get("/user-cards/:userId", async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).populate("cartas");
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    res.json(user.cartas);
  } catch (err) {
    console.error("❌ Error al obtener cartas del usuario:", err.message);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// 🧩 Actualizar mazo activo
router.put("/user-cards/:userId", async (req, res) => {
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
router.get("/user-cards/:userId/mazo", async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).populate("mazo");
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    res.json(user.mazo);
  } catch (err) {
    console.error("❌ Error al obtener el mazo:", err.message);
    res.status(500).json({ error: "Error al obtener el mazo" });
  }
});

// 🧽 Ruta para renombrar archivos sin extensión
router.get("/fix-extensions", async (req, res) => {
  const dir = path.join(__dirname, "../uploads/cards");
  let renombrados = [];

  if (!fs.existsSync(dir)) {
    return res.status(404).json({ error: "La carpeta no existe" });
  }

  fs.readdirSync(dir).forEach(file => {
    const ext = path.extname(file);
    if (!ext) {
      const oldPath = path.join(dir, file);
      const newPath = path.join(dir, file + ".png");
      fs.renameSync(oldPath, newPath);
      renombrados.push(`${file} → ${file}.png`);
    }
  });

  res.json({ message: "✅ Archivos renombrados", renombrados });
});

module.exports = router;
