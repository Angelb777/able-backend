const express = require('express');
const { randomInt } = require('crypto');
const { verifyToken, checkRole } = require('../middlewares/authMiddleware');
const User = require('../models/User');
const Card = require('../models/Card');

const router = express.Router();
const VERSION = 1;
const STEPS = [
  'mapBasics', 'movementRewards', 'openProfile', 'closeProfile', 'directions', 'store',
  'rewards', 'openCards', 'gameMode', 'deck', 'backpack',
  'replacementCooldown', 'cardCooldown', 'upgrades', 'openRoulette',
  'projectileSpin', 'placementSpin', 'returnHome', 'openProjectileCards',
  'selectProjectile', 'aimProjectile', 'openPlacementCards',
  'selectPlacement', 'completed',
];

router.use(verifyToken, checkRole(['cliente']));

function payload(user) {
  const onboarding = user?.onboarding;
  const eligible = onboarding?.version === VERSION;
  return {
    eligible,
    version: VERSION,
    status: eligible ? onboarding.status : 'ineligible',
    step: eligible ? onboarding.step : null,
    projectileCardId: onboarding?.projectileCard
      ? String(onboarding.projectileCard._id || onboarding.projectileCard)
      : null,
    placementCardId: onboarding?.placementCard
      ? String(onboarding.placementCard._id || onboarding.placementCard)
      : null,
  };
}

function publicCard(card) {
  if (!card) return null;
  const raw = typeof card.toObject === 'function' ? card.toObject() : card;
  return { ...raw, _id: String(raw._id) };
}

function activeOnboarding(user) {
  return user?.onboarding?.version === VERSION &&
    user.onboarding.status === 'active';
}

router.get('/', async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id)
      .select('+onboarding.spinRequestIds onboarding')
      .lean();
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    const response = payload(user);
    // Apuntar es un estado puramente de interfaz. Tras reiniciar, se vuelve a
    // seleccionar la misma carta y se reconstruye el gesto sin duplicar premio.
    if (response.step === 'aimProjectile') response.step = 'selectProjectile';
    return res.json(response);
  } catch (error) {
    return next(error);
  }
});

router.post('/progress', async (req, res, next) => {
  try {
    const nextStep = String(req.body?.step || '');
    const nextIndex = STEPS.indexOf(nextStep);
    if (nextIndex < 0 || nextStep === 'completed') {
      return res.status(400).json({ error: 'Paso de onboarding no válido' });
    }
    const user = await User.findById(req.user.id).select('onboarding');
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (!activeOnboarding(user)) {
      return res.status(409).json({ error: 'El onboarding no está activo' });
    }
    const currentIndex = STEPS.indexOf(user.onboarding.step);
    if (nextIndex < currentIndex || nextIndex > currentIndex + 1) {
      return res.status(409).json({ error: 'Transición de onboarding no válida' });
    }
    user.onboarding.step = nextStep;
    await user.save();
    return res.json(payload(user));
  } catch (error) {
    return next(error);
  }
});

router.post('/skip', async (req, res, next) => {
  try {
    const user = await User.findOneAndUpdate(
      {
        _id: req.user.id,
        'onboarding.version': VERSION,
        'onboarding.status': 'active',
      },
      {
        $set: {
          'onboarding.status': 'skipped',
          'onboarding.skippedAt': new Date(),
        },
      },
      { new: true },
    );
    if (!user) {
      const current = await User.findById(req.user.id).select('onboarding').lean();
      if (!current) return res.status(404).json({ error: 'Usuario no encontrado' });
      return res.json(payload(current));
    }
    return res.json(payload(user));
  } catch (error) {
    return next(error);
  }
});

router.post('/complete', async (req, res, next) => {
  try {
    const user = await User.findOneAndUpdate(
      {
        _id: req.user.id,
        'onboarding.version': VERSION,
        'onboarding.status': 'active',
        'onboarding.step': 'selectPlacement',
      },
      {
        $set: {
          'onboarding.status': 'completed',
          'onboarding.step': 'completed',
          'onboarding.completedAt': new Date(),
        },
      },
      { new: true },
    );
    if (!user) return res.status(409).json({ error: 'El onboarding no puede completarse todavía' });
    return res.json(payload(user));
  } catch (error) {
    return next(error);
  }
});

