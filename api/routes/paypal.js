// api/routes/paypal.js
const express = require('express');
const Product = require('../models/Product');
const Order = require('../models/Order');
const mongoose = require('mongoose');
const { createLimiter } = require('../middlewares/securityLimits');

const router = express.Router();
const createOrderLimiter = createLimiter({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  code: 'PAYMENT_RATE_LIMITED',
  message: 'Demasiados intentos de pago. Espera unos minutos.',
});
const captureOrderLimiter = createLimiter({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  code: 'PAYMENT_RATE_LIMITED',
  message: 'Demasiados intentos de pago. Espera unos minutos.',
});

/* ========================
   ENV / Constantes PayPal
======================== */
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_SECRET    = process.env.PAYPAL_SECRET || '';
const PAYPAL_ENV       = (process.env.PAYPAL_ENV || 'sandbox').toLowerCase(); // 'sandbox' | 'live'
const BASE = PAYPAL_ENV === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
  console.warn('⚠️  Falta PAYPAL_CLIENT_ID o PAYPAL_SECRET en .env');
}
console.log(`🟡 PayPal env: ${PAYPAL_ENV}  |  Base: ${BASE}`);

/* ========================
   Helpers
======================== */
async function getAccessToken() {
  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('❌ PayPal token error:', data);
    throw new Error('paypal_token_error');
  }
  return data.access_token;
}

function centsToUsdString(cents) {
  // 9900 -> "99.00"
  const n = Number(cents || 0);
  return (n / 100).toFixed(2);
}

function paymentsAvailable() {
  return PAYPAL_CLIENT_ID && PAYPAL_SECRET &&
    !PAYPAL_CLIENT_ID.startsWith('pending-') &&
    !PAYPAL_SECRET.startsWith('pending-') &&
    (process.env.NODE_ENV !== 'production' || PAYPAL_ENV === 'live');
}

function cleanText(value, maxLength) {
  return String(value || '').normalize('NFKC').trim().slice(0, maxLength);
}

function cleanAddress(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    name: cleanText(raw.name, 100), phone: cleanText(raw.phone, 32),
    taxId: cleanText(raw.taxId, 40), address1: cleanText(raw.address1, 180),
    city: cleanText(raw.city, 100), state: cleanText(raw.state, 100),
    zip: cleanText(raw.zip, 24), country: cleanText(raw.country, 2).toUpperCase(),
  };
}

/* ========================
   Rutas públicas
======================== */

// SDK config pública para el frontend
router.get('/config', (_req, res) => {
  res.json({ clientId: PAYPAL_CLIENT_ID, currency: 'USD' });
});

/* ========================
   Crear Order
======================== */
router.post('/create-order', createOrderLimiter, async (req, res) => {
  try {
    if (!paymentsAvailable()) {
      return res.status(503).json({ error: 'payments_not_configured' });
    }
    const { productId, qty = 1, shipping, billing } = req.body || {};
    const requestId = cleanText(req.body?.requestId, 120);

    if (!mongoose.isValidObjectId(productId) ||
        !/^[A-Za-z0-9._:-]{8,120}$/.test(requestId)) {
      return res.status(400).json({ error: 'productId o requestId no valido' });
    }

    const previous = await Order.findOne({ clientRequestId: requestId }).lean();
    if (previous?.providerOrderId) return res.json({ id: previous.providerOrderId, duplicate: true });
    if (previous) return res.status(409).json({ error: 'payment_request_in_progress' });

    const product = await Product.findById(productId).lean();
    if (!product || product.active === false) {
      return res.status(400).json({ error: 'Producto no disponible' });
    }

    const safeQty = Number(qty);
    if (!Number.isInteger(safeQty) || safeQty < 1 || safeQty > 10 ||
        !Number.isSafeInteger(product.price) || product.price < 1) {
      return res.status(400).json({ error: 'Cantidad o precio no valido' });
    }
    const subtotal = product.price * safeQty; // price en centavos
    const total = subtotal; // aquí podrías sumar envío/impuestos

    // 1) Crear pedido local (unpaid)
    const local = await Order.create({
      items: [{
        productId,
        name: product.name,
        unitPrice: product.price,
        qty: safeQty,
        subtotal
      }],
      notes: cleanText(req.body?.notes, 500),
      shipping: cleanAddress(shipping),
      billing: cleanAddress(billing),
      currency: 'USD',
      total,
      paymentProvider: 'paypal',
      paid: false,
      clientRequestId: requestId,
    });

    // 2) Crear order en PayPal
    const access = await getAccessToken();
    const ppRes = await fetch(`${BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${access}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: String(local._id),
          amount: {
            currency_code: 'USD',
            value: centsToUsdString(total)
          },
          description: product.name
        }]
      })
    });

    const data = await ppRes.json();

    if (!ppRes.ok) {
      console.error('❌ PayPal create-order error:', data);
      // Limpia o marca el pedido local si quieres
      await Order.findByIdAndUpdate(local._id, {
        providerStatus: data?.name || 'CREATE_ERROR'
      });
      return res.status(400).json({ error: 'paypal_create_error', details: data });
    }

    // Guarda referencia de PayPal en el pedido local
    await Order.findByIdAndUpdate(local._id, {
      providerOrderId: data.id,
      providerStatus: data.status
    });

    return res.json({ id: data.id }); // <-- orderId para el SDK
  } catch (err) {
    console.error('❌ create-order failed:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

/* ========================
   Capturar pago
======================== */
router.post('/capture-order', captureOrderLimiter, async (req, res) => {
  try {
    if (!paymentsAvailable()) {
      return res.status(503).json({ error: 'payments_not_configured' });
    }
    const orderId = cleanText(req.body?.orderId, 64);
    if (!/^[A-Za-z0-9-]{8,64}$/.test(orderId)) {
      return res.status(400).json({ error: 'orderId no valido' });
    }
    const localOrder = await Order.findOne({ providerOrderId: orderId });
    if (!localOrder) return res.status(404).json({ error: 'order_not_found' });
    if (localOrder.paid) return res.json({ status: 'COMPLETED', duplicate: true });

    const access = await getAccessToken();

    // 👇 PayPal requiere Content-Type JSON y (aunque sea) body JSON vacío
    const capRes = await fetch(`${BASE}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${access}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    });

    // Si quieres depurar más:
    // const raw = await capRes.text(); console.log('CAP RAW:', raw); const data = JSON.parse(raw);
    const data = await capRes.json();

    if (!capRes.ok) {
      console.error('❌ PayPal capture error:', data);
      return res.status(400).json({ error: 'paypal_capture_error', details: data });
    }

    const status = data?.status; // "COMPLETED"
    const referenceId = data?.purchase_units?.[0]?.reference_id;
    const capturedAmount = data?.purchase_units?.[0]?.payments?.captures?.[0]?.amount;
    const validCapture = status === 'COMPLETED' &&
      String(referenceId || '') === String(localOrder._id) &&
      capturedAmount?.currency_code === localOrder.currency &&
      capturedAmount?.value === centsToUsdString(localOrder.total);
    if (!validCapture) {
      console.error('PayPal devolvio una captura que no coincide con el pedido local', orderId);
      return res.status(409).json({ error: 'payment_verification_failed' });
    }

    await Order.updateOne(
      { _id: localOrder._id, providerOrderId: orderId, paid: false },
      { $set: { paid: true, providerStatus: status } }
    );

    return res.json({ status });
  } catch (err) {
    console.error('❌ capture-order failed:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
