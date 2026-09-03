const express = require("express");
const router = express.Router();
const Payment = require("../models/Payment");
const StepcoinTransaction = require("../models/StepcoinTransaction");
const User = require("../models/User");
const mongoose = require("mongoose");
const {
  verifyToken,
  checkRole,
  requireSelfOrAdmin,
} = require('../middlewares/authMiddleware');

const adminOnly = [verifyToken, checkRole(['admin'])];

function paymentEntry(payment) {
  return { ...payment, entryType: 'money', stepcoinsDelta: Number(payment.stepcoinsDelta || 0) };
}

async function monetaryHistory(userId) {
  const paymentFilter = userId ? { userId } : {};
  const payments = await Payment.find(paymentFilter).lean();
  return payments.map(paymentEntry)
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
}

// Catálogo autoritativo del checkout provisional. El cliente solo envía la
// cantidad elegida; nunca decide el importe monetario que se registra.
const STEPCOIN_PACKAGES_EUR = new Map([
  [100, 1], [500, 4], [1000, 7], [2000, 12],
  [5000, 25], [10000, 45], [15000, 65], [20000, 80],
  [30000, 110], [40000, 130], [50000, 150], [60000, 180],
]);

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

// Checkout simulado para la tienda de Stepcoins. Esta ruta representa el
// punto que en el futuro confirmará Google Play/Apple/TPV. Hasta entonces,
// registra un pago verificado de plataforma y abona el paquete en una sola
// transacción. requestId hace que los reintentos no dupliquen la compra.
router.post('/stepcoins/checkout', verifyToken, checkRole(['cliente']), async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(503).json({
      error: 'La compra de Stepcoins no esta disponible hasta verificar el pago real',
      code: 'VERIFIED_PAYMENT_REQUIRED',
    });
  }
  const cantidad = Number(req.body.cantidad);
  const requestId = String(req.body.requestId || '').trim();
  const price = STEPCOIN_PACKAGES_EUR.get(cantidad);

  if (!Number.isInteger(cantidad) || price == null) {
    return res.status(400).json({ error: 'Paquete de Stepcoins no válido' });
  }
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(requestId)) {
    return res.status(400).json({ error: 'requestId de compra no válido' });
  }

  const userId = String(req.user.id);
  const providerReference = `stepcoins-sim:${userId}:${requestId}`;
  const session = await mongoose.startSession();
  let user;
  let payment;
  let duplicate = false;

  try {
    await session.withTransaction(async () => {
      payment = await Payment.findOne({ providerReference }).session(session);
      if (payment) {
        duplicate = true;
        user = await User.findById(userId).select('stepcoins').session(session);
        return;
      }

      user = await User.findOneAndUpdate(
        { _id: userId, role: 'cliente' },
        { $inc: { stepcoins: cantidad } },
        { new: true, session },
      ).select('stepcoins nombre nickname email');
      if (!user) throw Object.assign(new Error('Usuario no encontrado'), { status: 404 });

      [payment] = await Payment.create([{
        userId,
        nombre: user.nombre || user.nickname || user.email || 'Usuario',
        cantidad: price,
        stepcoinsDelta: cantidad,
        motivo: `Compra simulada de ${cantidad} Stepcoins`,
        currency: 'EUR',
        fecha: new Date(),
        verified: true,
        verifiedAt: new Date(),
        source: 'platform_checkout',
        providerReference,
      }], { session });
      await StepcoinTransaction.create([{
        userId,
        cantidad,
        tipo: 'compra',
        descripcion: `Compra de ${cantidad} Stepcoins`,
        operationKey: `stepcoin-pack:${providerReference}`,
        metadata: { paymentId: payment._id, providerReference, price, currency: 'EUR' },
      }], { session });
    });

    return res.status(duplicate ? 200 : 201).json({
      message: duplicate ? 'Compra ya procesada' : 'Compra simulada completada',
      duplicate,
      payment,
      user: { stepcoins: Number(user.stepcoins) },
    });
  } catch (error) {
    if (error?.code === 11000) {
      const previous = await Payment.findOne({ providerReference });
      const current = await User.findById(userId).select('stepcoins');
      return res.json({
        message: 'Compra ya procesada', duplicate: true,
        payment: previous, user: { stepcoins: Number(current?.stepcoins || 0) },
      });
    }
    console.error('❌ Error en checkout simulado de Stepcoins:', error);
    return res.status(error.status || 500).json({
      error: error.status ? error.message : 'Error interno al procesar la compra',
    });
  } finally {
    await session.endSession();
  }
});

// Obtener pagos
router.get("/", ...adminOnly, async (req, res) => {
  try {
    res.json(await monetaryHistory());
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
    res.json(await monetaryHistory(new mongoose.Types.ObjectId(userId)));
  } catch (err) {
    console.error("❌ Error al obtener pagos del cliente:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

module.exports = router;
