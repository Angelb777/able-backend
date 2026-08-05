const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const Skin = require("../models/Skin");
const User = require("../models/User");

const UPLOAD_BASE_DIR =
  process.env.UPLOAD_BASE_DIR || path.join(__dirname, "../../uploads");
const SKINS_DIR = path.join(UPLOAD_BASE_DIR, "skins");

if (!fs.existsSync(SKINS_DIR)) {
  fs.mkdirSync(SKINS_DIR, { recursive: true });
}

const publicPath = (filename) => `/uploads/skins/${filename}`;
const ACTIONS = [
  { key: "idle", legacy: "parado" },
  { key: "walk", legacy: "moviendose" },
  { key: "shoot", legacy: "disparando" },
  { key: "die", legacy: "muriendo" },
  { key: "run", legacy: "rapido" },
  { key: "damage", legacy: "recibiendoDano" },
  { key: "getUp", legacy: "reapareciendo" }
];

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, SKINS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, unique + ext);
  }
});

const animationFields = new Set(ACTIONS.flatMap(({ key, legacy }) => [key, legacy]));
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (animationFields.has(file.fieldname)) {
      const isPng = file.mimetype === "image/png" &&
        path.extname(file.originalname).toLowerCase() === ".png";
      return cb(isPng ? null : new Error("Cada animación debe ser un PNG"), isPng);
    }
    cb(file.mimetype.startsWith("image/") ? null : new Error("Portada no válida"),
      file.mimetype.startsWith("image/"));
  }
});

const uploadFields = upload.fields([
  { name: "portada", maxCount: 1 },
  ...ACTIONS.flatMap(({ key, legacy }) => [
    { name: key, maxCount: 1 },
    { name: legacy, maxCount: 1 }
  ])
]);

function asBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === "true" || value === "1" || value === "on";
}

function pngDimensions(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(24);
    fs.readSync(fd, header, 0, header.length, 0);
    const pngSignature = "89504e470d0a1a0a";
    if (header.subarray(0, 8).toString("hex") !== pngSignature) {
      throw new Error("El archivo no es un PNG válido");
    }
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}

function parseConfig(raw, action, url, uploadedFile, previous = null) {
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (_) {
    throw new Error(`Configuración JSON no válida para ${action}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Falta configuración para ${action}`);
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
    throw new Error(`Columnas, filas, frames y FPS/tiempo son obligatorios para ${action}`);
  }

  let dimensions = null;
  if (uploadedFile) dimensions = pngDimensions(uploadedFile.path);
  const sourceWidth = dimensions?.width || previous?.sourceWidth;
  const sourceHeight = dimensions?.height || previous?.sourceHeight;
  if (sourceWidth && sourceWidth % columns !== 0) {
    throw new Error(`${action}: el ancho ${sourceWidth}px no es divisible entre ${columns} columnas`);
  }
  if (sourceHeight && sourceHeight % rows !== 0) {
    throw new Error(`${action}: el alto ${sourceHeight}px no es divisible entre ${rows} filas`);
  }

  const multipleOrientations = asBoolean(parsed.multipleOrientations, false);
  if (frames > (multipleOrientations ?
      (parsed.readOrder === "column-major" ? rows : columns) : columns * rows)) {
    throw new Error(`${action}: frames supera la cuadrícula configurada`);
  }

  const orientationRows = Array.isArray(parsed.orientationRows)
    ? parsed.orientationRows.map(String)
    : String(parsed.orientationRows || "")
      .split(",").map(value => value.trim()).filter(Boolean);
  const frameOrder = Array.isArray(parsed.frameOrder)
    ? parsed.frameOrder.map(Number).filter(Number.isInteger)
    : String(parsed.frameOrder || "")
      .split(",").map(Number).filter(Number.isInteger);

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
    loop: asBoolean(parsed.loop, true),
    multipleOrientations,
    readOrder: parsed.readOrder || "row-major",
    orientationRows,
    frameOrder
  };
}

