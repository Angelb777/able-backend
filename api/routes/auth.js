const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
require('dotenv').config();

// Registro (solo permite cliente o comercio desde frontend)
router.post('/register', async (req, res) => {
  const { nombre, email, password, role } = req.body;

  if (!nombre || !email || !password || !role) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios' });
  }

  if (!['cliente', 'comercio'].includes(role)) {
    return res.status(403).json({ error: 'Rol no permitido para registro público' });
  }

  const existingUser = await User.findOne({ email });
  if (existingUser) {
    return res.status(409).json({ error: 'El usuario ya existe' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const newUser = new User({
    nombre,
    email,
    password: hashedPassword,
    role,
  });

  await newUser.save();

  const token = jwt.sign({ id: newUser._id, role: newUser.role }, process.env.JWT_SECRET, {
  expiresIn: '7d',
});

res.status(201).json({
  token,
  user: {
    _id: newUser._id,
    nombre: newUser.nombre,
    email: newUser.email,
    role: newUser.role,
  },
});
});

// Login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) return res.status(401).json({ error: 'Contraseña incorrecta' });

  console.log("📦 Usuario completo desde DB:", user);

  const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: '7d',
  });

  res.json({
    token,
    user: {
      id: user._id,
      nombre: user.nombre,
      email: user.email,
      role: user.role,
    },
  });
});

// Nueva ruta: login con Google
router.post('/google-login', async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'Falta idToken' });

  try {
    // Verificamos token con Firebase Admin
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(require('../firebase-key.json')), // tu clave de servicio
      });
    }

    const decoded = await admin.auth().verifyIdToken(idToken);
    const email = decoded.email;
    const nombre = decoded.name || '';
    const uid = decoded.uid;

    let user = await User.findOne({ email });
    if (!user) {
      // Si no existe, lo creamos como cliente por defecto
      user = new User({
        nombre,
        email,
        password: null, // no tiene password
        role: 'cliente',
        googleId: uid
      });
      await user.save();
    }

    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, {
      expiresIn: '7d',
    });

    res.json({
      token,
      user: {
        id: user._id,
        nombre: user.nombre,
        email: user.email,
        role: user.role,
      },
    });

  } catch (err) {
    console.error('Error verificando token de Google:', err);
    res.status(401).json({ error: 'Token inválido' });
  }
});

module.exports = router;
