// api/routes/promoContratada.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const PromocionNegocio = require("../models/PromocionNegocio");
const PromocionComprada = require("../models/PromocionComprada");
const Payment = require("../models/Payment");
const User = require("../models/User");

// Storage para el logo del comercio
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = "public/img/logos-comercios";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, `logo_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });

router.post("/", upload.single("logo"), async (req, res) => {
  try {
    const { promoId, lat, lng, duracion, userId } = req.body;

    if (!promoId || !lat || !lng || !duracion || !userId) {
      return res.status(400).json({ error: "Faltan datos requeridos" });
    }

    const promo = await PromocionNegocio.findById(promoId);
    if (!promo) return res.status(404).json({ error: "Promoción no encontrada" });

    const opcion = promo.opcionesDuracion.find(
      (o) => o.duracionMeses === Number(duracion)
    );
    if (!opcion) return res.status(400).json({ error: "Duración no válida" });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    const logoPath = req.file ? `/img/logos-comercios/${req.file.filename}` : null;
    if (!logoPath) return res.status(400).json({ error: "Logo requerido" });

    // 1) Crear pago
    const pago = await Payment.create({
      userId,
      nombre: user.nombre,
      cantidad: opcion.precioEuros,
      fecha: new Date()
    });

    // 2) Crear compra
    const fechaInicio = new Date();
    const fechaFin = new Date();
    fechaFin.setMonth(fechaFin.getMonth() + Number(duracion));

    const compra = await PromocionComprada.create({
      comercioId: userId,
      promoId,
      titulo: promo.titulo,
      imagenBase: promo.imagen,
      logoComercio: logoPath,
      lat: Number(lat),
      lng: Number(lng),
      duracionMeses: Number(duracion),
      precioEuros: opcion.precioEuros,
      fechaInicio,
      fechaFin,
      paymentId: pago._id,
      activo: true
    });

    res.json({ message: "✅ Promoción contratada y pagada", compraId: compra._id });
  } catch (err) {
    console.error("❌ Error contratando promoción:", err);
    res.status(500).json({ error: err.message || "Error al contratar promoción" });
  }
});

// GET /api/promo-contratada/activas
router.get("/activas", async (req, res) => {
  try {
    const ahora = new Date();
    const activas = await PromocionComprada.find({
  activo: true,
  fechaFin: { $gte: ahora },
  logoComercio: { $exists: true, $ne: null },
  imagenBase: { $exists: true, $ne: null },
  lat: { $exists: true, $ne: null },
  lng: { $exists: true, $ne: null },
}).select("-__v");

// Opcional: imprimir resumen para depuración
console.log("✅ Promos activas filtradas:", activas.map(p => ({
  id: p._id,
  logoComercio: p.logoComercio,
  imagenBase: p.imagenBase
})));

    res.json(activas);
  } catch (err) {
    console.error("❌ Error obteniendo promociones activas:", err);
    res.status(500).json({ error: "Error al obtener promociones activas" });
  }
});

module.exports = router;
