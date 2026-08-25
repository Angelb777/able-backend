const express = require("express");
const router = express.Router();
const Payment = require("../models/Payment");
const User = require("../models/User");
const mongoose = require("mongoose");
const {
  verifyToken,
  checkRole,
  requireSelfOrAdmin,
} = require('../middlewares/authMiddleware');

const adminOnly = [verifyToken, checkRole(['admin'])];

// Crear un registro monetario manual. Solo Superadmin puede certificarlo.
router.post("/", ...adminOnly, async (req, res) => {
  const { userId, cantidad } = req.body;
  const amount = Number(cantidad);

  if (!mongoose.Types.ObjectId.isValid(userId) || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "El usuario y un importe positivo son obligatorios" });
  }

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    const now = new Date();
    const pago = new Payment({
      userId,
      nombre: user.nombre || user.nickname || user.email || 'Usuario',
      cantidad: amount,
      fecha: now,
      verified: true,
      verifiedAt: now,
      source: 'admin_manual',
    });

    await pago.save();
    res.status(201).json({ message: "Pago registrado correctamente" });
  } catch (err) {
    console.error("❌ Error al registrar pago:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// Obtener pagos
router.get("/", ...adminOnly, async (req, res) => {
  try {
    const pagos = await Payment.find().sort({ fecha: -1 }); // ⬅️ usamos "fecha"
    res.json(pagos);
  } catch (err) {
    console.error("❌ Error al obtener pagos:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

// Obtener pagos por userId (para cliente)
router.get("/:userId", verifyToken, requireSelfOrAdmin('userId'), async (req, res) => {
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
