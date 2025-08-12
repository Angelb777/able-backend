const express = require("express");
const router = express.Router();
const Candado = require("../models/Candado");
const CandadoLog = require("../models/CandadoLog");

// ✅ Obtener todos los candados del usuario actual
router.get("/", async (req, res) => {
  try {
    const candados = await Candado.find({ creadoPor: req.user?.id });
    res.json(candados);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Registrar un nuevo candado (solo si no está registrado por otro usuario)
router.post("/", async (req, res) => {
  try {
    const { mac } = req.body;
    const macUp = (mac || "").toUpperCase();

    const existente = await Candado.findOne({ mac: macUp });
    if (existente && String(existente.creadoPor) !== (req.user?.id || "")) {
      return res.status(403).json({ error: "Este candado ya pertenece a otro usuario." });
    }

    // Si ya existe y es del mismo usuario, no lo dupliques
    if (existente) {
      return res.json(existente);
    }

    const nuevo = new Candado({
      ...req.body,
      mac: macUp,
      creadoPor: req.user?.id,
    });
    const guardado = await nuevo.save();
    res.json(guardado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ✅ Liberar candado (solo el dueño puede hacerlo)
router.post("/liberar/:mac", async (req, res) => {
  try {
    const macUp = (req.params.mac || "").toUpperCase();
    const candado = await Candado.findOne({ mac: macUp, creadoPor: req.user?.id });

    if (!candado) return res.status(404).json({ error: "Candado no encontrado." });

    if (String(candado.creadoPor) !== (req.user?.id || "")) {
      return res.status(403).json({ error: "No tienes permiso para liberar este candado." });
    }

    candado.creadoPor = null;
    candado.visibleEnMapa = false;
    candado.releasedAt = new Date();
    await candado.save();

    await CandadoLog.create({
      candadoId: candado._id,
      usuarioId: req.user?.id,
      accion: "liberar",
    });

    res.json({ ok: true, mensaje: "Candado liberado correctamente." });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ✅ Registrar evento (abrir/cerrar) y opcionalmente ubicación
router.post("/log", async (req, res) => {
  try {
    const { candadoId, accion, lat, lng, detalle } = req.body;

    // Guardar log siempre
    await CandadoLog.create({
      candadoId,
      accion,
      usuarioId: req.user?.id,
      lat,
      lng,
      detalle
    });

    // Si es "abrir" y hay coords, actualiza el candado
    if (accion === "abrir" && lat != null && lng != null) {
      const candado = await Candado.findById(candadoId);
      if (candado && String(candado.creadoPor) === (req.user?.id || "")) {
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
router.get("/log/:id", async (req, res) => {
  try {
    const logs = await CandadoLog.find({ candadoId: req.params.id })
      .populate("usuarioId", "nombre")
      .sort({ createdAt: -1 });
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Guardar posición actual del candado por MAC (se llama al abrir)
// POST /api/candados/:mac/posicion
// POST /api/candados/:mac/posicion
router.post("/:mac/posicion", async (req, res) => {
  try {
    const macUp = (req.params.mac || "").toUpperCase();
    let { lat, lng } = req.body;

    lat = lat !== undefined ? Number(lat) : null;
    lng = lng !== undefined ? Number(lng) : null;
    if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) {
      return res.status(400).json({ error: "Faltan lat/lng válidos" });
    }

    const candado = await Candado.findOne({ mac: macUp, creadoPor: req.user?.id });
    if (!candado) return res.status(403).json({ error: "No tienes permiso para modificar este candado" });

    candado.lastLat = lat;
    candado.lastLng = lng;
    candado.lastSeenAt = new Date();
    await candado.save();

    // 🔐 Log en “best effort”: NO bloquea la respuesta si falta usuarioId
    const uid = req.user?.id || candado.creadoPor || null;
    if (uid) {
      CandadoLog.create({
        candadoId: candado._id,
        usuarioId: uid,
        accion: "posicion",
        lat, lng
      }).catch(err => console.warn("⚠️ Falló crear log:", err?.message));
    } else {
      console.warn("⚠️ Sin usuarioId para log de posición");
    }

    console.log("✅ Posición guardada:", macUp, lat, lng, "por", uid);
    res.json({ ok: true, lastLat: candado.lastLat, lastLng: candado.lastLng, lastSeenAt: candado.lastSeenAt });
  } catch (err) {
    console.error("❌ Error /posicion:", err);
    res.status(400).json({ error: err.message });
  }
});


// ✅ Cambiar visibilidad del candado en el mapa (solo dueño)
router.patch("/:mac/visibilidad", async (req, res) => {
  try {
    const macUp = (req.params.mac || "").toUpperCase();
    const { visible } = req.body;

    const candado = await Candado.findOne({ mac: macUp, creadoPor: req.user?.id });
    if (!candado) return res.status(403).json({ error: "No tienes permiso para modificar este candado" });

    candado.visibleEnMapa = !!visible;
    await candado.save();
    res.json({ ok: true, visibleEnMapa: candado.visibleEnMapa });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


// ✅ Listar candados visibles con coordenadas para el mapa (público o autorizado)
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

// ✅ Última posición por MAC (para dueño)
router.get("/:mac/ultima-posicion", async (req, res) => {
  try {
    const macUp = (req.params.mac || "").toUpperCase();

    // Buscar candado solo del usuario autenticado
    const candado = await Candado.findOne({ mac: macUp, creadoPor: req.user?.id });
    if (!candado) {
      return res.status(404).json({ error: "Candado no encontrado" });
    }

    // Verificar que tenga ubicación
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
