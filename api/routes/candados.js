const express = require("express");
const router = express.Router();
const Candado = require("../models/Candado");
const CandadoLog = require("../models/CandadoLog");
const { verifyToken } = require("../middlewares/authMiddleware");

// ✅ Obtener todos los candados del usuario actual
router.get("/", verifyToken, async (req, res) => {
  try {
    const candados = await Candado.find({ creadoPor: req.user.id });
    res.json(candados);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Registrar o adjudicar candado
router.post("/", verifyToken, async (req, res) => {
  try {
    const { mac, nombre, nombreBLE, password } = req.body;
    if (!mac || !nombre || !nombreBLE || !password) {
      return res.status(400).json({ error: "Faltan campos obligatorios" });
    }

    const macUp = mac.toUpperCase();
    let candado = await Candado.findOne({ mac: macUp });

    if (!candado) {
      // Crear nuevo
      candado = new Candado({
        mac: macUp,
        nombre,
        nombreBLE,
        password,
        creadoPor: req.user.id,
      });
      await candado.save();
      return res.json(candado);
    }

    // Si tiene dueño distinto, bloquear
    if (candado.creadoPor && String(candado.creadoPor) !== req.user.id) {
      return res.status(403).json({ error: "Este candado ya pertenece a otro usuario." });
    }

    // Adjudicar si está liberado
    candado.nombre = nombre;
    candado.nombreBLE = nombreBLE;
    candado.password = password;
    candado.creadoPor = req.user.id;
    await candado.save();

    res.json(candado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ✅ Liberar candado
router.post("/liberar/:mac", verifyToken, async (req, res) => {
  try {
    const macUp = req.params.mac.toUpperCase();
    const candado = await Candado.findOne({ mac: macUp, creadoPor: req.user.id });

    if (!candado) return res.status(404).json({ error: "Candado no encontrado." });

    candado.creadoPor = null;
    candado.visibleEnMapa = false;
    candado.releasedAt = new Date();
    await candado.save();

    await CandadoLog.create({
      candadoId: candado._id,
      usuarioId: req.user.id,
      accion: "liberar",
    });

    res.json({ ok: true, mensaje: "Candado liberado correctamente." });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ✅ Registrar evento (abrir/cerrar) y opcionalmente ubicación
router.post("/log", verifyToken, async (req, res) => {
  try {
    const { candadoId, accion, lat, lng, detalle } = req.body;

    await CandadoLog.create({
      candadoId,
      accion,
      usuarioId: req.user.id,
      lat,
      lng,
      detalle
    });

    if (accion === "abrir" && lat != null && lng != null) {
      const candado = await Candado.findById(candadoId);
      if (candado && String(candado.creadoPor) === req.user.id) {
        candado.lastLat = lat;
        candado.lastLng = lng;
        candado.lastSeenAt = new Date();
        await candado.save();
      }
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ✅ Obtener logs por candado
router.get("/log/:id", verifyToken, async (req, res) => {
  try {
    const logs = await CandadoLog.find({ candadoId: req.params.id })
      .populate("usuarioId", "nombre")
      .sort({ createdAt: -1 });
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Guardar posición actual del candado
router.post("/:mac/posicion", verifyToken, async (req, res) => {
  try {
    const macUp = req.params.mac.toUpperCase();
    let { lat, lng } = req.body;

    lat = Number(lat);
    lng = Number(lng);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      return res.status(400).json({ error: "Faltan lat/lng válidos" });
    }

    const candado = await Candado.findOne({ mac: macUp, creadoPor: req.user.id });
    if (!candado) return res.status(403).json({ error: "No tienes permiso para modificar este candado" });

    candado.lastLat = lat;
    candado.lastLng = lng;
    candado.lastSeenAt = new Date();
    await candado.save();

    CandadoLog.create({
      candadoId: candado._id,
      usuarioId: req.user.id,
      accion: "posicion",
      lat,
      lng
    }).catch(err => console.warn("⚠️ Falló crear log:", err?.message));

    res.json({ ok: true, lastLat: candado.lastLat, lastLng: candado.lastLng, lastSeenAt: candado.lastSeenAt });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ✅ Cambiar visibilidad
router.patch("/:mac/visibilidad", verifyToken, async (req, res) => {
  try {
    const macUp = req.params.mac.toUpperCase();
    const { visible } = req.body;

    const candado = await Candado.findOne({ mac: macUp, creadoPor: req.user.id });
    if (!candado) return res.status(403).json({ error: "No tienes permiso para modificar este candado" });

    candado.visibleEnMapa = !!visible;
    await candado.save();
    res.json({ ok: true, visibleEnMapa: candado.visibleEnMapa });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ✅ Candados visibles (público)
router.get("/publico/visibles", async (_req, res) => {
  try {
    const visibles = await Candado.find({
      visibleEnMapa: true,
      lastLat: { $ne: null },
      lastLng: { $ne: null }
    }).select("nombre mac lastLat lastLng lastSeenAt");

    res.json(visibles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Última posición
router.get("/:mac/ultima-posicion", verifyToken, async (req, res) => {
  try {
    const macUp = req.params.mac.toUpperCase();
    const candado = await Candado.findOne({ mac: macUp, creadoPor: req.user.id });
    if (!candado) {
      return res.status(404).json({ error: "Candado no encontrado" });
    }
    if (candado.lastLat == null || candado.lastLng == null) {
      return res.status(404).json({ error: "Sin ubicación registrada" });
    }

    res.json({
      lat: candado.lastLat,
      lng: candado.lastLng,
      lastSeenAt: candado.lastSeenAt
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