function firstFile(files, action) {
  return files[action.key]?.[0] || files[action.legacy]?.[0] || null;
}

async function saveSkin(req, res, existing = null) {
  try {
    const files = req.files || {};
    const renderType = req.body.renderType === "flame_spritesheet"
      ? "flame_spritesheet"
      : "classic";
    const portadaFile = files.portada?.[0];
    const portada = portadaFile
      ? publicPath(portadaFile.filename)
      : existing?.portada;
    if (!portada) return res.status(400).json({ error: "La portada es obligatoria" });

    const scripts = existing?.scripts?.toObject?.() || existing?.scripts || {};
    for (const { legacy } of ACTIONS) {
      if (!Array.isArray(scripts[legacy])) scripts[legacy] = [];
    }
    const spritesheets = existing?.spritesheets?.toObject?.() ||
      existing?.spritesheets || {};

    for (const action of ACTIONS) {
      const uploadedFile = firstFile(files, action);
      const url = uploadedFile ? publicPath(uploadedFile.filename) :
        spritesheets[action.key]?.url;
      if (uploadedFile) scripts[action.legacy] = [url];

      if (renderType !== "flame_spritesheet") continue;
      const rawConfig = req.body[`config_${action.key}`];
      if (!uploadedFile && !rawConfig) continue;
      spritesheets[action.key] = parseConfig(
        rawConfig,
        action.key,
        url,
        uploadedFile,
        spritesheets[action.key]
      );
    }

    if (renderType === "flame_spritesheet" && !spritesheets.idle?.url) {
      return res.status(400).json({ error: "Idle y su configuración son obligatorios" });
    }

    const skin = existing || new Skin();
    skin.titulo = req.body.titulo ?? skin.titulo;
    skin.descripcion = req.body.descripcion ?? skin.descripcion;
    skin.precio = req.body.precio ?? skin.precio;
    skin.portada = portada;
    skin.scripts = scripts;
    skin.renderType = renderType;
    skin.renderVersion = renderType === "flame_spritesheet" ? 2 : 1;
    skin.spritesheets = spritesheets;
    await skin.save();

    res.status(existing ? 200 : 201).json({
      message: existing ? "Skin actualizada correctamente" : "Skin creada correctamente",
      skin
    });
  } catch (err) {
    console.error("Error al guardar skin:", err);
    res.status(400).json({ error: err.message || "Error al guardar skin" });
  }
}

router.post("/", uploadFields, (req, res) => saveSkin(req, res));

router.get("/", async (_req, res) => {
  try {
    res.json(await Skin.find().sort({ fechaCreacion: -1 }));
  } catch (_) {
    res.status(500).json({ error: "Error al obtener skins" });
  }
});

router.get("/validadas", async (_req, res) => {
  try {
    res.json(await Skin.find({ validada: true }));
  } catch (_) {
    res.status(500).json({ error: "Error al obtener skins" });
  }
});

router.put("/:id", uploadFields, async (req, res) => {
  try {
    const skin = await Skin.findById(req.params.id);
    if (!skin) return res.status(404).json({ error: "Skin no encontrada" });
    return saveSkin(req, res, skin);
  } catch (err) {
    res.status(400).json({ error: err.message || "Error al actualizar skin" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    await Skin.findByIdAndDelete(req.params.id);
    res.json({ message: "Skin eliminada correctamente" });
  } catch (_) {
    res.status(500).json({ error: "Error al eliminar skin" });
  }
});

router.get("/seleccionada/:userId", async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).populate("skinSeleccionada");
    if (!user?.skinSeleccionada) {
      return res.status(404).json({ error: "Usuario o skin no encontrada" });
    }
    const skin = user.skinSeleccionada;
    const skinUrl = skin.portada || skin.scripts?.parado?.[0] || "";
    if (!skinUrl) return res.status(404).json({ error: "Skin seleccionada sin imagen" });
    res.json({ skinUrl, skin });
  } catch (_) {
    res.status(500).json({ error: "Error al obtener skin seleccionada" });
  }
});

module.exports = router;
