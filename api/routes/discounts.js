// api/routes/discounts.js

const express = require('express');
const router = express.Router();
const { verifyToken, checkRole } = require('../middlewares/authMiddleware');

// Crear descuento (solo comercio)
router.post('/crear', verifyToken, checkRole(['comercio']), (req, res) => {
  res.json({ mensaje: '✅ Descuento creado correctamente (demo)' });
});

// Obtener descuentos del comercio autenticado
router.get('/mios', verifyToken, checkRole(['comercio']), (req, res) => {
  res.json({ mensaje: '📦 Aquí van los descuentos del comercio con ID: ' + req.user.id });
});

module.exports = router;
