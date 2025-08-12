const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/authMiddleware');
const User = require('../models/User');

// Actualizar nombre del usuario autenticado
router.patch('/:id', verifyToken, async (req, res) => {
  try {
    const { nombre } = req.body;
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { nombre },
      { new: true, select: '-password' }
    );
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar nombre' });
  }
});

module.exports = router;
