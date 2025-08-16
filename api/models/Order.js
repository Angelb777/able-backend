// models/Order.js
const mongoose = require('mongoose');

const addressSchema = new mongoose.Schema(
  {
    name: String,
    phone: String,
    taxId: String,
    address1: String,
    city: String,
    state: String,
    zip: String,
    country: String,
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    items: [
      {
        productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
        name: String,
        unitPrice: Number, // centavos
        qty: Number,
        subtotal: Number, // centavos
      },
    ],
    notes: String,

    shipping: addressSchema,
    billing: addressSchema,

    currency: { type: String, default: 'USD' },
    total: Number, // centavos

    paymentProvider: {
      type: String,
      enum: ['paypal', 'stripe', 'manual'],
      default: 'paypal',
    },
    providerOrderId: String, // PayPal order id / Stripe session id
    providerStatus: String, // COMPLETED, etc.
    paid: { type: Boolean, default: false },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // opcional

    // ✅ Estado de envío / fulfillment
    fulfillment: {
      shipped: { type: Boolean, default: false },
      shippedAt: { type: Date },
      trackingNumber: { type: String },
      shippedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
  },
  { timestamps: true }
);

// ===== Índices útiles =====
orderSchema.index({ createdAt: -1 });
orderSchema.index({ paid: 1, createdAt: -1 });
orderSchema.index({ providerOrderId: 1 });
orderSchema.index({ 'items.name': 1 });
orderSchema.index({ 'shipping.name': 1 });
orderSchema.index({ 'billing.name': 1 });
orderSchema.index({ 'fulfillment.shipped': 1, createdAt: -1 });

module.exports = mongoose.model('Order', orderSchema);
