const express = require('express');
const Order = require('../models/Order');
const router = express.Router();

// Admin: listar pedidos pagados
router.get('/paid', async (req,res)=>{
  // TODO: proteger con auth de admin
  const orders = await Order.find({ paid:true }).sort({ createdAt:-1 }).lean();
  res.json(orders);
});

module.exports = router;
