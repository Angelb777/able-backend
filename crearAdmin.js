const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const User = require('./api/models/User');

async function crearAdmin() {
  await mongoose.connect(process.env.MONGO_URI);

  const email = 'angelbaigo@gmail.com';
  const yaExiste = await User.findOne({ email });

  if (yaExiste) {
    console.log('⚠️ El administrador ya existe');
    process.exit();
  }

  const nuevoAdmin = new User({
    nombre: 'Admin Able',
    email,
    password: await bcrypt.hash('admin123', 10),
    rol: 'admin',
    stepcoins: 0,
    cartas: [],
  });

  await nuevoAdmin.save();
  console.log('✅ Admin creado correctamente');
  process.exit();
}

crearAdmin();
