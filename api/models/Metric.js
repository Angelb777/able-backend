// models/Metric.js
const mongoose = require("mongoose");

const metricSchema = new mongoose.Schema({
  type: { type: String, enum: ['monthly', 'yearly'], required: true },
  period: { type: String, required: true }, // '2025-07' o '2025'
  values: {
    totalUsers: Number,
    newUsers: Number,
    activeUsers: Number,
    recurrentUsers: Number,
    calculationVersion: Number,
    payingUsers: Number,
    payingUsersPercent: Number,
    totalRevenue: Number,
    avgTicket: Number
  },
  createdAt: { type: Date, default: Date.now }
});

metricSchema.index(
  { type: 1, period: 1 },
  { unique: true, name: 'metric_type_period_unique' }
);

module.exports = mongoose.model("Metric", metricSchema);
