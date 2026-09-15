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
const {
  playBillingAvailable,
  getProductPurchase,
  acknowledgeProductPurchase,
} = require('../services/googlePlayBilling');

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

// Catálogo autoritativo del checkout. El cliente solo envía la cantidad
// elegida (o el productId de Play); nunca decide el importe monetario que se
// registra. Debe coincidir 1:1 con generarPaquetesStepcoins() en el cliente
// Flutter (lib/roles/client/store_screen.dart).
const STEPCOIN_PACKAGES_EUR = new Map([
  [100, 1], [500, 4], [1000, 7], [2000, 12],
  [5000, 25], [10000, 45], [15000, 65], [20000, 80],
  [30000, 110], [40000, 130], [50000, 150], [60000, 180],
  [100000, 200],
]);

// Catálogo exclusivo para comercios. Usa el mismo saldo Stepcoins, pero solo
// ofrece los paquetes necesarios para promocionar sus locales físicos.
const MERCHANT_STEPCOIN_PACKAGES_EUR = new Map([
  [1500, 10],
  [15000, 65],
]);

function stepcoinPackagesFor(role) {
  return role === 'comercio'
    ? MERCHANT_STEPCOIN_PACKAGES_EUR
    : STEPCOIN_PACKAGES_EUR;
}

// Product IDs de "managed products" que hay que crear en Play Console →
// Monetiza → Productos dentro de la app. Deben existir con estos mismos IDs
// exactos antes de poder probar compras reales.
const PLAY_PRODUCT_ID_BY_STEPCOINS = new Map([
  [100, 'stepcoins_100'], [500, 'stepcoins_500'],
  [1000, 'stepcoins_1000'], [1500, 'stepcoins_1500'],
  [2000, 'stepcoins_2000'], [5000, 'stepcoins_5000'],
  [10000, 'stepcoins_10000'], [15000, 'stepcoins_15000'],
  [20000, 'stepcoins_20000'], [30000, 'stepcoins_30000'],
  [40000, 'stepcoins_40000'], [50000, 'stepcoins_50000'],
  [60000, 'stepcoins_60000'], [100000, 'stepcoins_100000'],
]);
const STEPCOIN_AMOUNT_BY_PLAY_PRODUCT_ID = new Map(
  Array.from(PLAY_PRODUCT_ID_BY_STEPCOINS, ([stepcoins, id]) => [id, stepcoins]),
);

router.get(
  '/stepcoins/packages',
  verifyToken,
  checkRole(['comercio']),
  (req, res) => res.json(Array.from(stepcoinPackagesFor(req.user.role), ([stepcoins, euros]) => ({
    stepcoins, euros, currency: 'EUR',
    playProductId: PLAY_PRODUCT_ID_BY_STEPCOINS.get(stepcoins) || null,
  }))),
);

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
router.post('/stepcoins/checkout', verifyToken, checkRole(['cliente', 'comercio']), async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(503).json({
      error: 'La compra de Stepcoins no esta disponible hasta verificar el pago real',
      code: 'VERIFIED_PAYMENT_REQUIRED',
    });
  }
  const cantidad = Number(req.body.cantidad);
  const requestId = String(req.body.requestId || '').trim();
  const price = stepcoinPackagesFor(req.user.role).get(cantidad);

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
        { _id: userId, role: req.user.role },
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

// Verificacion server-to-server de una compra real hecha con Google Play
// Billing (Android). El cliente Flutter manda el productId y el purchaseToken
// que recibe de la SDK; nunca la cantidad de Stepcoins ni el importe: ambos
// se resuelven aqui a partir del catalogo autoritativo. purchaseToken es
// unico por compra, así que sirve como clave de idempotencia.
router.post('/stepcoins/verify-play-purchase', verifyToken, checkRole(['cliente', 'comercio']), async (req, res) => {
  if (!playBillingAvailable()) {
    return res.status(503).json({
      error: 'La verificacion de compras de Google Play no esta configurada en el servidor',
      code: 'PLAY_BILLING_NOT_CONFIGURED',
    });
  }

  const productId = String(req.body.productId || '').trim();
  const purchaseToken = String(req.body.purchaseToken || '').trim();
  const cantidad = STEPCOIN_AMOUNT_BY_PLAY_PRODUCT_ID.get(productId);
  const price = cantidad != null ? stepcoinPackagesFor(req.user.role).get(cantidad) : null;

  if (!productId || !purchaseToken || cantidad == null || price == null) {
    return res.status(400).json({ error: 'Producto o token de compra no valido' });
  }

  let purchase;
  try {
    purchase = await getProductPurchase(productId, purchaseToken);
  } catch (error) {
    console.error('❌ Error verificando compra de Google Play:', error?.response?.data || error);
    return res.status(502).json({ error: 'No se pudo verificar la compra con Google Play' });
  }

  // purchaseState: 0 = comprado, 1 = cancelado, 2 = pendiente
  if (purchase.purchaseState !== 0) {
    return res.status(409).json({ error: 'La compra no esta completada', code: 'PURCHASE_NOT_COMPLETED' });
  }

  const userId = String(req.user.id);
  const providerReference = `google-play:${purchaseToken}`;
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
        { _id: userId, role: req.user.role },
        { $inc: { stepcoins: cantidad } },
        { new: true, session },
      ).select('stepcoins nombre nickname email');
      if (!user) throw Object.assign(new Error('Usuario no encontrado'), { status: 404 });

      [payment] = await Payment.create([{
        userId,
        nombre: user.nombre || user.nickname || user.email || 'Usuario',
        cantidad: price,
        stepcoinsDelta: cantidad,
        motivo: `Compra de ${cantidad} Stepcoins (Google Play)`,
        currency: 'EUR',
        fecha: new Date(),
        verified: true,
        verifiedAt: new Date(),
        source: 'payment_provider',
        providerReference,
      }], { session });
      await StepcoinTransaction.create([{
        userId,
        cantidad,
        tipo: 'compra',
        descripcion: `Compra de ${cantidad} Stepcoins (Google Play)`,
        operationKey: `stepcoin-pack:${providerReference}`,
        metadata: {
          paymentId: payment._id, providerReference, price, currency: 'EUR',
          productId, orderId: purchase.orderId || null,
        },
      }], { session });
    });

    if (!duplicate) {
      try {
        await acknowledgeProductPurchase(productId, purchaseToken);
      } catch (error) {
        console.error('⚠️ No se pudo confirmar (acknowledge) la compra en Google Play:', error?.response?.data || error);
      }
    }

    return res.status(duplicate ? 200 : 201).json({
      message: duplicate ? 'Compra ya procesada' : 'Compra completada',
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
    console.error('❌ Error verificando compra de Stepcoins vía Google Play:', error);
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
