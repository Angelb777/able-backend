// api/routes/ubicaciones.js

const express = require("express");
const router = express.Router();
const UbicacionVisible = require("../models/UbicacionVisible");
const { publicNickname } = require('../utils/publicIdentity');

// 👉 POST /api/ubicaciones/compartir → Crear o actualizar tu ubicación visible
router.post("/compartir", async (req, res) => {
  try {
    const { userId, lat, lng } = req.body;
    if (!userId || lat == null || lng == null) {
      return res.status(400).json({ error: "Faltan campos requeridos" });
    }

    const actualizada = await UbicacionVisible.findOneAndUpdate(
      { userId },
      { lat, lng, actualizadoEn: new Date() },
      { upsert: true, new: true }
    );

    res.json(actualizada);
  } catch (err) {
    console.error("❌ Error al compartir ubicación:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// 👉 GET /api/ubicaciones → Obtener todas las ubicaciones visibles (últimos 60s)
router.get("/", async (req, res) => {
  try {
    const haceUnMinuto = new Date(Date.now() - 60000); // últimos 60s
    const visibles = await UbicacionVisible.find({
      actualizadoEn: { $gte: haceUnMinuto }
    }).populate("userId", "nickname").lean();

    res.json(visibles.map((item) => ({
      id: String(item._id),
      user: item.userId ? {
        id: String(item.userId._id),
        nickname: publicNickname(item.userId),
      } : null,
      lat: item.lat,
      lng: item.lng,
      actualizadoEn: item.actualizadoEn,
    })));
  } catch (err) {
    console.error("❌ Error al obtener ubicaciones visibles:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// 👉 DELETE /api/ubicaciones/:userId → Dejar de compartir ubicación
router.delete("/:userId", async (req, res) => {
  try {
    await UbicacionVisible.findOneAndDelete({ userId: req.params.userId });
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Error al eliminar ubicación:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

module.exports = router;
