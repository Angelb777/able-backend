const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Projectile = require("../models/Projectile"); // ⬅️ este lo creamos ahora
const Card = require("../models/Card");
const { verifyToken } = require('../middlewares/authMiddleware');
const { authenticatedUserKey, createLimiter } = require('../middlewares/securityLimits');
const projectileLimiter = createLimiter({
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: authenticatedUserKey,
  code: 'PROJECTILE_RATE_LIMITED',
});

// 🚀 Disparar un proyectil
router.post("/", verifyToken, projectileLimiter, async (req, res) => {
  try {
    const { destino, cartaId, origen } = req.body;
    const userId = String(req.user.id);

    if (!userId || !destino || !cartaId || !origen) {
      return res.status(400).json({ error: "Faltan datos necesarios" });
    }

    const validPoint = (point) => point && Number.isFinite(Number(point.lat)) &&
      Number.isFinite(Number(point.lng)) && Number(point.lat) >= -90 &&
      Number(point.lat) <= 90 && Number(point.lng) >= -180 && Number(point.lng) <= 180;
    if (!validPoint(origen) || !validPoint(destino)) {
      return res.status(400).json({ error: 'Coordenadas no validas' });
    }
    const [carta, owner] = await Promise.all([
      Card.findById(cartaId),
      User.findOne({ _id: userId, cartas: cartaId }).select('_id').lean(),
    ]);
    if (!carta) return res.status(404).json({ error: "Carta no encontrada" });
    if (!owner) return res.status(403).json({ error: 'No posees esta carta' });

    if (carta.tipoArma !== "Proyectil") {
      return res.status(400).json({ error: "Esta carta no es de tipo proyectil" });
    }

    // ⏱️ Aquí podrías validar cooldown más adelante

    // 💾 Guardar proyectil en la base de datos
    const nuevoDisparo = new Projectile({
      userId,
      cartaId,
      origen,
      destino,
      creadoEn: new Date(),
    });

    await nuevoDisparo.save();

    res.json({
      message: "✅ Disparo registrado correctamente",
      proyectil: nuevoDisparo,
      imagenProyectil: carta.imagenesArma?.[0] || "/img/arrow.png",
      alcance: carta.alcance,
      dano: carta.dano,
      tiempoEspera: carta.tiempoEspera,
    });
  } catch (err) {
    console.error("❌ Error al registrar disparo:", err.message);
    res.status(500).json({ error: "Error interno al disparar" });
  }
});

module.exports = router;
