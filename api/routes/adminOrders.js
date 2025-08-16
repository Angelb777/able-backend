// api/routes/adminOrders.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Order = require('../models/Order');
const { verifyToken, checkRole } = require('../middlewares/authMiddleware');

// --- Helpers de seguridad/validación ---
const toBool = (v, def = true) => {
  if (v === undefined || v === null) return def;
  const s = String(v).toLowerCase().trim();
  return s === '1' || s === 'true' || s === 'on' || s === 'yes';
};

const numInRange = (v, def, min, max) => {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
};

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Lista blanca de sort
const SORT_WHITELIST = new Set([
  'createdAt',
  'total',
  'providerStatus',
  'paid',
  'providerOrderId',
  // 'fulfillment.shipped', // si quieres permitir ordenar por enviado/desenviado
]);

const buildSort = (sortParam) => {
  const s = String(sortParam || '-createdAt').trim();
  const parts = s.split(',').map(p => p.trim()).filter(Boolean);
  const sort = {};
  for (const p of parts) {
    let field = p;
    let dir = 1;
    if (p.startsWith('-')) { field = p.slice(1); dir = -1; }
    if (SORT_WHITELIST.has(field)) sort[field] = dir;
  }
  if (Object.keys(sort).length === 0) {
    sort.createdAt = -1; // fallback
  }
  return sort;
};

// ⬇️ Solo admins
const adminOnly = [verifyToken, checkRole(['admin'])];

// --- Filtros compartidos ---
const buildFilters = (query) => {
  const filters = {};
  const paid = toBool(query.paid, true);
  if (paid !== undefined) filters.paid = paid;

  const q = (query.q || '').trim();
  if (q) {
    const rx = new RegExp(escapeRegExp(q), 'i');
    filters.$or = [
      { 'shipping.name': rx },
      { 'billing.name': rx },
      { 'items.name': rx },
      { providerOrderId: rx },
      { customerEmail: rx }, // si lo guardas
    ];
  }

  // (Opcional) Filtro por envío: ?ship=true|false
  if (typeof query.ship !== 'undefined') {
    const ship = toBool(query.ship, true);
    filters['fulfillment.shipped'] = ship;
  }

  return filters;
};

// --- Proyección común para el listado ---
const LIST_PROJECTION = {
  createdAt: 1,
  paid: 1,
  providerStatus: 1,
  providerOrderId: 1,
  currency: 1,
  total: 1,
  shipping: { name: 1, phone: 1 },
  'billing.name': 1,
  items: { $slice: 1 }, // preview; detalle trae todo
  fulfillment: { shipped: 1, shippedAt: 1, trackingNumber: 1 }, // ⬅️ NUEVO
};

// GET /api/admin/orders  (lista paginada)
router.get('/orders', adminOnly, async (req, res) => {
  try {
    const page  = numInRange(req.query.page, 1, 1, 5000);
    const limit = numInRange(req.query.limit, 20, 1, 100);
    const sort  = buildSort(req.query.sort);
    const filters = buildFilters(req.query);

    const [items, total] = await Promise.all([
      Order.find(filters)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .select(LIST_PROJECTION)
        .lean(),
      Order.countDocuments(filters)
    ]);

    const pages = Math.max(1, Math.ceil(total / limit));
    res.json({ items, page, limit, total, pages });
  } catch (err) {
    console.error('GET /api/admin/orders error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/orders/:id (detalle)
router.get('/orders/:id', adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const order = await Order.findById(id).lean();
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (err) {
    console.error('GET /api/admin/orders/:id error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/orders/export.csv (exportación CSV con streaming O(1))
router.get('/orders/export.csv', adminOnly, async (req, res) => {
  try {
    const filters = buildFilters(req.query);
    const sort = buildSort(req.query.sort);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');

    // BOM para Excel
    res.write('\uFEFF');

    // Cabecera CSV
    const header = [
      'createdAt',
      'paid',
      'providerStatus',
      'providerOrderId',
      'currency',
      'total',
      'shipping_name',
      'shipping_phone',
      'shipping_address1',
      'shipping_city',
      'shipping_state',
      'shipping_zip',
      'shipping_country',
      'billing_name',
      'billing_taxId',
      'billing_address1',
      'billing_city',
      'billing_state',
      'billing_zip',
      'billing_country',
      'fulfillment_shipped',       // ⬅️ NUEVO
      'fulfillment_shippedAt',     // ⬅️ NUEVO
      'fulfillment_tracking',      // ⬅️ NUEVO
      'items'
    ].join(',') + '\n';
    res.write(header);

    const cursor = Order.find(filters)
      .sort(sort)
      .select({
        createdAt: 1, paid: 1, providerStatus: 1, providerOrderId: 1,
        currency: 1, total: 1,
        shipping: 1, billing: 1, items: 1,
        fulfillment: 1, // ⬅️ NUEVO
      })
      .lean()
      .cursor();

    const csvSafe = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    cursor.on('data', (doc) => {
      const itemsStr = Array.isArray(doc.items)
        ? doc.items.map(it => `${it.name} x ${it.qty} @ ${it.unitPrice}`).join('; ')
        : '';
      const row = [
        csvSafe(doc.createdAt?.toISOString?.() || ''),
        csvSafe(doc.paid),
        csvSafe(doc.providerStatus),
        csvSafe(doc.providerOrderId),
        csvSafe(doc.currency),
        csvSafe(doc.total),
        csvSafe(doc.shipping?.name),
        csvSafe(doc.shipping?.phone),
        csvSafe(doc.shipping?.address1),
        csvSafe(doc.shipping?.city),
        csvSafe(doc.shipping?.state),
        csvSafe(doc.shipping?.zip),
        csvSafe(doc.shipping?.country),
        csvSafe(doc.billing?.name),
        csvSafe(doc.billing?.taxId),
        csvSafe(doc.billing?.address1),
        csvSafe(doc.billing?.city),
        csvSafe(doc.billing?.state),
        csvSafe(doc.billing?.zip),
        csvSafe(doc.billing?.country),
        csvSafe(doc.fulfillment?.shipped),
        csvSafe(doc.fulfillment?.shippedAt ? new Date(doc.fulfillment.shippedAt).toISOString() : ''),
        csvSafe(doc.fulfillment?.trackingNumber || ''),
        csvSafe(itemsStr)
      ].join(',') + '\n';
      res.write(row);
    });

    cursor.on('end', () => res.end());
    cursor.on('error', (e) => {
      console.error('CSV cursor error:', e);
      res.end();
    });
  } catch (err) {
    console.error('GET /api/admin/orders/export.csv error:', err);
    res.status(500).end('Server error');
  }
});

// PATCH /api/admin/orders/:id/ship  { shipped: boolean, trackingNumber?: string }
router.patch('/orders/:id/ship', adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const { shipped, trackingNumber } = req.body || {};
    if (typeof shipped !== 'boolean') {
      return res.status(400).json({ error: 'shipped must be boolean' });
    }

    const update = {
      'fulfillment.shipped': shipped,
      'fulfillment.trackingNumber': trackingNumber || undefined,
      'fulfillment.shippedBy': req.user.id,
    };
    if (shipped) {
      update['fulfillment.shippedAt'] = new Date();
    } else {
      update['fulfillment.shippedAt'] = undefined;
    }

    const order = await Order.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true, lean: true }
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (err) {
    console.error('PATCH /api/admin/orders/:id/ship error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
