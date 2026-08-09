const express = require('express');
const router = express.Router();
const Ufo = require('../models/Ufo');
const multer = require('multer');
const { saveImage } = require('../utils/mediaStorage');
const { verifyToken, checkRole } = require('../middlewares/authMiddleware');
const adminOnly = [verifyToken, checkRole(['admin'])];
// Estado aislado del minijuego web legacy. Nunca modifica la configuración
// usada por el runtime multijugador de sockets.
const legacyUfoState = new Map();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype?.startsWith('image/')) {
      return cb(new Error('El archivo del OVNI debe ser una imagen'));
    }
    cb(null, true);
  }
});

// ✅ Crear OVNI
router.post('/', ...adminOnly, upload.fields([
  { name: 'imagenOvni', maxCount: 1 },
  { name: 'imagenBala', maxCount: 1 }
]), async (req, res) => {
  try {
    const imagenOvniFile = req.files?.imagenOvni?.[0];
    const imagenBalaFile = req.files?.imagenBala?.[0];

    const {
      nombre,
      vida,
      velocidadBala,
      velocidadMovimiento,
      tiempoAparicion,
      duracionPantalla,
      stepcoinsPremio,
      segundosEntreDisparos,
      danoBala
    } = req.body;

    if (!nombre || vida === undefined || tiempoAparicion === undefined ||
        duracionPantalla === undefined) {
      return res.status(400).json({ error: "Faltan datos requeridos" });
    }
    if (!imagenOvniFile) {
      return res.status(400).json({ error: "La imagen del OVNI es requerida" });
    }

    const [imagenOvni, imagenBala] = await Promise.all([
      saveImage(imagenOvniFile, 'ufo'),
      imagenBalaFile ? saveImage(imagenBalaFile, 'ufo') : Promise.resolve('')
    ]);

    const nuevoUfo = new Ufo({
      nombre,
      imagenOvni,
      vida,
      imagenBala,
      velocidadBala,
      velocidadMovimiento,
      tiempoAparicion,
      duracionPantalla,
      stepcoinsPremio,
      segundosEntreDisparos,
      danoBala
    });

    await nuevoUfo.save();
    legacyUfoState.set(String(nuevoUfo._id), {
      vida: Math.max(0, Number(nuevoUfo.vida) || 300),
      dead: false,
    });
    res.status(201).json(nuevoUfo);
  } catch (err) {
    console.error("❌ Error al crear OVNI:", err);
    res.status(500).json({ error: 'Error al crear el OVNI' });
  }
});

// ✏️ Editar OVNI. Si no se suben imágenes nuevas, conserva las actuales.
router.put('/:id', ...adminOnly, upload.fields([
  { name: 'imagenOvni', maxCount: 1 },
  { name: 'imagenBala', maxCount: 1 }
]), async (req, res) => {
  try {
    const ovni = await Ufo.findById(req.params.id);
    if (!ovni) {
      return res.status(404).json({ error: 'OVNI no encontrado' });
    }

    const {
      nombre,
      vida,
      velocidadBala,
      velocidadMovimiento,
      tiempoAparicion,
      duracionPantalla,
      stepcoinsPremio,
      segundosEntreDisparos,
      danoBala
    } = req.body;

    if (!nombre || vida === undefined || tiempoAparicion === undefined ||
        duracionPantalla === undefined) {
      return res.status(400).json({ error: 'Faltan datos requeridos' });
    }

    Object.assign(ovni, {
      nombre,
      vida: Number(vida),
      velocidadBala: Number(velocidadBala),
      velocidadMovimiento: Number(velocidadMovimiento),
      tiempoAparicion: Number(tiempoAparicion),
      duracionPantalla: Number(duracionPantalla),
      stepcoinsPremio: Number(stepcoinsPremio),
      segundosEntreDisparos: Number(segundosEntreDisparos),
      danoBala: Number(danoBala)
    });

    const nuevaImagenOvni = req.files?.imagenOvni?.[0];
    const nuevaImagenBala = req.files?.imagenBala?.[0];
    if (nuevaImagenOvni) {
      ovni.imagenOvni = await saveImage(nuevaImagenOvni, 'ufo');
    }
    if (nuevaImagenBala) {
      ovni.imagenBala = await saveImage(nuevaImagenBala, 'ufo');
    }

    await ovni.save();
    legacyUfoState.set(String(ovni._id), {
      vida: Math.max(0, Number(ovni.vida) || 300),
      dead: false,
    });
    return res.json(ovni);
  } catch (err) {
    console.error('❌ Error al actualizar OVNI:', err);
    return res.status(500).json({ error: 'Error al actualizar el OVNI' });
  }
});