async function chooseCard(user, kind) {
  const types = kind === 'projectile'
    ? ['Proyectil']
    : ['Arrastre', 'Trampa', 'Invocacion'];
  const cards = await Card.find({ tipoArma: { $in: types } });
  if (!cards.length) return null;
  const owned = new Set((user.cartas || []).map(String));
  const unowned = cards.filter((card) => !owned.has(String(card._id)));
  const candidates = unowned.length ? unowned : cards;
  return candidates[randomInt(candidates.length)];
}

function equipForTutorial(user, cardId) {
  user.cartas = user.cartas || [];
  user.mazo = user.mazo || [];
  if (!user.cartas.some((id) => String(id) === String(cardId))) {
    user.cartas.push(cardId);
  }
  if (user.mazo.some((id) => String(id) === String(cardId))) return;
  if (user.mazo.length >= 4) user.mazo.pop();
  user.mazo.push(cardId);
}

router.post('/spin', async (req, res, next) => {
  try {
    const kind = String(req.body?.kind || '');
    const requestId = String(req.body?.requestId || '');
    if (!['projectile', 'placement'].includes(kind)) {
      return res.status(400).json({ error: 'Tipo de tirada no válido' });
    }
    if (requestId.length < 8 || requestId.length > 160) {
      return res.status(400).json({ error: 'requestId inválido' });
    }
    let user = await User.findById(req.user.id)
      .select('+onboarding.spinRequestIds onboarding cartas mazo stepcoins');
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (!activeOnboarding(user)) {
      return res.status(409).json({ error: 'El onboarding no está activo' });
    }

    const field = kind === 'projectile' ? 'projectileCard' : 'placementCard';
    const expectedStep = kind === 'projectile' ? 'projectileSpin' : 'placementSpin';
    const nextStep = kind === 'projectile' ? 'placementSpin' : 'returnHome';
    if (kind === 'placement' && !user.onboarding.projectileCard) {
      return res.status(409).json({ error: 'Completa primero la tirada de proyectil' });
    }

    let card = user.onboarding[field]
      ? await Card.findById(user.onboarding[field])
      : null;
    if (!card) {
      if (user.onboarding.step !== expectedStep) {
        return res.status(409).json({ error: 'Esta tirada especial no está disponible' });
      }
      card = await chooseCard(user, kind);
      if (!card) return res.status(409).json({ error: 'No hay cartas compatibles disponibles' });

      const claimed = await User.findOneAndUpdate(
        {
          _id: req.user.id,
          'onboarding.version': VERSION,
          'onboarding.status': 'active',
          'onboarding.step': expectedStep,
          [`onboarding.${field}`]: { $exists: false },
        },
        {
          $set: {
            [`onboarding.${field}`]: card._id,
            'onboarding.step': nextStep,
          },
          $addToSet: {
            cartas: card._id,
            'onboarding.spinRequestIds': requestId,
          },
        },
        { new: true },
      ).select('+onboarding.spinRequestIds onboarding cartas mazo stepcoins');

      if (claimed) {
        user = claimed;
      } else {
        user = await User.findById(req.user.id)
          .select('+onboarding.spinRequestIds onboarding cartas mazo stepcoins');
        if (!activeOnboarding(user)) {
          return res.status(409).json({ error: 'El onboarding no está activo' });
        }
        const storedCardId = user.onboarding[field];
        if (!storedCardId) {
          return res.status(409).json({ error: 'La tirada especial está en proceso' });
        }
        card = await Card.findById(storedCardId);
      }
    }

    equipForTutorial(user, card._id);
    await User.updateOne(
      {
        _id: req.user.id,
        'onboarding.status': 'active',
        [`onboarding.${field}`]: card._id,
      },
      {
        $set: { mazo: user.mazo },
        $addToSet: { cartas: card._id },
      },
    );

    return res.json({
      ...payload(user),
      resultado: 'Carta aleatoria',
      nuevosStepcoins: user.stepcoins,
      nuevaCarta: publicCard(card),
      onboardingKind: kind,
      free: true,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
module.exports.STEPS = STEPS;
module.exports.payload = payload;
module.exports.equipForTutorial = equipForTutorial;
