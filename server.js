const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();
const path = require('path');

const app = express();

// Middlewares globales
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 👉 Servir archivos estáticos desde 'public' (HTML, CSS, JS, imágenes)
app.use(express.static(path.join(__dirname, 'public')));

// 👉 Servir archivos subidos desde '/uploads'
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ✅ Al acceder a '/', servir index.html directamente
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 🔁 Opción: redirigir otras rutas inválidas al index.html (para apps tipo SPA)
// app.get('*', (req, res) => {
//   res.sendFile(path.join(__dirname, 'public', 'index.html'));
// });

// Rutas API
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
app.use('/api/ufo', require('./api/routes/ufo')); // 🛸 ← AÑADIDO
app.use('/api/candados', require('./api/routes/candados')); // 🔐 ← NUEVO
app.use('/api/promociones-negocio', require('./api/routes/promocionesNegocio')); // 🏪 ← NUEVA RUTA
app.use('/api/promo-contratada', require('./api/routes/promoContratada'));
app.use('/api/projectiles', require('./api/routes/projectiles'));
app.use('/api/retos', require('./api/routes/challenges')); // 🏁 ← NUEVA RUTA DE RETOS

// Conexión MongoDB + inicio del servidor
const PORT = process.env.PORT || 3000;
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('🟢 Conectado a MongoDB');
    app.listen(PORT, () => console.log(`🚀 Servidor en http://localhost:${PORT}`));
  })
  .catch(err => console.error('❌ Error al conectar a MongoDB', err));
