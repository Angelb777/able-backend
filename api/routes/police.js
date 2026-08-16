const express = require('express');
const multer = require('multer');
const PoliceConfig = require('../models/PoliceConfig');
const { saveImage } = require('../utils/mediaStorage');
const { verifyToken, checkRole } = require('../middlewares/authMiddleware');

const router = express.Router();
const adminOnly = [verifyToken, checkRole(['admin'])];
const uploadFields = ['footSprite', 'footProjectile', 'footImpact', 'carSprite',
  'carProjectile', 'carImpact', 'helicopterSprite', 'helicopterProjectile', 'helicopterImpact'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => file.mimetype?.startsWith('image/')
    ? cb(null, true) : cb(new Error('Los recursos policiales deben ser imágenes')) });

const directionalRows = (rows) => {
  if (rows <= 1) return [];
  if (rows === 2) return ['south', 'north'];
  if (rows === 3) return ['south', 'west', 'north'];
  if (rows === 4) return ['south', 'southWest', 'west', 'north'];
  return ['south', 'southWest', 'west', 'northWest', 'north'];
};

const normalizeDirectionalSheet = (sheet = {}) => {
  const rows = Math.max(1, Number(sheet.rows) || 1);
  const columns = Math.max(1, Number(sheet.columns) || 1);
  if (rows <= 1) return { ...sheet, rows, columns };
  const orientations = Array.isArray(sheet.orientationRows) && sheet.orientationRows.length
    ? sheet.orientationRows : directionalRows(rows);
  return { ...sheet, rows, columns, frames: columns,
    multipleOrientations: true, orientationRows: orientations };
};

const parseConfig = (body) => {
  const raw = typeof body.config === 'string' ? JSON.parse(body.config) : body;
  const defaults = PoliceConfig.defaults();
  const result = { ...defaults, ...raw, key: 'global' };
  result.units = { ...defaults.units, ...(raw.units || {}) };
  result.units.foot = { ...defaults.units.foot, ...(raw.units?.foot || {}), movementType: 'road', routeMode: 'walking' };
  result.units.car = { ...defaults.units.car, ...(raw.units?.car || {}), movementType: 'road', routeMode: 'driving' };
  result.units.helicopter = { ...defaults.units.helicopter, ...(raw.units?.helicopter || {}), movementType: 'air' };
  for (const type of ['foot', 'car', 'helicopter']) {
    if (result.units[type].renderType === 'flame_spritesheet') {
      result.units[type].spritesheet = normalizeDirectionalSheet(result.units[type].spritesheet);
    }
  }
  if (!Array.isArray(raw.stars) || raw.stars.length !== 5) {
    throw new Error('Debes configurar exactamente cinco niveles de estrellas');
  }
  result.stars = raw.stars.map((level, index) => ({ ...defaults.stars[index], ...level, level: index + 1 }));
  return result;
};

router.get('/', ...adminOnly, async (_req, res) => {
  try {
    const stored = await PoliceConfig.findOne({ key: 'global' }).lean();
    const normalized = stored ? parseConfig({ config: JSON.stringify(stored) }) : PoliceConfig.defaults();
    return res.json({ ...normalized,
      routingConfigured: Boolean(process.env.GOOGLE_MAPS_SERVER_API_KEY || process.env.GOOGLE_MAPS_API_KEY) });
  } catch (_) {
    return res.status(500).json({ error: 'No se pudo cargar la configuración policial' });
  }
});

router.put('/', ...adminOnly, upload.fields(uploadFields.map((name) => ({ name, maxCount: 1 }))), async (req, res) => {
  try {
    const next = parseConfig(req.body);
    const current = await PoliceConfig.findOne({ key: 'global' }).lean();
    const resources = {
      footSprite: ['foot', 'spriteUrl'], footProjectile: ['foot', 'projectileSpriteUrl'], footImpact: ['foot', 'impactSpriteUrl'],
      carSprite: ['car', 'spriteUrl'], carProjectile: ['car', 'projectileSpriteUrl'], carImpact: ['car', 'impactSpriteUrl'],
      helicopterSprite: ['helicopter', 'spriteUrl'], helicopterProjectile: ['helicopter', 'projectileSpriteUrl'], helicopterImpact: ['helicopter', 'impactSpriteUrl'],
    };
    const animatedResource = {
      spriteUrl: ['renderType', 'spritesheet', true],
      projectileSpriteUrl: ['projectileRenderType', 'projectileSpritesheet', true],
      impactSpriteUrl: ['impactRenderType', 'impactSpritesheet', false],
    };
    for (const [field, [type, property]] of Object.entries(resources)) {
      const file = req.files?.[field]?.[0];
      if (file) {
        next.units[type][property] = await saveImage(file, 'police');
      }
      else if (!next.units[type][property] && current?.units?.[type]?.[property]) {
        next.units[type][property] = current.units[type][property];
      }
      const [renderProperty, sheetProperty, defaultLoop] = animatedResource[property];
      if (next.units[type][renderProperty] === 'flame_spritesheet' && next.units[type][property]) {
        next.units[type][sheetProperty] = {
          ...(next.units[type][sheetProperty] || {}),
          url: next.units[type][property],
          loop: next.units[type][sheetProperty]?.loop ?? defaultLoop,
        };
      }
    }
    const saved = await PoliceConfig.findOneAndUpdate({ key: 'global' }, { $set: next },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true });
    return res.json(saved);
  } catch (error) {
    const status = error instanceof SyntaxError || error.name === 'ValidationError' ||
      /cinco niveles/.test(error.message) ? 400 : 500;
    return res.status(status).json({ error: error.message || 'No se pudo guardar la configuración policial' });
  }
});

module.exports = router;
