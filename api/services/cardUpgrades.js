const MAX_UPGRADE_LEVEL = 3;
const UPGRADE_COSTS = Object.freeze([5000, 10000, 20000]);

function normalizeUpgradeLevel(value) {
  const level = Number(value);
  if (!Number.isInteger(level)) return 0;
  return Math.max(0, Math.min(MAX_UPGRADE_LEVEL, level));
}

function upgradeLevelForUser(user, cardId) {
  const upgrades = Array.isArray(user?.cardUpgrades) ? user.cardUpgrades : [];
  const match = upgrades.find((upgrade) =>
    String(upgrade?.card?._id || upgrade?.card || '') === String(cardId || '')
  );
  return normalizeUpgradeLevel(match?.upgradeLevel);
}

function upgradedValue(baseValue, level) {
  const base = Number(baseValue);
  if (!Number.isFinite(base)) return 0;
  return Math.round(base * (1 + normalizeUpgradeLevel(level) * 0.10));
}

function effectiveCard(cardDocument, level = 0) {
  const card = typeof cardDocument?.toObject === 'function'
    ? cardDocument.toObject()
    : { ...(cardDocument || {}) };
  const upgradeLevel = normalizeUpgradeLevel(level);
  const baseDano = Number(card.dano) || 0;
  const baseAlcance = Number(card.alcance) || 0;
  const baseVidaQueDa = Number(card.vidaQueDa || card.vida) || 0;

  card.upgradeLevel = upgradeLevel;
  card.baseValues = {
    dano: baseDano,
    alcance: baseAlcance,
    vidaQueDa: baseVidaQueDa,
  };

  if (baseDano > 0) {
    card.dano = upgradedValue(baseDano, upgradeLevel);
  }
  if (card.tipoArma === 'Proyectil' && baseAlcance > 0) {
    card.alcance = upgradedValue(baseAlcance, upgradeLevel);
  }
  if (card.tipoArma === 'Vida' && baseVidaQueDa > 0) {
    const healing = upgradedValue(baseVidaQueDa, upgradeLevel);
    card.vidaQueDa = healing;
    card.vida = healing;
  }

  return card;
}

module.exports = {
  MAX_UPGRADE_LEVEL,
  UPGRADE_COSTS,
  effectiveCard,
  normalizeUpgradeLevel,
  upgradeLevelForUser,
  upgradedValue,
};
