const express = require('express');
const router = express.Router();
const { verifyToken, checkRole } = require('../middlewares/authMiddleware');
const User = require('../models/User');

// Obtener todos los usuarios (solo admin)
router.get('/users', verifyToken, checkRole(['admin']), async (req, res) => {
  try {
    const usuarios = await User.find({}, '-password'); // excluye el campo password
    res.json(usuarios);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
});

module.exports = router;
