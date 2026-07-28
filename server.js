// server.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');                // ✅ NUEVO
const { Server } = require('socket.io');     // ✅ NUEVO


const usersRouter = require('./api/routes/users');

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const app = express();

// Render/Proxies
app.set('trust proxy', 1);

/* =========================
   CORS con whitelist (.env: ALLOWED_ORIGINS=...)
========================= */
const rawOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const corsOptions = rawOrigins.length
  ? {
      origin: (origin, cb) => {
        // Permitir apps móviles sin cabecera Origin (fetch nativo)
        if (!origin) return cb(null, true);
        if (rawOrigins.includes(origin)) return cb(null, true);
        return cb(new Error(`Origen no permitido por CORS: ${origin}`));
      },
      credentials: true,
    }
  : { origin: true, credentials: true };

app.use(cors(corsOptions));

/* =========================
   Middlewares globales
========================= */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =========================
   Uploads: base única (local vs prod)
   - Local:  <repo>/uploads
   - Producción (Render): /data/uploads   (define UPLOAD_BASE_DIR=/data/uploads y usa Persistent Disk)
========================= */
const UPLOAD_BASE_DIR =
  process.env.UPLOAD_BASE_DIR || path.join(__dirname, 'uploads');

// Asegura carpetas que usas en el proyecto
const ensureDirs = [
  UPLOAD_BASE_DIR,
  path.join(UPLOAD_BASE_DIR, 'skins'),
  path.join(UPLOAD_BASE_DIR, 'cards'),
  path.join(UPLOAD_BASE_DIR, 'ufo'),
  path.join(UPLOAD_BASE_DIR, 'rewards'),
];
for (const d of ensureDirs) {
  try {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
      console.log('📁 Carpeta creada:', d);
    }
  } catch (e) {
    console.warn('⚠️  No se pudo crear', d, e.message);
  }
}

// 👉 Servir archivos estáticos desde 'public' (HTML, CSS, JS, imágenes)
app.use(express.static(path.join(__dirname, 'public')));

// 👉 Servir archivos subidos (mismo path en local y prod)
//    - En prod, si UPLOAD_BASE_DIR=/data/uploads, esto sirve /uploads/* desde /data/uploads/*
app.use('/uploads', express.static(UPLOAD_BASE_DIR, { fallthrough: false }));
app.use('/api/media', require('./api/routes/media'));

// 🔎 Ruta de salud
app.get('/health', (_req, res) => res.json({ ok: true }));

// ✅ Index
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// [NUEVO] Página pública de catálogo de candados
app.get('/candados', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'candados.html'));
});

// [NUEVO] Página admin de pedidos (opcional; también servirá /public/admin/pedidos.html directo)
app.get('/admin/pedidos', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'pedidos.html'));
});

/* =========================
   HTTP Server + Socket.IO
========================= */
const server = http.createServer(app);

// CORS para Socket.IO: usa tu whitelist si existe; si no, abierto (útil para móvil)
const io = new Server(server, {
  cors: rawOrigins.length
    ? {
        origin: (origin, cb) => {
          // En apps móviles origin suele venir null/undefined → permitir
          if (!origin) return cb(null, true);
          if (rawOrigins.includes(origin)) return cb(null, true);
          return cb(new Error(`Origen Socket.IO no permitido: ${origin}`));
        },
        credentials: true,
      }
    : { origin: '*', credentials: true },
  transports: ['websocket', 'polling'],
});

// 👉 Conectar tu namespace de PVP
require('./sockets/pvp.socket')(io);


/* =========================
   Rutas API
========================= */
app.use('/api/auth', require('./api/routes/auth'));
app.use('/api/discounts', require('./api/routes/discounts'));
app.use('/api/admin', require('./api/routes/admin'));
app.use('/api/users', require('./api/routes/users'));
app.use('/api/user', require('./api/routes/users'));
app.use('/api/profile', require('./api/routes/profile'));
app.use('/api/payments', require('./api/routes/payments'));
app.use('/api/metrics', require('./api/routes/metrics'));
app.use('/api/rewards', require('./api/routes/rewards'));
app.use('/api/stepcoins', require('./api/routes/stepcoins'));
app.use('/api/skins', require('./api/routes/skins'));
app.use('/api/cards', require('./api/routes/cards'));
app.use('/api/life', require('./api/routes/life'));
app.use('/api/ubicaciones', require('./api/routes/ubicaciones'));
app.use('/api/mobility', require('./api/routes/mobility'));
app.use('/api/ufo', require('./api/routes/ufo'));
app.use('/api/promociones-negocio', require('./api/routes/promocionesNegocio'));
app.use('/api/promo-contratada', require('./api/routes/promoContratada'));
app.use('/api/projectiles', require('./api/routes/projectiles'));
app.use('/api/retos', require('./api/routes/challenges'));

// 🔐 Candados: públicas solo /publico/*
const { verifyToken } = require('./api/middlewares/authMiddleware');
app.use(
  '/api/candados',
  (req, res, next) => {
    if (req.path.startsWith('/publico/')) return next();
    return verifyToken(req, res, next);
  },
  require('./api/routes/candados')
);

// [NUEVO] Catálogo de productos (candados)
app.use('/api/products', require('./api/routes/products'));

// [NUEVO] Pedidos (incluye /api/orders/paid para admin)
app.use('/api/orders', require('./api/routes/orders'));

// [NUEVO] Pagos PayPal (config, create-order, capture-order)
app.use('/api/paypal', require('./api/routes/paypal'));

// [NUEVO] Admin Orders (endpoints seguros /api/admin/orders, /:id, /export.csv)
const adminOrdersRoutes = require('./api/routes/adminOrders');
app.use('/api/admin', adminOrdersRoutes);

/* =========================
   MongoDB + Start
========================= */
const PORT = process.env.PORT || 3000;
const uriRaw = process.env.MONGO_URI || '';
const uri = uriRaw.trim();

// Logs de diagnóstico mínimos
console.log('🔧 NODE_ENV:', process.env.NODE_ENV);
console.log('🔧 PORT:', PORT);
console.log('🔧 MONGO_URI presente:', !!uri);
if (uri) console.log('🔧 MONGO_URI inicio:', uri.slice(0, 40) + '...');
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
    const conn = mongoose.connection;
    console.log('🟢 Conectado a MongoDB');
    console.log(`   Host: ${conn.host}`);
    console.log(`   DB:   ${conn.name}`);

    // ⬇️⬇️⬇️  USAR server.listen (no app.listen)  ⬇️⬇️⬇️
    server.listen(PORT, () => {
      console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
      if (rawOrigins.length) {
        console.log(`🔐 CORS whitelist: ${rawOrigins.join(' , ')}`);
      } else {
        console.log('⚠️  CORS abierto (ALLOWED_ORIGINS vacío). Define ALLOWED_ORIGINS en .env para restringir.');
      }
      console.log('📂 UPLOAD_BASE_DIR:', UPLOAD_BASE_DIR);
      console.log('📡 Socket.IO ON (namespace /pvp)');
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
