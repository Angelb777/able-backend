const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Projectile = require("../models/Projectile"); // ⬅️ este lo creamos ahora
const Card = require("../models/Card");

// 🚀 Disparar un proyectil
router.post("/", async (req, res) => {
  try {
    const { userId, destino, cartaId, origen } = req.body;

    if (!userId || !destino || !cartaId || !origen) {
      return res.status(400).json({ error: "Faltan datos necesarios" });
    }

    const carta = await Card.findById(cartaId);
    if (!carta) return res.status(404).json({ error: "Carta no encontrada" });

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
