const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Skin = require('../models/Skin'); // necesario para fallback

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
router.delete('/:id', async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.json({ message: 'Usuario eliminado' });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar usuario' });
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

// Obtener un usuario por ID (sin contraseña y con skins pobladas)
router.get('/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-password')
      .populate('skinsCompradas')
      .populate('skinSeleccionada');
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
      .populate('cartas');
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener usuario con cartas' });
  }
});

// ✅ Actualizar nombre de usuario
router.put('/:id', async (req, res) => {
  try {
    const { nombre } = req.body;
    if (!nombre) {
      return res.status(400).json({ error: 'El nombre es obligatorio' });
    }
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { nombre },
      { new: true }
    ).select('-password');
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(user);
  } catch (err) {
    console.error('❌ Error al actualizar el nombre:', err);
    res.status(500).json({ error: 'Error al actualizar el nombre del usuario' });
  }
});

// 🆕 Skin activa con fallback que persiste y añade a "Mis Skins"
router.get('/:id/skin', async (req, res) => {
  try {
    const userId = req.params.id;

    // Traer usuario con skinSeleccionada
    const user = await User.findById(userId).populate('skinSeleccionada');
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    // Si ya tiene skin seleccionada con imagen utilizable, úsala
    if (user.skinSeleccionada) {
      const parada0 = user.skinSeleccionada?.scripts?.parado?.[0];
      const portada = user.skinSeleccionada?.portada;
      const skinUrl = parada0 || portada;
      if (skinUrl) {
        return res.json({
          skinUrl,
          skinId: user.skinSeleccionada._id,
          isFallback: false
        });
      }
      // si no tiene imagen utilizable, continuamos con fallback
    }

    // Fallback: cualquier skin disponible (sin requerir 'validada' en el schema)
    const fallback = await Skin.findOne().lean();
    if (!fallback) {
      return res.status(404).json({ error: 'No hay skins disponibles para fallback' });
    }

    // Persistir seleccionada + añadir a Mis Skins sin duplicar
    await User.updateOne(
      { _id: userId },
      {
        $set: { skinSeleccionada: fallback._id },
        $addToSet: { skinsCompradas: fallback._id }
      }
    );

    const skinUrl = fallback.scripts?.parado?.[0] || fallback.portada;

    return res.json({
      skinUrl,
      skinId: fallback._id,
      isFallback: true
    });

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

    // Robustez: asegúrate de que sea array
    if (!Array.isArray(user.skinsCompradas)) user.skinsCompradas = [];

    const { Types } = require('mongoose');
    const skinObjectId = new Types.ObjectId(skinId);

    if (!user.skinsCompradas.some(id => id.equals(skinObjectId))) {
      return res.status(400).json({ error: 'El usuario no ha comprado esta skin' });
    }

    user.skinSeleccionada = skinObjectId;
    await user.save();

    res.json({ message: '✅ Skin seleccionada correctamente', skinSeleccionada: skinObjectId });
  } catch (err) {
    console.error('❌ Error al asignar skin:', err);
    res.status(500).json({ error: 'Error interno al seleccionar skin' });
  }
});

module.exports = router;
