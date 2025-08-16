// api/routes/paypal.js
const express = require('express');
const fetch = require('node-fetch');
const Product = require('../models/Product');
const Order = require('../models/Order');

const router = express.Router();

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
router.post('/create-order', async (req, res) => {
  try {
    const { productId, qty = 1, notes, shipping, billing } = req.body || {};

    if (!productId) {
      return res.status(400).json({ error: 'productId requerido' });
    }

    const product = await Product.findById(productId).lean();
    if (!product || product.active === false) {
      return res.status(400).json({ error: 'Producto no disponible' });
    }

    const safeQty = Math.max(1, parseInt(qty || 1, 10));
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
      notes,
      shipping,
      billing,
      currency: 'USD',
      total,
      paymentProvider: 'paypal',
      paid: false
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
router.post('/capture-order', async (req, res) => {
  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ error: 'orderId requerido' });

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

    // Marca pedido local como pagado
    if (referenceId) {
      await Order.findByIdAndUpdate(referenceId, {
        paid: status === 'COMPLETED',
        providerStatus: status
      });
    } else {
      await Order.findOneAndUpdate(
        { providerOrderId: orderId },
        { paid: status === 'COMPLETED', providerStatus: status }
      );
    }

    return res.json({ status });
  } catch (err) {
    console.error('❌ capture-order failed:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
