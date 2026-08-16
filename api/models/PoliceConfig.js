const mongoose = require('mongoose');

const spriteSheetSchema = new mongoose.Schema({
  url: { type: String, default: '' }, columns: { type: Number, default: 1, min: 1 },
  rows: { type: Number, default: 1, min: 1 }, frames: { type: Number, default: 1, min: 1 },
  fps: { type: Number, default: 12, min: 0.01 }, loop: { type: Boolean, default: true },
  readOrder: { type: String, default: 'row-major' },
  multipleOrientations: { type: Boolean, default: false },
  orientationRows: { type: [String], default: [] }, frameOrder: { type: [Number], default: [] },
}, { _id: false });

const unitSchema = new mongoose.Schema({
  label: { type: String, required: true },
  movementType: { type: String, enum: ['road', 'air'], required: true },
  routeMode: { type: String, enum: ['walking', 'driving'], default: 'driving' },
  spriteUrl: { type: String, default: '' },
  renderType: { type: String, enum: ['classic', 'flame_spritesheet'], default: 'classic' },
  spritesheet: { type: spriteSheetSchema, default: () => ({}) },
  life: { type: Number, default: 300, min: 1 },
  speedMetersPerSecond: { type: Number, default: 8, min: 0.1 },
  projectileSpriteUrl: { type: String, default: '' }, impactSpriteUrl: { type: String, default: '' },
  damage: { type: Number, default: 50, min: 0 }, rangeMeters: { type: Number, default: 250, min: 1 },
  fireIntervalSeconds: { type: Number, default: 3, min: 0.1 },
  cooldownSeconds: { type: Number, default: 3, min: 0.1 },
  projectileSpeedMetersPerSecond: { type: Number, default: 100, min: 1 },
  hitRadiusMeters: { type: Number, default: 18, min: 1 },
}, { _id: false });

const starSchema = new mongoose.Schema({
  level: { type: Number, min: 1, max: 5, required: true },
  footOfficers: { type: Number, default: 0, min: 0 }, cars: { type: Number, default: 0, min: 0 },
  helicopters: { type: Number, default: 0, min: 0 }, spawnDelaySeconds: { type: Number, default: 5, min: 0 },
  escapeDistanceMeters: { type: Number, default: 1000, min: 1 },
  escapeHoldSeconds: { type: Number, default: 15, min: 0.1 },
  completionCondition: { type: String, enum: ['all_units_destroyed'], default: 'all_units_destroyed' },
  autoEscalate: { type: Boolean, default: true },
}, { _id: false });

const PoliceConfigSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: 'global' }, enabled: { type: Boolean, default: false },
  reuseRadiusMeters: { type: Number, default: 2000, min: 100 },
  maxActiveIncidents: { type: Number, default: 50, min: 1 },
  maxUnitsPerIncident: { type: Number, default: 30, min: 1 },
  maxNearbyUnits: { type: Number, default: 60, min: 1 },
  updateIntervalMs: { type: Number, default: 500, min: 100 },
  routeRecalculationDistanceMeters: { type: Number, default: 100, min: 20 },
  routeCacheTtlSeconds: { type: Number, default: 300, min: 30 },
  targetLockSeconds: { type: Number, default: 4, min: 0.5 },
  spawnDistanceMeters: { type: Number, default: 180, min: 30 },
  units: {
    foot: { type: unitSchema, required: true }, car: { type: unitSchema, required: true },
    helicopter: { type: unitSchema, required: true },
  },
  stars: { type: [starSchema], validate: {
    validator: (levels) => Array.isArray(levels) && levels.length === 5 &&
      levels.every((level, index) => level.level === index + 1),
    message: 'Deben configurarse exactamente los niveles de 1 a 5 estrellas',
  } },
}, { timestamps: true });

PoliceConfigSchema.statics.defaults = function defaults() {
  const unit = (label, movementType, routeMode, speed) => ({
    label, movementType, routeMode, life: 300, speedMetersPerSecond: speed,
    damage: 50, rangeMeters: 250, fireIntervalSeconds: 3, cooldownSeconds: 3,
    projectileSpeedMetersPerSecond: 100, hitRadiusMeters: 18,
  });
  return {
    key: 'global', enabled: false, reuseRadiusMeters: 2000, maxActiveIncidents: 50,
    maxUnitsPerIncident: 30, maxNearbyUnits: 60, updateIntervalMs: 500,
    routeRecalculationDistanceMeters: 100, routeCacheTtlSeconds: 300,
    targetLockSeconds: 4, spawnDistanceMeters: 180,
    units: {
      foot: unit('Policía a pie', 'road', 'walking', 3),
      car: unit('Coche de policía', 'road', 'driving', 14),
      helicopter: unit('Helicóptero', 'air', 'driving', 20),
    },
    stars: [
      { level: 1, footOfficers: 2, cars: 0, helicopters: 0, spawnDelaySeconds: 5, escapeDistanceMeters: 1000, escapeHoldSeconds: 15, autoEscalate: true },
      { level: 2, footOfficers: 0, cars: 2, helicopters: 0, spawnDelaySeconds: 5, escapeDistanceMeters: 1000, escapeHoldSeconds: 15, autoEscalate: true },
      { level: 3, footOfficers: 0, cars: 5, helicopters: 0, spawnDelaySeconds: 6, escapeDistanceMeters: 1200, escapeHoldSeconds: 18, autoEscalate: true },
      { level: 4, footOfficers: 2, cars: 5, helicopters: 1, spawnDelaySeconds: 7, escapeDistanceMeters: 1400, escapeHoldSeconds: 20, autoEscalate: true },
      { level: 5, footOfficers: 4, cars: 7, helicopters: 2, spawnDelaySeconds: 8, escapeDistanceMeters: 1600, escapeHoldSeconds: 25, autoEscalate: false },
    ],
  };
};

module.exports = mongoose.model('PoliceConfig', PoliceConfigSchema);
