const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const { verifyToken, checkRole } = require('../middlewares/authMiddleware');
const Establishment = require('../models/Establishment');
const CommercialRequest = require('../models/CommercialRequest');
const PromocionNegocio = require('../models/PromocionNegocio');
const PromocionComprada = require('../models/PromocionComprada');
const Reward = require('../models/Reward');
const Skin = require('../models/Skin');
const Card = require('../models/Card');
const { saveImage } = require('../utils/mediaStorage');
const {
  FIXED_PRICES, fixedPrice, pendingStatus, assertCanApprove,
  addOneYear, recordTransition,
} = require('../services/commercialWorkflow');

const router = express.Router();
const commerceOnly = [verifyToken, checkRole(['comercio'])];
const commerceOrAdmin = [verifyToken, checkRole(['comercio', 'admin'])];
const adminOnly = [verifyToken, checkRole(['admin'])];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set([
      'image/png', 'image/jpeg', 'image/webp', 'image/gif',
      'application/pdf', 'application/zip', 'application/x-zip-compressed',
    ]);
    cb(allowed.has(file.mimetype) ? null : new Error('Formato de material no permitido'),
      allowed.has(file.mimetype));
  },
});

function uploadFields(req, res, next) {
  upload.fields([{ name: 'logo', maxCount: 1 }, { name: 'materials', maxCount: 10 }])(
    req, res, (error) => error
      ? res.status(400).json({ error: error.message })
      : next()
  );
}

function parseObject(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { throw new Error('JSON de formulario no válido'); }
}

