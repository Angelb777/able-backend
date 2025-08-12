// models/Metric.js
const mongoose = require("mongoose");

const metricSchema = new mongoose.Schema({
  type: { type: String, enum: ['monthly', 'yearly'], required: true },
  period: { type: String, required: true }, // '2025-07' o '2025'
  values: {
    totalUsers: Number,
    newUsers: Number,
    payingUsers: Number,
    payingUsersPercent: Number,
    totalRevenue: Number,
    avgTicket: Number
  },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Metric", metricSchema);
