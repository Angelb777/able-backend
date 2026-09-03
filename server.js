// server.js
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const http = require('http');                // ✅ NUEVO
const { Server } = require('socket.io');     // ✅ NUEVO


const { createLimiter, integerEnv } = require('./api/middlewares/securityLimits');

const app = express();
app.disable('x-powered-by');

// Render/Proxies
app.set('trust proxy', integerEnv('TRUST_PROXY_HOPS', 1, { min: 0, max: 10 }));

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
  : process.env.NODE_ENV === 'production'
    ? { origin: false, credentials: true }
    : { origin: true, credentials: true };

app.use(cors(corsOptions));
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'", "'unsafe-inline'",
        'https://www.gstatic.com', 'https://apis.google.com',
        'https://maps.googleapis.com', 'https://maps.gstatic.com',
      ],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: [
        "'self'", 'https://*.googleapis.com', 'https://*.firebaseio.com',
        'https://www.gstatic.com',
        'https://securetoken.googleapis.com', 'https://identitytoolkit.googleapis.com',
        'wss:',
      ],
      frameSrc: ["'self'", 'https://*.firebaseapp.com', 'https://accounts.google.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
}));

/* =========================
   Middlewares globales
========================= */
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '100kb', strict: true }));
app.use(express.urlencoded({
  extended: true,
  limit: process.env.FORM_BODY_LIMIT || '100kb',
  parameterLimit: 100,
}));
app.use('/api', createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: integerEnv('API_REQUESTS_PER_15_MINUTES', 1500),
  code: 'API_RATE_LIMITED',
}));

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
  path.join(UPLOAD_BASE_DIR, 'police'),
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
server.requestTimeout = integerEnv('HTTP_REQUEST_TIMEOUT_MS', 30 * 1000, {
  min: 5000,
  max: 120000,
});
server.headersTimeout = integerEnv('HTTP_HEADERS_TIMEOUT_MS', 15 * 1000, {
  min: 5000,
  max: 60000,
});
server.keepAliveTimeout = integerEnv('HTTP_KEEP_ALIVE_TIMEOUT_MS', 5000, {
  min: 1000,
  max: 30000,
});

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
    : process.env.NODE_ENV === 'production'
      ? { origin: false, credentials: true }
      : { origin: '*', credentials: true },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: integerEnv('SOCKET_MAX_PAYLOAD_BYTES', 64 * 1024, {
    min: 4096,
    max: 1024 * 1024,
  }),
  perMessageDeflate: false,
});
io.engine.use(createLimiter({
  windowMs: 60 * 1000,
  limit: integerEnv('SOCKET_HANDSHAKE_REQUESTS_PER_MINUTE', 120),
  code: 'SOCKET_RATE_LIMITED',
}));

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
app.use('/api/activity', require('./api/routes/activity'));
app.use('/api/onboarding', require('./api/routes/onboarding'));
app.use('/api/metrics', require('./api/routes/metrics'));
app.use('/api/rewards', require('./api/routes/rewards'));
app.use('/api/stepcoins', require('./api/routes/stepcoins'));
app.use('/api/skins', require('./api/routes/skins'));
app.use('/api/cards', require('./api/routes/cards'));
app.use('/api/life', require('./api/routes/life'));
app.use('/api/clans', require('./api/routes/clans'));
app.use('/api/social', require('./api/routes/social'));
app.use('/api/ubicaciones', require('./api/routes/ubicaciones'));
app.use('/api/mobility', require('./api/routes/mobility'));
app.use('/api/google-maps', require('./api/routes/googleMaps'));
app.use('/api/weather', require('./api/routes/weather'));
app.use('/api/ufo', require('./api/routes/ufo'));
app.use('/api/police', require('./api/routes/police'));
app.use('/api/promociones-negocio', require('./api/routes/promocionesNegocio'));
app.use('/api/promo-contratada', require('./api/routes/promoContratada'));
app.use('/api/commercial', require('./api/routes/commercial'));
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

app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE' });
  }
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ error: 'INVALID_JSON' });
  }
  console.error('Error HTTP no controlado:', error?.message || error);
  return res.status(error?.status || 500).json({
    error: error?.status && error.status < 500
      ? error.message
      : 'Error interno del servidor',
  });
});

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
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET no está definida. Algunas rutas podrían fallar.');
}
if (process.env.NODE_ENV === 'production') {
  if (String(process.env.JWT_SECRET || '').length < 32) {
    console.error('JWT_SECRET debe tener al menos 32 caracteres en produccion.');
    process.exit(1);
  }
  if (!rawOrigins.length) {
    console.error('ALLOWED_ORIGINS es obligatorio en produccion.');
    process.exit(1);
  }
  if (process.env.PAYPAL_ENV !== 'live') {
    console.warn('PayPal no esta en modo live; no se aceptaran pagos reales.');
  }
}
if (!uri || (!uri.startsWith('mongodb://') && !uri.startsWith('mongodb+srv://'))) {
  console.error('❌ MONGO_URI inválida. Debe empezar por mongodb:// o mongodb+srv://');
  process.exit(1);
}

// Conectar usando la URI
mongoose.connect(uri)
  .then(async () => {
    const conn = mongoose.connection;
    console.log('🟢 Conectado a MongoDB');
    console.log(`   Host: ${conn.host}`);
    console.log(`   DB:   ${conn.name}`);
    await require('./api/services/mapSubscriptions').ensureEstablishmentLocationIndexes();
    require('./api/services/bountyService').startExpiryWorker();

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
