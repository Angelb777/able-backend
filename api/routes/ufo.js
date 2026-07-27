const express = require('express');
const router = express.Router();
const Ufo = require('../models/Ufo');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// 📁 Asegurar carpeta de destino
const uploadDir = path.join(__dirname, '..', '..', 'uploads', 'ufo');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// 📸 Configurar multer
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${ext}`;
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// ✅ Crear OVNI
router.post('/', upload.fields([
  { name: 'imagenOvni', maxCount: 1 },
  { name: 'imagenBala', maxCount: 1 }
]), async (req, res) => {
  try {
    const imagenOvniFilename = req.files?.imagenOvni?.[0]?.filename || '';
    const imagenBalaFilename = req.files?.imagenBala?.[0]?.filename || '';

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

    if (!nombre || !vida || !tiempoAparicion || !duracionPantalla) {
      return res.status(400).json({ error: "Faltan datos requeridos" });
    }

    const nuevoUfo = new Ufo({
      nombre,
      imagenOvni: `/uploads/ufo/${imagenOvniFilename}`,
      vida,
      imagenBala: `/uploads/ufo/${imagenBalaFilename}`,
      velocidadBala,
      velocidadMovimiento,
      tiempoAparicion,
      duracionPantalla,
      stepcoinsPremio,
      segundosEntreDisparos,
      danoBala
    });

    await nuevoUfo.save();
    res.status(201).json(nuevoUfo);
  } catch (err) {
    console.error("❌ Error al crear OVNI:", err);
    res.status(500).json({ error: 'Error al crear el OVNI' });
  }
});

// ✏️ Editar OVNI. Si no se suben imágenes nuevas, conserva las actuales.
router.put('/:id', upload.fields([
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

    const nuevaImagenOvni = req.files?.imagenOvni?.[0]?.filename;
    const nuevaImagenBala = req.files?.imagenBala?.[0]?.filename;
    if (nuevaImagenOvni) {
      ovni.imagenOvni = `/uploads/ufo/${nuevaImagenOvni}`;
    }
    if (nuevaImagenBala) {
      ovni.imagenBala = `/uploads/ufo/${nuevaImagenBala}`;
    }

    await ovni.save();
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
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await Ufo.findByIdAndDelete(id);
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

// 🔻 Ruta para hacer daño al OVNI
router.post('/:id/hurt', async (req, res) => {
  try {
    const { id } = req.params;
    const { damage } = req.body;

    const ovni = await Ufo.findById(id);
    if (!ovni) return res.status(404).json({ error: "OVNI no encontrado" });

    const dano = Number(damage || 0);
    if (isNaN(dano) || dano <= 0) {
      return res.status(400).json({ error: "Daño inválido" });
    }

    // 🛡️ Inicializar vida si estaba en null o no numérica
    if (typeof ovni.vida !== "number" || isNaN(ovni.vida) || ovni.vida <= 0) {
      // Si tienes un campo `vidaOriginal`, úsalo, si no, 300 por defecto
      ovni.vida = ovni.vidaOriginal || 300;
      console.log(`🔁 Vida reiniciada a ${ovni.vida}`);
    }

    // 💥 Restar daño
    ovni.vida -= dano;

    let haMuerto = false;
    if (ovni.vida <= 0) {
      ovni.vida = 0;
      haMuerto = true;
    }

    await ovni.save();

    res.json({
      vida: ovni.vida,
      muerto: haMuerto,
      stepcoinsPremio: haMuerto ? Number(ovni.stepcoinsPremio || 0) : 0
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
    res.json({ vida: ovni.vida });
  } catch (err) {
    res.status(500).json({ error: "Error interno" });
  }
});

module.exports = router;
