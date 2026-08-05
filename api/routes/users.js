const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Skin = require('../models/Skin'); // necesario para fallback
const { verifyToken, checkRole } = require('../middlewares/authMiddleware');
const { publicNickname } = require('../utils/publicIdentity');

function requireSelfOrAdmin(req, res, next) {
  if (req.user.role === 'admin' || String(req.user.id) === String(req.params.id)) return next();
  return res.status(403).json({ error: 'Acceso denegado' });
}

// Obtener datos de perfil del usuario autenticado
router.get('/data', verifyToken, async (req, res) => {
  try {
    // Si tienes JWT, usa req.user.id; si no, temporal: req.query.userId
    const userId = req.user.id;
    if (!userId) return res.status(400).json({ error: 'Falta userId o token' });

    const user = await User.findById(userId).select('-password');
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    // Devuelve SOLO lo que Flutter espera
    const p = user.profile || {};
    return res.json({
      name: p.name || '',
      lastName: p.lastName || '',
      address: p.address || '',
      city: p.city || '',
      country: p.country || '',
      idCardFront: p.idCardFront || '',
      idCardBack: p.idCardBack || '',
      licenseFront: p.licenseFront || '',
      licenseBack: p.licenseBack || '',
    });
  } catch (err) {
    console.error('❌ /api/user/data error', err);
    res.status(500).json({ error: 'Error al obtener datos de perfil' });
  }
});

// Guardar/actualizar perfil del usuario autenticado
router.post('/update', verifyToken, async (req, res) => {
  try {
    // Si tienes JWT, usa req.user.id; si no, temporal: req.body.userId
    const userId = req.user.id;
    if (!userId) return res.status(400).json({ error: 'Falta userId o token' });

    const {
      name, lastName, address, city, country,
      idCardFront, idCardBack, licenseFront, licenseBack
    } = req.body;

    const update = {
      $set: {
        'profile.name': name ?? '',
        'profile.lastName': lastName ?? '',
        'profile.address': address ?? '',
        'profile.city': city ?? '',
        'profile.country': country ?? '',
        'profile.idCardFront': idCardFront ?? '',
        'profile.idCardBack': idCardBack ?? '',
        'profile.licenseFront': licenseFront ?? '',
        'profile.licenseBack': licenseBack ?? '',
      }
    };

    const user = await User.findByIdAndUpdate(userId, update, { new: true }).select('-password');
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    res.json({ ok: true, profile: user.profile || {} });
  } catch (err) {
    console.error('❌ /api/user/update error', err);
    res.status(500).json({ error: 'Error al actualizar datos de perfil' });
  }
});

// Obtener todos los usuarios (sin contraseña)
router.get('/', verifyToken, checkRole(['admin']), async (req, res) => {
  try {
    const users = await User.find().select('-password');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
});

// Eliminar usuario
router.delete('/:id', verifyToken, checkRole(['admin']), async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.json({ message: 'Usuario eliminado' });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar usuario' });
  }
});

// Obtener estadísticas generales de usuarios
router.get('/stats', verifyToken, checkRole(['admin']), async (req, res) => {
  try {
    const total = await User.countDocuments();
    const clientes = await User.countDocuments({ role: 'cliente' });
    const comercios = await User.countDocuments({ role: 'comercio' });

    res.json({ total, clientes, comercios });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// Obtener usuario con cartas pobladas
router.get('/con-cartas/:id', verifyToken, requireSelfOrAdmin, async (req, res) => {
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

router.get('/:id/skins', verifyToken, requireSelfOrAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('skinsCompradas')
      .populate('skinsCompradas');
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ skins: user.skinsCompradas || [] });
  } catch (_error) {
    res.status(500).json({ error: 'Error al obtener skins' });
  }
});

// Obtener un usuario por ID (sin contraseña y con skins pobladas)
router.get('/:id', verifyToken, requireSelfOrAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('nickname fotoPerfil stepcoins skinSeleccionada')
      .populate('skinSeleccionada');
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({
      id: String(user._id),
      nickname: publicNickname(user),
      hasChosenNickname: Boolean(user.nickname),
      needsNickname: !user.nickname,
      avatarUrl: user.fotoPerfil || '',
      stepcoins: user.stepcoins || 0,
      skinSeleccionada: user.skinSeleccionada || null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener usuario' });
  }
});



// ✅ Actualizar nombre de usuario
router.put('/:id', verifyToken, requireSelfOrAdmin, async (req, res) => {
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
          skin: user.skinSeleccionada,
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
      skin: fallback,
      isFallback: true
    });

  } catch (err) {
    console.error('❌ Error al obtener skin del usuario:', err);
    res.status(500).json({ error: 'Error al obtener skin del usuario' });
  }
});

// ✅ Asignar una skin como seleccionada al usuario
router.put('/:id/skin', verifyToken, requireSelfOrAdmin, async (req, res) => {
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

    const selectedSkin = await Skin.findById(skinObjectId);
    res.json({
      message: '✅ Skin seleccionada correctamente',
      skinSeleccionada: skinObjectId,
      skin: selectedSkin
    });
  } catch (err) {
    console.error('❌ Error al asignar skin:', err);
    res.status(500).json({ error: 'Error interno al seleccionar skin' });
  }
});

module.exports = router;
