const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const Skin = require("../models/Skin");
const User = require("../models/User"); // para /seleccionada/:userId

// === Base de subidas unificada con server.js ===
// - Local:   <repo>/uploads
// - Producción (Render): /data/uploads   (define UPLOAD_BASE_DIR=/data/uploads)
const UPLOAD_BASE_DIR =
  process.env.UPLOAD_BASE_DIR || path.join(__dirname, "../../uploads");
const SKINS_DIR = path.join(UPLOAD_BASE_DIR, "skins");

// Asegurar carpeta
if (!fs.existsSync(SKINS_DIR)) {
  fs.mkdirSync(SKINS_DIR, { recursive: true });
  console.log("📁 Carpeta creada:", SKINS_DIR);
}

// Helper para la ruta pública que guardamos en Mongo
const publicPath = (filename) => `/uploads/skins/${filename}`;

// Configuración de multer para guardar en disco persistente
const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, SKINS_DIR);
  },
  filename: function (_req, file, cb) {
    const ext = path.extname(file.originalname);
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + ext);
  }
});

const upload = multer({ storage });

// Crear skin
router.post(
  "/",
  upload.fields([
    { name: "portada", maxCount: 1 },
    { name: "muriendo", maxCount: 4 },
    { name: "moviendose", maxCount: 4 },
    { name: "parado", maxCount: 4 },
    { name: "disparando", maxCount: 4 },
    { name: "rapido", maxCount: 4 },
  ]),
  async (req, res) => {
    try {
      const { titulo, descripcion, precio } = req.body;
      const files = req.files || {};

      const portada = files.portada?.[0]?.filename
        ? publicPath(files.portada[0].filename)
        : "";

      const categorias = ["muriendo", "moviendose", "parado", "disparando", "rapido"];
      const scripts = {};
      for (const cat of categorias) {
        scripts[cat] = (files[cat] || []).map(f => publicPath(f.filename));
      }

      const nuevaSkin = new Skin({
        titulo,
        descripcion,
        precio,
        portada,
        scripts,
        validada: false // por defecto
      });

      await nuevaSkin.save();
      res.status(201).json({ message: "✅ Skin creada correctamente", skin: nuevaSkin });
    } catch (err) {
      console.error("❌ Error al crear skin:", err);
      res.status(500).json({ error: "Error al crear skin" });
    }
  }
);

// Obtener todas las skins
router.get("/", async (_req, res) => {
  try {
    const skins = await Skin.find().sort({ fechaCreacion: -1 });
    res.json(skins);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener skins" });
  }
});

// Obtener solo las validadas
router.get("/validadas", async (_req, res) => {
  try {
    const skins = await Skin.find({ validada: true });
    res.json(skins);
  } catch (err) {
    console.error("❌ Error al obtener skins validadas:", err);
    res.status(500).json({ error: "Error al obtener skins" });
  }
});

// Eliminar skin
router.delete("/:id", async (req, res) => {
  try {
    await Skin.findByIdAndDelete(req.params.id);
    res.json({ message: "✅ Skin eliminada correctamente" });
  } catch (err) {
    res.status(500).json({ error: "Error al eliminar skin" });
  }
});

// Obtener la URL de la skin seleccionada del usuario
router.get("/seleccionada/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const user = await User.findById(userId).populate("skinSeleccionada");

    if (!user || !user.skinSeleccionada) {
      return res.status(404).json({ error: "Usuario o skin no encontrada" });
    }

    const portada = user.skinSeleccionada?.portada
      || user.skinSeleccionada?.scripts?.parado?.[0]
      || "";

    if (!portada) {
      return res.status(404).json({ error: "Skin seleccionada sin imagen" });
    }

    res.json({ skinUrl: portada });
  } catch (err) {
    console.error("❌ Error al obtener skin seleccionada:", err);
    res.status(500).json({ error: "Error al obtener skin seleccionada" });
  }
});

module.exports = router;
