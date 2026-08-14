const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const User = require('./api/models/User');

async function crearAdmin() {
  await mongoose.connect(process.env.MONGO_URI);

  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!email || password.length < 12) {
    throw new Error('Define ADMIN_EMAIL y ADMIN_PASSWORD (minimo 12 caracteres)');
  }
  const yaExiste = await User.findOne({ email });

  if (yaExiste) {
    console.log('⚠️ El administrador ya existe');
    process.exit();
  }

  const nuevoAdmin = new User({
    nombre: 'Admin Able',
    email,
    password: await bcrypt.hash(password, 12),
    role: 'admin',
    stepcoins: 0,
    cartas: [],
  });

  await nuevoAdmin.save();
  console.log('✅ Admin creado correctamente');
  process.exit();
}

crearAdmin();
