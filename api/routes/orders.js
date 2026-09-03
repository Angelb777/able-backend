const express = require('express');
const Order = require('../models/Order');
const { verifyToken, checkRole } = require('../middlewares/authMiddleware');
const router = express.Router();

// Admin: listar pedidos pagados
router.get('/paid', verifyToken, checkRole(['admin']), async (req,res)=>{
  const orders = await Order.find({ paid:true }).sort({ createdAt:-1 }).lean();
  res.json(orders);
});

module.exports = router;
