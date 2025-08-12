const express = require("express");
const router = express.Router();
const Payment = require("../models/Payment");
const User = require("../models/User");

// Crear pago
router.post("/", async (req, res) => {
  const { userId, cantidad } = req.body;

  if (!userId || !cantidad) {
    return res.status(400).json({ error: "Faltan datos requeridos" });
  }

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    const pago = new Payment({
      userId,
      nombre: user.nombre,
      cantidad,
      fecha: new Date(), // ⬅️ esto asegura que se guarde bien
    });

    await pago.save();
    res.status(201).json({ message: "Pago registrado correctamente" });
  } catch (err) {
    console.error("❌ Error al registrar pago:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// Obtener pagos
router.get("/", async (req, res) => {
  try {
    const pagos = await Payment.find().sort({ fecha: -1 }); // ⬅️ usamos "fecha"
    res.json(pagos);
  } catch (err) {
    console.error("❌ Error al obtener pagos:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

// Obtener pagos por userId (para cliente)
const mongoose = require("mongoose");

router.get("/:userId", async (req, res) => {
  const { userId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return res.status(400).json({ error: "ID de usuario inválido" });
  }

  try {
    const pagos = await Payment.find({ userId: new mongoose.Types.ObjectId(userId) }).sort({ fecha: -1 });
    res.json(pagos);
  } catch (err) {
    console.error("❌ Error al obtener pagos del cliente:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

module.exports = router;
