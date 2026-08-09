const express = require("express");
const router = express.Router();
const { verifyToken, checkRole } = require('../middlewares/authMiddleware');
const adminOnly = [verifyToken, checkRole(['admin'])];
const Metric = require("../models/Metric");
const User = require("../models/User");
const Payment = require("../models/Payment");
const XLSX = require("xlsx");

// 🔁 Calcular métricas y guardarlas
router.post("/generate", ...adminOnly, async (req, res) => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0 a 11
  const nextMonthDate = new Date(year, month + 1, 1); // primer día del mes siguiente
  const thisMonthDate = new Date(year, month, 1);     // primer día del mes actual

  const monthString = String(month + 1).padStart(2, "0");
  const period = `${year}-${monthString}`;
  const yearPeriod = `${year}`;

  try {
    // Usuarios
    const totalUsers = await User.countDocuments();
    const newUsersMonth = await User.countDocuments({
  createdAt: {
    $gte: thisMonthDate,
    $lt: nextMonthDate,
  }
});
    const newUsersYear = await User.countDocuments({
      createdAt: {
        $gte: new Date(`${yearPeriod}-01-01T00:00:00Z`),
        $lt: new Date(year + 1, 0, 1) // enero del siguiente año
      }
    });

    // Pagos
    const allPayments = await Payment.find();
    const monthPayments = allPayments.filter(p => {
    const d = new Date(p.fecha);
    return !isNaN(d) && d.toISOString().startsWith(period);
    });

    const yearPayments = allPayments.filter(p => {
    const d = new Date(p.fecha);
    return !isNaN(d) && d.toISOString().startsWith(yearPeriod);
    });

    const uniquePayers = [...new Set(allPayments.map(p => p.userId.toString()))];
    const uniquePayersMonth = [...new Set(monthPayments.map(p => p.userId.toString()))];
    const uniquePayersYear = [...new Set(yearPayments.map(p => p.userId.toString()))];

    const totalRevenue = allPayments.reduce((sum, p) => sum + p.cantidad, 0);
    const totalRevenueMonth = monthPayments.reduce((sum, p) => sum + p.cantidad, 0);
    const totalRevenueYear = yearPayments.reduce((sum, p) => sum + p.cantidad, 0);

    const ticketMedio = totalRevenue / (allPayments.length || 1);
    const ticketMedioMonth = totalRevenueMonth / (monthPayments.length || 1);
    const ticketMedioYear = totalRevenueYear / (yearPayments.length || 1);

    // Guardar métrica mensual
    await Metric.findOneAndUpdate(
      { type: "monthly", period },
      {
        type: "monthly",
        period,
        values: {
          totalUsers,
          newUsers: newUsersMonth,
          payingUsers: uniquePayersMonth.length,
          payingUsersPercent: +(uniquePayersMonth.length * 100 / totalUsers).toFixed(2),
          totalRevenue: totalRevenueMonth,
          avgTicket: +ticketMedioMonth.toFixed(2),
        }
      },
      { upsert: true }
    );

    // Guardar métrica anual
    await Metric.findOneAndUpdate(
      { type: "yearly", period: yearPeriod },
      {
        type: "yearly",
        period: yearPeriod,
        values: {
          totalUsers,
          newUsers: newUsersYear,
          payingUsers: uniquePayersYear.length,
          payingUsersPercent: +(uniquePayersYear.length * 100 / totalUsers).toFixed(2),
          totalRevenue: totalRevenueYear,
          avgTicket: +ticketMedioYear.toFixed(2),
        }
      },
      { upsert: true }
    );

    res.json({ message: "✅ Métricas actualizadas." });
  } catch (err) {
    console.error("❌ Error al generar métricas:", err);
    res.status(500).json({ error: "Error al generar métricas" });
  }
});

// 📄 Obtener métricas por tipo
router.get("/", ...adminOnly, async (req, res) => {
  const type = req.query.type || "monthly"; // monthly | yearly
  const metrics = await Metric.find({ type }).sort({ period: -1 });
  res.json(metrics);
});

// 📥 Exportar a Excel
router.get("/excel", ...adminOnly, async (req, res) => {
  const type = req.query.type || "monthly";
  const metrics = await Metric.find({ type }).sort({ period: -1 });

  const data = metrics.map((m) => ({
    Periodo: m.period,
    "Usuarios totales": m.values.totalUsers,
    "Usuarios nuevos": m.values.newUsers,
    "Usuarios que han pagado": m.values.payingUsers,
    "% que han pagado": m.values.payingUsersPercent,
    "Facturación total": m.values.totalRevenue,
    "Ticket medio": m.values.avgTicket,
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, "Métricas");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  res.setHeader("Content-Disposition", `attachment; filename=metrics-${type}.xlsx`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buffer);
});

module.exports = router;
