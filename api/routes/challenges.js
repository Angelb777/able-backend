const express = require('express');
const router = express.Router();
const Challenge = require('../models/Challenge');
const User = require('../models/User');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

// ✅ Crear nuevo reto (admin)
router.post('/', async (req, res) => {
  try {
    const nuevoReto = new Challenge(req.body);
    await nuevoReto.save();
    res.status(201).json(nuevoReto);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ✅ Obtener todos los retos activos (cliente)
router.get('/activos', async (req, res) => {
  const retos = await Challenge.find({ activo: true }).lean();
  retos.forEach(r => {
    r.participantes = r.participantes.map(p => ({
      userId: p.userId.toString()
    }));
  });
  res.json(retos);
});

// ✅ Inscribirse a un reto (cliente)
router.post('/:id/inscribirse', async (req, res) => {
  const challenge = await Challenge.findById(req.params.id);
  if (!challenge) return res.status(404).json({ error: 'Reto no encontrado' });

  const yaInscrito = challenge.participantes.find(p => p.userId.toString() === req.body.userId);
  if (yaInscrito) return res.status(400).json({ error: 'Ya estás inscrito' });

  const user = await User.findById(req.body.userId);
  const nuevoParticipante = {
    userId: user._id,
    stepcoinsInicio: user.stepcoins || 0
  };

  challenge.participantes.push(nuevoParticipante);
  await challenge.save();

  res.json({ message: 'Inscripción exitosa' });
});

// ✅ Finalizar reto y guardar stepcoinsFinal (llamado por cronjob o manual)
router.post('/:id/finalizar', async (req, res) => {
  const challenge = await Challenge.findById(req.params.id).populate('participantes.userId');
  if (!challenge) return res.status(404).json({ error: 'Reto no encontrado' });

  challenge.participantes = challenge.participantes.map(p => {
    return {
      ...p.toObject(),
      stepcoinsFinal: p.userId.stepcoins || 0
    };
  });

  challenge.activo = false;
  await challenge.save();

  res.json({ message: 'Reto finalizado y resultados guardados', challenge });
});

// ✅ Marcar ganador manualmente
router.post('/:id/marcar-ganador', async (req, res) => {
  const { userId } = req.body;
  const challenge = await Challenge.findById(req.params.id);
  if (!challenge) return res.status(404).json({ error: 'Reto no encontrado' });

  challenge.participantes = challenge.participantes.map(p => {
    p.esGanador = p.userId.toString() === userId;
    return p;
  });

  await challenge.save();
  res.json({ message: 'Ganador marcado' });
});

// ✅ Obtener todos los retos (admin)
router.get('/', async (req, res) => {
  try {
    const retos = await Challenge.find().sort({ creadoEn: -1 });
    res.json(retos);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener retos' });
  }
});

// ✅ Crear carpeta si no existe
const dir = path.join(__dirname, '..', '..', 'uploads', 'challenges');
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

// ✅ Configuración de multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, dir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext); // nombre único con extensión segura
  },
});

const upload = multer({ storage });

// ✅ Ruta: POST /api/retos/upload
router.post('/upload', upload.single('file'), (req, res) => {
  console.log("BODY:", req.body);
  console.log("FILE:", req.file);

  if (!req.file) {
    console.log("❌ No se subió ningún archivo");
    return res.status(400).json({ error: 'No se subió ningún archivo' });
  }

  const publicUrl = `/uploads/challenges/${req.file.filename}`;
  console.log("✅ Imagen subida correctamente:", publicUrl);
  res.json({ url: publicUrl });
});

// ✅ Eliminar reto
router.delete('/:id', async (req, res) => {
  try {
    await Challenge.findByIdAndDelete(req.params.id);
    res.json({ message: 'Reto eliminado' });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar reto' });
  }
});

module.exports = router;