function finiteCoordinate(value, min, max, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label} no válida`);
  }
  return number;
}

function requestJson(request) {
  const value = request.toJSON ? request.toJSON() : { ...request };
  value.id = String(value._id || value.id);
  return value;
}

async function storeFiles(files, folder) {
  return Promise.all((files || []).map(async (file) => ({
    url: await saveImage(file, folder),
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    label: 'material',
  })));
}

async function expireFinishedPositioningRequests(ownerId) {
  const filter = {
    commercialRequestId: { $ne: null },
    fechaFin: { $lt: new Date() },
    status: 'published',
  };
  if (ownerId) filter.comercioId = ownerId;
  const expired = await PromocionComprada.find(filter).select('commercialRequestId').lean();
  if (!expired.length) return;
  const requestIds = expired.map((item) => item.commercialRequestId).filter(Boolean);
  await Promise.all([
    PromocionComprada.updateMany(
      { commercialRequestId: { $in: requestIds }, status: 'published' },
      { $set: { activo: false, status: 'expired' } },
    ),
    CommercialRequest.updateMany(
      { _id: { $in: requestIds }, status: 'published' },
      {
        $set: { status: 'expired' },
        $inc: { revision: 1 },
        $push: {
          history: {
            action: 'positioning_expired',
            fromStatus: 'published',
            toStatus: 'expired',
            actorRole: 'system',
            at: new Date(),
          },
        },
      },
    ),
  ]);
}

function specifications() {
  return {
    commercial_skin: {
      type: 'commercial_skin', price: FIXED_PRICES.commercial_skin, currency: 'EUR',
      title: 'Skin comercial', reviewYears: 1,
      requirements: [
        'Logo vectorial o PNG de alta resolución',
        'Referencias frontal, lateral y trasera',
        'Guía de marca y colores',
        'Able73 adapta y valida las animaciones del sistema Skin actual',
      ],
      templateUrl: process.env.COMMERCIAL_SKIN_TEMPLATE_URL || '',
    },
    commercial_weapon: {
      type: 'commercial_weapon', currency: 'EUR', reviewYears: 1,
      tiers: [
        { subtype: 'short', label: 'Corta', price: 250 },
        { subtype: 'medium', label: 'Media', price: 350 },
        { subtype: 'long', label: 'Larga', price: 450 },
      ],
      requirements: [
        'Diseño del proyectil y referencia de explosión',
        'PNG transparente, spritesheet o material vectorial',
        'El comercio no define daño, alcance, cooldown ni estadísticas',
        'El Superadmin integra el resultado en Card/Proyectil',
      ],
      templateUrl: process.env.COMMERCIAL_WEAPON_TEMPLATE_URL || '',
    },
  };
}

router.get('/specifications', ...commerceOrAdmin, (_req, res) => {
  res.json(specifications());
});

router.get('/establishment', ...commerceOnly, async (req, res, next) => {
  try {
    const establishment = await Establishment.findOne({ ownerId: req.user.id });
    res.json(establishment || null);
  } catch (error) { next(error); }
});

router.put('/establishment', ...commerceOnly, uploadFields, async (req, res) => {
  try {
    const lat = finiteCoordinate(req.body.lat, -90, 90, 'Latitud');
    const lng = finiteCoordinate(req.body.lng, -180, 180, 'Longitud');
    const publicName = String(req.body.publicName || '').trim();
    const address = String(req.body.address || '').trim();
    if (!publicName || !address) {
      return res.status(400).json({ error: 'Nombre público y dirección son obligatorios' });
    }
    const previous = await Establishment.findOne({ ownerId: req.user.id });
    let logoUrl = previous?.logoUrl || '';
    const logoFile = req.files?.logo?.[0];
    if (logoFile) logoUrl = await saveImage(logoFile, 'commercial/establishments');
    if (!logoUrl) return res.status(400).json({ error: 'El logo del establecimiento es obligatorio' });

    const establishment = await Establishment.findOneAndUpdate(
      { ownerId: req.user.id },
      { $set: {
        legalName: String(req.body.legalName || '').trim(), publicName,
        description: String(req.body.description || '').trim(), address,
        city: String(req.body.city || '').trim(), country: String(req.body.country || '').trim(),
        phone: String(req.body.phone || '').trim(), website: String(req.body.website || '').trim(),
        logoUrl, lat, lng, status: 'pending_review', reviewNotes: '',
      } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );
    res.json(establishment);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/packages', ...commerceOnly, async (_req, res, next) => {
  try {
    const now = new Date();
    const packages = await PromocionNegocio.find({
      $or: [{ fechaExpiracionMaxima: { $gte: now } }, { fechaExpiracionMaxima: null }],
    }).sort({ creadoEn: -1 });
    res.json(packages.map((item) => ({ ...item.toObject(), id: String(item._id) })));
  } catch (error) { next(error); }
});

router.get('/requests', ...commerceOnly, async (req, res, next) => {
  try {
    await expireFinishedPositioningRequests(req.user.id);
    const requests = await CommercialRequest.find({ ownerId: req.user.id })
      .populate('establishmentId', 'publicName logoUrl address lat lng status')
      .sort({ createdAt: -1 });
    res.json(requests);
  } catch (error) { next(error); }
});

router.post('/requests', ...commerceOnly, uploadFields, async (req, res) => {
  try {
    const type = String(req.body.type || '');
    const subtype = String(req.body.subtype || '');
    const formData = parseObject(req.body.formData);
    const title = String(req.body.title || formData.title || '').trim();
    if (!title) return res.status(400).json({ error: 'El título es obligatorio' });
    if (!['positioning', 'commercial_skin', 'commercial_weapon', 'reward'].includes(type)) {
      return res.status(400).json({ error: 'Tipo de solicitud no válido' });
    }

    const validSubtype = type === 'commercial_weapon'
      ? ['short', 'medium', 'long'].includes(subtype)
      : type === 'reward'
        ? ['discount', 'prize'].includes(subtype)
        : subtype === '';
    if (!validSubtype) {
      return res.status(400).json({ error: 'Modalidad no válida para este tipo de solicitud' });
    }

    const establishment = await Establishment.findOne({ ownerId: req.user.id });
    if (!establishment) {
      return res.status(409).json({ error: 'Primero debes completar Mi establecimiento' });
    }
    let price = type === 'positioning' ? 0 : fixedPrice(type, subtype);
    let paymentStatus = price === 0 ? 'not_required' : 'pending';
    if (type === 'positioning') {
      const packageId = String(formData.packageId || req.body.packageId || '');
      const durationMonths = Number(formData.durationMonths || req.body.durationMonths);
      const packageDoc = await PromocionNegocio.findById(packageId);
      if (!packageDoc) return res.status(404).json({ error: 'Paquete no encontrado' });
      const option = packageDoc.opcionesDuracion.find(
        (item) => Number(item.duracionMeses) === durationMonths
      );
      if (!option) return res.status(400).json({ error: 'Duración no válida para el paquete' });
      price = Number(option.precioEuros);
      paymentStatus = 'pending';
      Object.assign(formData, {
        packageId: String(packageDoc._id), durationMonths,
        packageTitle: packageDoc.titulo, baseImageUrl: packageDoc.imagen,
        logoUrl: establishment.logoUrl, lat: establishment.lat, lng: establishment.lng,
      });
    }
    if (type === 'reward') {
      const rewardType = subtype === 'prize' ? 'premio' : 'descuento';
      const stepcoins = Number(formData.stepcoins);
      if (!Number.isFinite(stepcoins) || stepcoins < 0) {
        return res.status(400).json({ error: 'Stepcoins no válidos' });
      }
      if (rewardType === 'descuento') {
        const percentage = Number(formData.percentage || 0);
        const amountEuros = Number(formData.amountEuros || 0);
        if ((!Number.isFinite(percentage) || percentage < 0 || percentage > 100)
          || (!Number.isFinite(amountEuros) || amountEuros < 0)
          || (percentage <= 0 && amountEuros <= 0)) {
          return res.status(400).json({
            error: 'Indica un porcentaje (1-100) o importe de descuento válido',
          });
        }
      }
      formData.rewardType = rewardType;
    }

    const materials = await storeFiles(req.files?.materials, 'commercial/materials');
    const request = new CommercialRequest({
      ownerId: req.user.id, establishmentId: establishment._id, type, subtype,
      title, price, paymentStatus, formData, materials,
    });
    request.status = pendingStatus(request);
    request.history.push({
      action: 'created', toStatus: request.status, actorId: req.user.id,
      actorRole: req.user.role, at: new Date(),
    });
    await request.save();

    if (type === 'reward') {
      const reward = await Reward.create({
        tipo: formData.rewardType,
        titulo: title,
        descripcion: String(formData.description || ''),
        direccion: String(formData.address || establishment.address),
        comercioId: req.user.id,
        porcentaje: formData.rewardType === 'descuento' ? Number(formData.percentage || 0) : undefined,
        cantidadEuros: formData.rewardType === 'descuento' ? Number(formData.amountEuros || 0) : undefined,
        stepcoins: Number(formData.stepcoins),
        imagenes: materials.filter((item) => item.mimeType.startsWith('image/')).map((item) => item.url),
        validado: false, creadoPorAdmin: false,
        commercialRequestId: request._id, publicationStatus: 'pending',
      });
      request.targetModel = 'Reward';
      request.targetId = reward._id;
      await request.save();
    }
    res.status(201).json(requestJson(request));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/requests/:id/material', ...commerceOnly, uploadFields, async (req, res) => {
  try {
    const request = await CommercialRequest.findOne({ _id: req.params.id, ownerId: req.user.id });
    if (!request) return res.status(404).json({ error: 'Solicitud no encontrada' });
    if (!['pending_payment', 'pending_material', 'pending_review', 'changes_requested'].includes(request.status)) {
      return res.status(409).json({ error: 'La solicitud ya está cerrada' });
    }
    const uploaded = await storeFiles(req.files?.materials, 'commercial/materials');
    if (!uploaded.length) return res.status(400).json({ error: 'No se recibió material' });
    request.materials.push(...uploaded);
    recordTransition(request, {
      action: 'material_uploaded', status: pendingStatus(request),
      actorId: req.user.id, actorRole: req.user.role,
    });
    await request.save();
    res.json(request);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.patch('/requests/:id/withdraw', ...commerceOnly, async (req, res) => {
  try {
    const request = await CommercialRequest.findOne({ _id: req.params.id, ownerId: req.user.id });
    if (!request) return res.status(404).json({ error: 'Solicitud no encontrada' });
    if (!['pending_payment', 'pending_material', 'pending_review', 'changes_requested', 'approved']
      .includes(request.status)) {
      return res.status(409).json({ error: 'Solicita al Superadmin retirar una publicación activa' });
    }
    recordTransition(request, {
      action: 'withdraw', status: 'withdrawn', actorId: req.user.id,
      actorRole: req.user.role, notes: String(req.body.notes || ''),
    });
    await request.save();
    res.json(request);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.get('/admin/establishments', ...adminOnly, async (req, res, next) => {
  try {
    const filter = req.query.status ? { status: req.query.status } : {};
    const items = await Establishment.find(filter)
      .populate('ownerId', 'nombre email role').sort({ updatedAt: -1 });
    res.json(items);
  } catch (error) { next(error); }
});

router.patch('/admin/establishments/:id', ...adminOnly, async (req, res) => {
  try {
    const establishment = await Establishment.findById(req.params.id);
    if (!establishment) return res.status(404).json({ error: 'Establecimiento no encontrado' });
    const action = String(req.body.action || '');
    const statuses = {
      approve: 'approved', reject: 'rejected', request_changes: 'changes_requested',
      disable: 'disabled', reopen: 'pending_review',
    };
    if (!statuses[action]) return res.status(400).json({ error: 'Acción no válida' });
    establishment.status = statuses[action];
    establishment.reviewNotes = String(req.body.notes || '');
    establishment.reviewedBy = req.user.id;
    establishment.reviewedAt = new Date();
    if (action === 'approve') establishment.approvedAt = new Date();
    if (action === 'disable') establishment.disabledAt = new Date();
    await establishment.save();
    res.json(establishment);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.get('/admin/requests', ...adminOnly, async (req, res, next) => {
  try {
    await expireFinishedPositioningRequests();
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.type) filter.type = req.query.type;
    const items = await CommercialRequest.find(filter)
      .populate('ownerId', 'nombre email role')
      .populate('establishmentId', 'publicName logoUrl address lat lng status')
      .sort({ updatedAt: -1 });
    res.json(items);
  } catch (error) { next(error); }
});

async function publishRequest(request, publicationData, adminId) {
  const now = new Date();
  let target;
  if (request.type === 'positioning') {
    const establishment = await Establishment.findOne({
      _id: request.establishmentId, ownerId: request.ownerId,
    });
    if (!establishment || establishment.status !== 'approved') {
      throw new Error('El establecimiento debe estar aprobado antes de publicar');
    }
    const durationMonths = Number(request.formData.durationMonths);
    const end = new Date(now);
    end.setUTCMonth(end.getUTCMonth() + durationMonths);
    target = await PromocionComprada.findOneAndUpdate(
      { commercialRequestId: request._id },
      { $set: {
        comercioId: request.ownerId, promoId: request.formData.packageId,
        titulo: request.formData.packageTitle, imagenBase: request.formData.baseImageUrl,
        logoComercio: establishment.logoUrl, lat: establishment.lat, lng: establishment.lng,
        duracionMeses: durationMonths, precioEuros: request.price,
        fechaInicio: now, fechaFin: end, activo: true, status: 'published',
        paymentStatus: request.paymentStatus === 'waived' ? 'waived' : 'confirmed',
        approvedAt: request.approvedAt || now, publishedAt: now,
      } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    request.targetModel = 'PromocionComprada';
  } else if (request.type === 'reward') {
    target = await Reward.findOneAndUpdate(
      { _id: request.targetId, comercioId: request.ownerId },
      { $set: { validado: true, publicationStatus: 'published', publishedAt: now } },
      { new: true }
    );
    if (!target) throw new Error('Reward pendiente no encontrado');
    request.targetModel = 'Reward';
  } else if (request.type === 'commercial_skin') {
    const imageMaterials = request.materials.filter((item) => item.mimeType.startsWith('image/'));
    const portada = String(publicationData.portada || imageMaterials[0]?.url || '');
    const catalogPriceRaw = publicationData.catalogPriceStepcoins;
    const catalogPrice = Number(catalogPriceRaw);
    if (!portada || catalogPriceRaw == null || catalogPriceRaw === ''
      || !Number.isFinite(catalogPrice) || catalogPrice < 0) {
      throw new Error('Portada y precio de catálogo en Stepcoins son obligatorios');
    }
    target = await Skin.findOneAndUpdate(
      { commercialRequestId: request._id },
      { $set: {
        titulo: String(publicationData.titulo || request.title),
        descripcion: String(publicationData.descripcion || request.formData.description || request.title),
        portada, scripts: publicationData.scripts || {},
        renderType: publicationData.renderType === 'flame_spritesheet' ? 'flame_spritesheet' : 'classic',
        renderVersion: Number(publicationData.renderVersion) || 1,
        spritesheets: publicationData.spritesheets || {}, precio: catalogPrice,
        validada: true, commercialRequestId: request._id,
        commercialOwnerId: request.ownerId, isCommercial: true,
        publishedAt: now, reviewDueAt: addOneYear(now), retiredAt: null,
      } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    request.targetModel = 'Skin';
    request.reviewDueAt = addOneYear(now);
  } else if (request.type === 'commercial_weapon') {
    const statsProvided = ['dano', 'alcance', 'tiempoEspera'].every(
      (key) => publicationData[key] != null && publicationData[key] !== ''
    );
    const damage = Number(publicationData.dano);
    const range = Number(publicationData.alcance);
    const cooldown = Number(publicationData.tiempoEspera);
    if (!statsProvided || ![damage, range, cooldown].every(Number.isFinite)
      || damage <= 0 || range <= 0 || cooldown < 0) {
      throw new Error('El Superadmin debe definir daño, alcance y cooldown válidos');
    }
    const images = request.materials.filter((item) => item.mimeType.startsWith('image/')).map((item) => item.url);
    const cover = String(publicationData.imagenPortada || images[0] || '');
    if (!cover) throw new Error('Falta una imagen de portada integrada');
    target = await Card.findOneAndUpdate(
      { commercialRequestId: request._id },
      { $set: {
        titulo: String(publicationData.titulo || request.title),
        descripcion: String(publicationData.descripcion || request.formData.description || ''),
        imagenPortada: cover,
        imagenesArma: publicationData.imagenesArma || images,
        imagenesExplosion: publicationData.imagenesExplosion || [],
        projectileRenderType: publicationData.projectileRenderType === 'flame_spritesheet'
          ? 'flame_spritesheet' : 'classic',
        explosionRenderType: publicationData.explosionRenderType === 'flame_spritesheet'
          ? 'flame_spritesheet' : 'classic',
        projectileSpritesheet: publicationData.projectileSpritesheet || undefined,
        explosionSpritesheet: publicationData.explosionSpritesheet || undefined,
        tipoArma: 'Proyectil', dispositivo: publicationData.dispositivo || 'Ambos',
        dano: damage, alcance: range, tiempoEspera: cooldown,
        commercialRequestId: request._id, commercialOwnerId: request.ownerId,
        commercialTier: request.subtype, isCommercial: true,
        commercialPublicationStatus: 'published',
        publishedAt: now, reviewDueAt: addOneYear(now), retiredAt: null,
      } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    request.targetModel = 'Card';
    request.reviewDueAt = addOneYear(now);
  }
  if (!target) throw new Error('No se pudo crear la publicación');
  request.targetId = target._id;
  request.publishedAt = now;
  recordTransition(request, {
    action: 'publish', status: 'published', actorId: adminId,
    actorRole: 'admin', notes: String(publicationData.notes || ''), now,
  });
  await request.save();
  return target;
}

async function setPublishedActive(request, active, retired = false) {
  if (!request.targetId) return;
  if (request.targetModel === 'PromocionComprada') {
    await PromocionComprada.updateOne({ _id: request.targetId }, {
      $set: { activo: active, status: retired ? 'retired' : (active ? 'published' : 'disabled'),
        ...(retired ? { retiredAt: new Date() } : {}) },
    });
  } else if (request.targetModel === 'Reward') {
    await Reward.updateOne({ _id: request.targetId }, {
      $set: { validado: active, publicationStatus: retired ? 'retired' : (active ? 'published' : 'disabled'),
        ...(retired ? { retiredAt: new Date() } : {}) },
    });
  } else if (request.targetModel === 'Skin') {
    await Skin.updateOne({ _id: request.targetId }, {
      $set: { validada: active, ...(retired ? { retiredAt: new Date() } : {}) },
    });
  } else if (request.targetModel === 'Card') {
    await Card.updateOne({ _id: request.targetId }, {
      $set: {
        commercialPublicationStatus: retired ? 'retired' : (active ? 'published' : 'disabled'),
        ...(retired ? { retiredAt: new Date() } : {}),
      },
    });
  }
}

router.patch('/admin/requests/:id', ...adminOnly, async (req, res) => {
  try {
    const request = await CommercialRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ error: 'Solicitud no encontrada' });
    const action = String(req.body.action || '');
    const notes = String(req.body.notes || '');
    const now = new Date();
    const allowedStatuses = {
      confirm_payment: ['pending_payment', 'pending_material', 'pending_review', 'changes_requested'],
      waive_payment: ['pending_payment', 'pending_material', 'pending_review', 'changes_requested'],
      request_changes: ['pending_payment', 'pending_material', 'pending_review', 'approved'],
      reject: ['pending_payment', 'pending_material', 'pending_review', 'changes_requested', 'approved'],
      approve: ['pending_review', 'changes_requested'],
      publish: ['approved', 'renewed'],
      disable: ['published'],
      republish: ['disabled'],
      mark_renewal_due: ['published'],
      renew: ['renewal_due'],
      renew_positioning: ['expired'],
      retire: ['published', 'disabled', 'renewal_due'],
    };
    if (!allowedStatuses[action]) {
      return res.status(400).json({ error: 'Acción no válida' });
    }
    if (!allowedStatuses[action].includes(request.status)) {
      return res.status(409).json({
        error: `La acción ${action} no es válida desde el estado ${request.status}`,
      });
    }
    if (action === 'mark_renewal_due'
      && !['commercial_skin', 'commercial_weapon'].includes(request.type)) {
      return res.status(409).json({ error: 'La revisión anual solo aplica a skins y armas comerciales' });
    }
    if (action === 'renew_positioning' && request.type !== 'positioning') {
      return res.status(409).json({ error: 'Esta renovación solo aplica a posicionamientos caducados' });
    }
    if (action === 'confirm_payment') {
      if (request.paymentStatus !== 'pending') {
        return res.status(409).json({ error: 'El pago ya no está pendiente' });
      }
      const paymentReference = String(req.body.paymentReference || '').trim();
      if (!paymentReference) {
        return res.status(400).json({ error: 'La referencia de pago manual es obligatoria' });
      }
      request.paymentStatus = 'confirmed';
      request.paymentReference = paymentReference;
      request.paymentConfirmedAt = now;
      recordTransition(request, {
        action, status: pendingStatus(request), actorId: req.user.id,
        actorRole: req.user.role, notes, now,
      });
    } else if (action === 'waive_payment') {
      if (request.paymentStatus !== 'pending') {
        return res.status(409).json({ error: 'El pago ya no está pendiente' });
      }
      request.paymentStatus = 'waived';
      request.paymentConfirmedAt = now;
      recordTransition(request, {
        action, status: pendingStatus(request), actorId: req.user.id,
        actorRole: req.user.role, notes, now,
      });
    } else if (action === 'request_changes') {
      recordTransition(request, { action, status: 'changes_requested', actorId: req.user.id, actorRole: 'admin', notes, now });
    } else if (action === 'reject') {
      recordTransition(request, { action, status: 'rejected', actorId: req.user.id, actorRole: 'admin', notes, now });
    } else if (action === 'approve') {
      assertCanApprove(request);
      request.reviewedBy = req.user.id; request.reviewedAt = now; request.approvedAt = now;
      recordTransition(request, { action, status: 'approved', actorId: req.user.id, actorRole: 'admin', notes, now });
    } else if (action === 'publish') {
      if (!['approved', 'renewed'].includes(request.status)) {
        return res.status(409).json({ error: 'La solicitud debe estar aprobada antes de publicar' });
      }
      const target = await publishRequest(request, parseObject(req.body.publicationData), req.user.id);
      return res.json({ request, target });
    } else if (action === 'disable') {
      await setPublishedActive(request, false);
      recordTransition(request, { action, status: 'disabled', actorId: req.user.id, actorRole: 'admin', notes, now });
    } else if (action === 'republish') {
      await setPublishedActive(request, true);
      recordTransition(request, { action, status: 'published', actorId: req.user.id, actorRole: 'admin', notes, now });
    } else if (action === 'mark_renewal_due') {
      recordTransition(request, { action, status: 'renewal_due', actorId: req.user.id, actorRole: 'admin', notes, now });
    } else if (action === 'renew') {
      request.reviewDueAt = addOneYear(now);
      if (request.targetModel === 'Skin') await Skin.updateOne({ _id: request.targetId }, { $set: { reviewDueAt: request.reviewDueAt } });
      if (request.targetModel === 'Card') await Card.updateOne({ _id: request.targetId }, { $set: { reviewDueAt: request.reviewDueAt } });
      recordTransition(request, { action, status: 'published', actorId: req.user.id, actorRole: 'admin', notes, now });
    } else if (action === 'renew_positioning') {
      const packageDoc = await PromocionNegocio.findById(request.formData.packageId);
      const option = packageDoc?.opcionesDuracion?.find(
        (item) => Number(item.duracionMeses) === Number(request.formData.durationMonths)
      );
      if (!packageDoc || !option
        || (packageDoc.fechaExpiracionMaxima && packageDoc.fechaExpiracionMaxima < now)) {
        return res.status(409).json({ error: 'El paquete o su duración ya no están disponibles' });
      }
      request.price = Number(option.precioEuros);
      request.paymentStatus = 'pending';
      request.paymentReference = '';
      request.paymentConfirmedAt = null;
      request.approvedAt = null;
      request.publishedAt = null;
      recordTransition(request, {
        action, status: 'pending_payment', actorId: req.user.id,
        actorRole: 'admin', notes, now,
      });
    } else if (action === 'retire') {
      await setPublishedActive(request, false, true);
      request.retiredAt = now;
      recordTransition(request, { action, status: 'retired', actorId: req.user.id, actorRole: 'admin', notes, now });
    } else {
      return res.status(400).json({ error: 'Acción no válida' });
    }
    await request.save();
    res.json(request);
  } catch (error) {
    const status = error instanceof mongoose.Error.VersionError ? 409 : 400;
    res.status(status).json({ error: error.message });
  }
});

module.exports = router;
module.exports.specifications = specifications;
