// routes/promocionesNegocio.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const PromocionNegocio = require("../models/PromocionNegocio");

// 🖼 Carpeta donde se guardarán las imágenes
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = "public/img/promociones";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, `promo_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });

// ✅ Crear nueva promoción (admin)
router.post("/", upload.single("imagen"), async (req, res) => {
  try {
    const { titulo, descripcion, opcionesDuracion, fechaExpiracionMaxima } = req.body;
    const imagen = req.file?.path.replace("public", "");

    const opciones = JSON.parse(opcionesDuracion); // [{ duracionMeses: 1, precioEuros: 10 }, ...]

    const nuevaPromo = new PromocionNegocio({
      titulo,
      descripcion,
      imagen,
      opcionesDuracion: opciones,
      fechaExpiracionMaxima: new Date(fechaExpiracionMaxima)
    });

    await nuevaPromo.save();
    res.status(200).json({ message: "✅ Promoción creada correctamente" });
  } catch (err) {
    console.error("❌ Error al crear promoción:", err);
    res.status(500).json({ error: "Error al crear promoción" });
  }
});

// 📥 Obtener todas las promociones activas (para comercios)
router.get("/", async (req, res) => {
  try {
    const hoy = new Date();
    const promos = await PromocionNegocio.find({
      fechaExpiracionMaxima: { $gte: hoy }
    });
    res.json(promos);
  } catch (err) {
    console.error("❌ Error al obtener promociones:", err);
    res.status(500).json({ error: "Error al obtener promociones" });
  }
});

// 🗑️ Eliminar una promoción por ID
router.delete("/:id", async (req, res) => {
  try {
    const promo = await PromocionNegocio.findByIdAndDelete(req.params.id);
    if (!promo) return res.status(404).json({ error: "Promoción no encontrada" });

    // ✅ Borrar también las promociones contratadas asociadas
    await PromoContratada.deleteMany({ promoId: req.params.id });

    // ✅ Borrar imagen de la promo (si existe)
    const rutaPromo = path.join(__dirname, "..", "..", "public", promo.imagen);
    if (promo.imagen && fs.existsSync(rutaPromo)) {
      fs.unlinkSync(rutaPromo);
    }

    // ✅ Borrar logo del comercio (si existe)
    const rutaLogo = path.join(__dirname, "..", "..", "public", promo.logoComercio);
    if (promo.logoComercio && fs.existsSync(rutaLogo)) {
      fs.unlinkSync(rutaLogo);
    }

    res.json({ message: "✅ Promoción y contrataciones eliminadas correctamente" });
  } catch (err) {
    console.error("❌ Error al eliminar promoción:", err);
    res.status(500).json({ error: "Error al eliminar promoción" });
  }
});

module.exports = router;
