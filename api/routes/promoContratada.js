const express = require('express');
const multer = require('multer');
const router = express.Router();
const PromocionNegocio = require('../models/PromocionNegocio');
const PromocionComprada = require('../models/PromocionComprada');
const CommercialRequest = require('../models/CommercialRequest');
const Establishment = require('../models/Establishment');
const { verifyToken, checkRole } = require('../middlewares/authMiddleware');
const { saveImage } = require('../utils/mediaStorage');
const { pendingStatus } = require('../services/commercialWorkflow');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(
    file.mimetype?.startsWith('image/') ? null : new Error('El logo debe ser una imagen'),
    file.mimetype?.startsWith('image/')
  ),
});

// Compatibilidad con el formulario web antiguo. Ya no crea Payment ni marca el
// contrato como pagado: crea la misma CommercialRequest pendiente que Flutter.
router.post('/', verifyToken, checkRole(['comercio']), upload.single('logo'), async (req, res) => {
  try {
    const promoId = String(req.body.promoId || '');
    const durationMonths = Number(req.body.duracion || req.body.durationMonths);
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);
    if (!promoId || !Number.isFinite(durationMonths) ||
        !Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'Faltan datos requeridos' });
    }
    const promo = await PromocionNegocio.findById(promoId);
    if (!promo) return res.status(404).json({ error: 'Paquete no encontrado' });
    const option = promo.opcionesDuracion.find(
      (item) => Number(item.duracionMeses) === durationMonths
    );
    if (!option) return res.status(400).json({ error: 'Duración no válida' });
    const establishment = await Establishment.findOne({ ownerId: req.user.id });
    if (!establishment) {
      return res.status(409).json({ error: 'Completa primero Mi establecimiento en la app' });
    }
    if (establishment.status !== 'approved') {
      return res.status(409).json({
        error: 'Able73 debe aprobar Mi establecimiento antes de contratar posicionamiento',
      });
    }
    let logoUrl = establishment.logoUrl;
    const materials = [];
    if (req.file) {
      logoUrl = await saveImage(req.file, 'commercial/establishments');
      establishment.logoUrl = logoUrl;
      establishment.lat = lat;
      establishment.lng = lng;
      establishment.status = 'pending_review';
      await establishment.save();
      materials.push({
        url: logoUrl, originalName: req.file.originalname,
        mimeType: req.file.mimetype, size: req.file.size, label: 'logo',
      });
    }
    if (!logoUrl) return res.status(400).json({ error: 'Logo requerido' });
    const request = new CommercialRequest({
      ownerId: req.user.id, establishmentId: establishment._id,
      type: 'positioning', title: promo.titulo,
      price: Number(option.precioEuros), paymentStatus: 'pending', materials,
      formData: {
        packageId: String(promo._id), packageTitle: promo.titulo,
        baseImageUrl: promo.imagen, durationMonths, logoUrl, lat, lng,
      },
      legacySource: 'promo-contratada-endpoint',
    });
    request.status = pendingStatus(request);
    request.history.push({
      action: 'created_legacy_endpoint', toStatus: request.status,
      actorId: req.user.id, actorRole: req.user.role,
    });
    await request.save();
    res.status(201).json({
      message: 'Solicitud creada. El pago y la aprobación están pendientes.',
      id: String(request._id), _id: request._id,
      status: request.status, paymentStatus: request.paymentStatus,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Endpoint público consumido por el mapa. Los documentos antiguos sin status
// se conservan activos; los nuevos solo aparecen después de publicación.
router.get('/activas', async (_req, res) => {
  try {
    const now = new Date();
    const active = await PromocionComprada.find({
      activo: true,
      fechaFin: { $gte: now },
      logoComercio: { $type: 'string', $ne: '' },
      lat: { $gte: -90, $lte: 90 },
      lng: { $gte: -180, $lte: 180 },
      $or: [{ status: 'published' }, { status: { $exists: false } }],
    }).select('-__v').lean();
    res.json(active.map((item) => ({
      ...item, id: String(item._id), _id: item._id,
      logoComercio: item.logoComercio,
      imagenBase: item.imagenBase || '',
    })));
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener posicionamientos activos' });
  }
});

module.exports = router;
