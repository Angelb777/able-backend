const express = require('express');
const router = express.Router();
const User = require('../models/User');

// Obtener todos los usuarios (sin contraseña)
router.get('/', async (req, res) => {
  try {
    const users = await User.find().select('-password');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
});

// Eliminar usuario
router.delete("/:id", async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.json({ message: "Usuario eliminado" });
  } catch (err) {
    res.status(500).json({ error: "Error al eliminar usuario" });
  }
});

// Obtener estadísticas generales de usuarios
router.get('/stats', async (req, res) => {
  try {
    const total = await User.countDocuments();
    const clientes = await User.countDocuments({ role: 'cliente' });
    const comercios = await User.countDocuments({ role: 'comercio' });

    res.json({ total, clientes, comercios });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// Obtener un usuario por ID (sin contraseña y con skins compradas pobladas)
router.get('/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-password')
      .populate('skinsCompradas'); // 👈 AÑADE ESTO
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener usuario' });
  }
});

// Obtener usuario con cartas pobladas
router.get('/con-cartas/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-password')
      .populate('cartas'); // 👈 Aquí se cargan las cartas completas
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener usuario con cartas' });
  }
});

// ✅ Ruta para actualizar el nombre del usuario
router.put('/:id', async (req, res) => {
  try {
    const { nombre } = req.body;
    if (!nombre) {
      return res.status(400).json({ error: 'El nombre es obligatorio' });
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { nombre },
      { new: true } // devuelve el usuario actualizado
    ).select('-password');

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json(user);
  } catch (err) {
    console.error("❌ Error al actualizar el nombre:", err);
    res.status(500).json({ error: 'Error al actualizar el nombre del usuario' });
  }
});

const Skin = require('../models/Skin'); // ✅ necesario para .populate()

// 🆕 Obtener la URL de la skin seleccionada del usuario
// 🧪 DEBUG: ver datos crudos de skinSeleccionada
router.get('/:id/skin', async (req, res) => {
  try {
    const userId = req.params.id;

    const user = await User.findById(userId).populate('skinSeleccionada');
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    console.log('🧪 User.skinSeleccionada:', user.skinSeleccionada);

    if (!user.skinSeleccionada) {
      return res.status(404).json({ error: 'El usuario no tiene skinSeleccionada' });
    }

    if (
      !user.skinSeleccionada.scripts ||
      !Array.isArray(user.skinSeleccionada.scripts.parado) ||
      user.skinSeleccionada.scripts.parado.length === 0
    ) {
      return res.status(404).json({ error: 'La skin no tiene imagen parada' });
    }

    const skinUrl = user.skinSeleccionada.scripts.parado[0];
    res.json({ skinUrl });

  } catch (err) {
    console.error('❌ Error al obtener skin del usuario:', err);
    res.status(500).json({ error: 'Error al obtener skin del usuario' });
  }
});

// ✅ Asignar una skin como seleccionada al usuario
router.put('/:id/skin', async (req, res) => {
  try {
    const userId = req.params.id;
    const { skinId } = req.body;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const { Types } = require('mongoose');
    const skinObjectId = new Types.ObjectId(skinId);

    if (!user.skinsCompradas.some(id => id.equals(skinObjectId))) {
      return res.status(400).json({ error: 'El usuario no ha comprado esta skin' });
    }

    user.skinSeleccionada = skinId;
    await user.save();

    console.log('✅ Skin seleccionada correctamente:', skinId);
    res.json({ message: '✅ Skin seleccionada correctamente', skinSeleccionada: skinId });
  } catch (err) {
    console.error("❌ Error al asignar skin:", err);
    res.status(500).json({ error: 'Error interno al seleccionar skin' });
  }
});


module.exports = router;
