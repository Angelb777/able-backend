const express = require('express');
const multer = require('multer');
const router = express.Router();
const PromocionNegocio = require('../models/PromocionNegocio');
const { verifyToken, checkRole } = require('../middlewares/authMiddleware');
const { saveImage } = require('../utils/mediaStorage');

const adminOnly = [verifyToken, checkRole(['admin'])];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(
    file.mimetype?.startsWith('image/') ? null : new Error('Imagen no válida'),
    file.mimetype?.startsWith('image/')
  ),
});

router.post('/', ...adminOnly, upload.single('imagen'), async (req, res) => {
  try {
    const options = JSON.parse(req.body.opcionesDuracion || '[]');
    if (!req.body.titulo || !req.file || !Array.isArray(options) || !options.length) {
      return res.status(400).json({ error: 'Título, imagen y opciones son obligatorios' });
    }
    for (const option of options) {
      if (!(Number(option.duracionMeses) > 0) || !(Number(option.precioEuros) >= 0)) {
        return res.status(400).json({ error: 'Opciones de duración/precio no válidas' });
      }
    }
    const image = await saveImage(req.file, 'commercial/packages');
    const packageDoc = await PromocionNegocio.create({
      titulo: String(req.body.titulo).trim(),
      descripcion: String(req.body.descripcion || '').trim(),
      imagen: image,
      opcionesDuracion: options.map((item) => ({
        duracionMeses: Number(item.duracionMeses), precioEuros: Number(item.precioEuros),
      })),
      fechaExpiracionMaxima: req.body.fechaExpiracionMaxima
        ? new Date(req.body.fechaExpiracionMaxima) : null,
    });
    res.status(201).json({ ...packageDoc.toObject(), id: String(packageDoc._id) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/', verifyToken, checkRole(['admin', 'comercio']), async (_req, res) => {
  try {
    const now = new Date();
    const packages = await PromocionNegocio.find({
      $or: [{ fechaExpiracionMaxima: { $gte: now } }, { fechaExpiracionMaxima: null }],
    }).sort({ creadoEn: -1 });
    res.json(packages.map((item) => ({ ...item.toObject(), id: String(item._id) })));
  } catch (_error) {
    res.status(500).json({ error: 'Error al obtener paquetes' });
  }
});

router.delete('/:id', ...adminOnly, async (req, res) => {
  try {
    const packageDoc = await PromocionNegocio.findByIdAndDelete(req.params.id);
    if (!packageDoc) return res.status(404).json({ error: 'Paquete no encontrado' });
    // No se eliminan contratos ni CommercialRequest históricas.
    res.json({ message: 'Paquete eliminado; contrataciones históricas conservadas' });
  } catch (_error) {
    res.status(500).json({ error: 'Error al eliminar paquete' });
  }
});

module.exports = router;