// ✅ Obtener ovnis activos (independientemente de la posición)
router.get('/activos', async (req, res) => {
  try {
    const ahora = Date.now();

    const ufos = await Ufo.find();
    const visibles = ufos.filter(ufo => {
      const creado = new Date(ufo.createdAt).getTime();
      const apareceEn = creado + (ufo.tiempoAparicion || 0) * 1000;
      const desapareceEn = apareceEn + (ufo.duracionPantalla || 600) * 1000;

      return ahora >= apareceEn && ahora <= desapareceEn;
    });

    console.log(`🛸 OVNIS RECIBIDOS:`, visibles);

    res.json(visibles);
  } catch (err) {
    console.error("❌ Error al obtener ovnis activos:", err);
    res.status(500).json({ error: 'Error al obtener ovnis activos' });
  }
});

// ✅ Eliminar por ID
router.delete('/:id', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    await Ufo.findByIdAndDelete(id);
    legacyUfoState.delete(String(id));
    res.json({ message: 'OVNI eliminado' });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar el OVNI' });
  }
});

// ✅ Obtener todos los ovnis (admin)
router.get('/', async (req, res) => {
  try {
    const all = await Ufo.find();
    res.json(all);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener los OVNIS' });
  }
});

// Compatibilidad exclusiva del minijuego web de administración. El combate
// multijugador normal se resuelve en pvp.socket.js y nunca consume esta ruta.
router.post('/:id/hurt', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { damage } = req.body;

    const ovni = await Ufo.findById(id);
    if (!ovni) return res.status(404).json({ error: "OVNI no encontrado" });

    const dano = Number(damage || 0);
    if (isNaN(dano) || dano <= 0) {
      return res.status(400).json({ error: "Daño inválido" });
    }

    const key = String(id);
    const state = legacyUfoState.get(key) || {
      vida: Math.max(0, Number(ovni.vida) || 300),
      dead: false,
    };
    if (state.dead) {
      return res.json({
        vida: 0,
        muerto: true,
        stepcoinsPremio: 0,
        duplicate: true,
        legacyAdminOnly: true,
      });
    }
    state.vida = Math.max(0, state.vida - dano);
    state.dead = state.vida === 0;
    legacyUfoState.set(key, state);
    const haMuerto = state.dead;

    res.json({
      vida: state.vida,
      muerto: haMuerto,
      stepcoinsPremio: haMuerto ? Number(ovni.stepcoinsPremio || 0) : 0,
      legacyAdminOnly: true
    });

  } catch (err) {
    console.error("❌ Error al hacer daño al OVNI:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

// ✅ Ruta para obtener vida actual del OVNI
router.get('/:id/vida', async (req, res) => {
  try {
    const ovni = await Ufo.findById(req.params.id);
    if (!ovni) return res.status(404).json({ error: "OVNI no encontrado" });
    const state = legacyUfoState.get(String(req.params.id));
    res.json({ vida: state?.vida ?? ovni.vida, legacyAdminOnly: true });
  } catch (err) {
    res.status(500).json({ error: "Error interno" });
  }
});

module.exports = router;
