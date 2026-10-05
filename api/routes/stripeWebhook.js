const express = require('express');
const { handleStripeEvent, stripeClient } = require('../services/stripeMapSubscriptions');

const router = express.Router();

router.post('/', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
  const signingSecret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!signingSecret) {
    return res.status(503).json({ error: 'El webhook de Stripe no está configurado' });
  }
  let event;
  try {
    event = stripeClient().webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      signingSecret,
    );
  } catch (error) {
    return res.status(400).json({ error: 'Firma de Stripe no válida' });
  }
  try {
    await handleStripeEvent(event);
    return res.json({ received: true });
  } catch (error) {
    console.error('[STRIPE WEBHOOK] No se pudo procesar el evento:', event.id, error);
    return res.status(500).json({ error: 'No se pudo procesar el evento de Stripe' });
  }
});

module.exports = router;
