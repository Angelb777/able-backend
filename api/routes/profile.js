const express = require('express');
const router = express.Router();
const { verifyToken, requireSelfOrAdmin } = require('../middlewares/authMiddleware');
const User = require('../models/User');

// Actualizar nombre del usuario autenticado
router.patch('/:id', verifyToken, requireSelfOrAdmin('id'), async (req, res) => {
  try {
    const nombre = String(req.body?.nombre || '').normalize('NFKC').trim();
    if (!nombre || nombre.length > 100) {
      return res.status(400).json({ error: 'Nombre no valido' });
    }
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
