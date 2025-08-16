const express = require('express');
const Product = require('../models/Product');
const router = express.Router();

// Lista simple para catálogo /candados
router.get('/', async (req,res)=>{
  const { category } = req.query;
  const filter = { active:true, ...(category ? {category} : {}) };
  const items = await Product.find(filter).sort({ createdAt:-1 }).lean();
  res.json(items);
});

module.exports = router;
