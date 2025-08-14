// server.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const app = express();

// Render/Proxies
app.set('trust proxy', 1);

// Middlewares globales
app.use(cors()); // en prod puedes restringir con { origin: ['https://able73.com'] }
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Asegurar carpetas de subidas
const uploadsDir = path.join(__dirname, 'uploads');
const cardsDir = path.join(uploadsDir, 'cards');
try {
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
    console.log("📁 Carpeta 'uploads' creada");
  }
  if (!fs.existsSync(cardsDir)) {
    fs.mkdirSync(cardsDir, { recursive: true });
    console.log("📁 Carpeta 'uploads/cards' creada");
  }
} catch (e) {
  console.warn('⚠️  No se pudo crear alguna carpeta de uploads:', e.message);
}

// 👉 Servir archivos estáticos desde 'public' (HTML, CSS, JS, imágenes)
app.use(express.static(path.join(__dirname, 'public')));

// 👉 Servir archivos subidos desde '/uploads'
app.use('/uploads', express.static(uploadsDir));

// 🔎 Ruta de salud
app.get('/health', (_req, res) => res.json({ ok: true }));

// ✅ Index
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Rutas API (no sensibles)
app.use('/api/auth', require('./api/routes/auth'));
app.use('/api/discounts', require('./api/routes/discounts'));
app.use('/api/admin', require('./api/routes/admin'));
app.use('/api/users', require('./api/routes/users'));
app.use('/api/profile', require('./api/routes/profile'));
app.use('/api/payments', require('./api/routes/payments'));
app.use('/api/metrics', require('./api/routes/metrics'));
app.use('/api/rewards', require('./api/routes/rewards'));
app.use('/api/stepcoins', require('./api/routes/stepcoins'));
app.use('/api/skins', require('./api/routes/skins'));
app.use('/api/cards', require('./api/routes/cards'));
app.use('/api/life', require('./api/routes/life'));
app.use('/api/ubicaciones', require('./api/routes/ubicaciones'));
app.use('/api/ufo', require('./api/routes/ufo'));
app.use('/api/promociones-negocio', require('./api/routes/promocionesNegocio'));
app.use('/api/promo-contratada', require('./api/routes/promoContratada'));
app.use('/api/projectiles', require('./api/routes/projectiles'));
app.use('/api/retos', require('./api/routes/challenges'));

// 🔐 Candados: proteger TODO el grupo con verifyToken,
// dejando públicas solo las rutas bajo /publico/*
const { verifyToken } = require('./api/middlewares/authMiddleware');
app.use(
  '/api/candados',
  (req, res, next) => {
    if (req.path.startsWith('/publico/')) return next(); // públicas
    return verifyToken(req, res, next); // resto requieren token
  },
  require('./api/routes/candados')
);

// === Conexión MongoDB + inicio del servidor ===
const PORT = process.env.PORT || 3000;
const uriRaw = process.env.MONGO_URI || '';
const uri = uriRaw.trim();

// Logs de diagnóstico mínimos
console.log('🔧 NODE_ENV:', process.env.NODE_ENV);
console.log('🔧 PORT:', PORT);
console.log('🔧 MONGO_URI presente:', !!uri);
if (uri) {
  console.log('🔧 MONGO_URI inicio:', uri.slice(0, 40) + '...');
}
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET no está definida. Algunas rutas podrían fallar.');
}

if (!uri || (!uri.startsWith('mongodb://') && !uri.startsWith('mongodb+srv://'))) {
  console.error('❌ MONGO_URI inválida. Debe empezar por mongodb:// o mongodb+srv://');
  process.exit(1);
}

// Conectar usando la URI
mongoose.connect(uri)
  .then(() => {
    console.log('🟢 Conectado a MongoDB');
    app.listen(PORT, () => {
      console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ Error al conectar a MongoDB', err);
    process.exit(1);
  });

// Manejo básico de errores no controlados
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️  Uncaught Exception:', err);
});
