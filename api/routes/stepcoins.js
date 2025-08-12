const express = require("express");
const router = express.Router();
const User = require("../models/User");
const StepcoinTransaction = require("../models/StepcoinTransaction");
const Card = require("../models/Card");

// Añadir o quitar stepcoins (positivo o negativo)
router.post("/adjust", async (req, res) => {
  const { userId, cantidad, tipo, descripcion } = req.body;

  if (!userId || !cantidad || !tipo) {
    return res.status(400).json({ error: "Faltan datos obligatorios" });
  }

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    // Evitar saldo negativo
    if (user.stepcoins + cantidad < 0) {
      return res.status(400).json({ error: "Saldo insuficiente" });
    }

    // Actualizar saldo
    user.stepcoins += cantidad;
    await user.save();

    // Registrar transacción
    const trans = new StepcoinTransaction({ userId, cantidad, tipo, descripcion });
    await trans.save();

    res.json({ message: "Stepcoins actualizados correctamente", user });
  } catch (err) {
    console.error("❌ Error ajustando stepcoins:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// Ver historial del usuario
router.get("/historial/:userId", async (req, res) => {
  try {
    const historial = await StepcoinTransaction.find({ userId: req.params.userId })
      .sort({ fecha: -1 });

    res.json(historial);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener historial" });
  }
});

const Skin = require("../models/Skin"); // Asegúrate de tenerlo importado

// Comprar skin con stepcoins
router.post("/comprar-skin", async (req, res) => {
  const { userId, skinId } = req.body;

  if (!userId || !skinId) {
    return res.status(400).json({ error: "Faltan datos obligatorios" });
  }

  try {
    const user = await User.findById(userId);
    const skin = await Skin.findById(skinId);
    if (!user || !skin) {
      return res.status(404).json({ error: "Usuario o Skin no encontrado" });
    }

    if (user.stepcoins < skin.precio) {
      return res.status(400).json({ error: "Saldo insuficiente para comprar esta skin" });
    }

    // Verificar si ya la compró
    if (user.skinsCompradas.includes(skin._id)) {
      return res.status(400).json({ error: "Ya has comprado esta skin" });
    }

    // Descontar
    user.stepcoins -= skin.precio;
    user.skinsCompradas.push(skin._id);
    await user.save();

    // Registrar transacción
    const trans = new StepcoinTransaction({
      userId,
      cantidad: -skin.precio,
      tipo: "compra", // Debe coincidir con el enum
      descripcion: `Compra de skin: ${skin.titulo}`
    });
    await trans.save();

    // ✅ Enviar el usuario actualizado (solo campos clave)
    res.json({
      message: "Skin comprada correctamente",
      userActualizado: {
        stepcoins: user.stepcoins,
        skinsCompradas: user.skinsCompradas,
        id: user._id,
        nombre: user.nombre,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    console.error("❌ Error comprando skin:", err.message, err.stack);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

router.post("/ruleta", async (req, res) => {
  const { userId, resultado } = req.body;

  if (!userId || !resultado) {
    return res.status(400).json({ error: "Faltan datos" });
  }

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    if (typeof user.stepcoins !== "number" || user.stepcoins < 500) {
      return res.status(400).json({ error: "Saldo insuficiente" });
    }

    user.stepcoins -= 500;
    let nuevaCarta = null;

    if (resultado === "20000 Stepcoins") {
      user.stepcoins += 20000;
    } else if (resultado === "500 Stepcoins para volver a tirar") {
      user.stepcoins += 500;
    } else if (resultado === "Carta aleatoria") {
  const todasCartas = await Card.find();
  const cartasQueNoTiene = todasCartas.filter(carta => !user.cartas.includes(carta._id));

  if (cartasQueNoTiene.length === 0) {
    return res.status(400).json({ error: "Ya tienes todas las cartas disponibles" });
  }

  const randomCarta = cartasQueNoTiene[Math.floor(Math.random() * cartasQueNoTiene.length)];

  user.cartas.push(randomCarta._id);
  nuevaCarta = {
    titulo: randomCarta.titulo,
    imagen: randomCarta.imagenPortada
  };
}

    await user.save();

    const cantidad = -500 +
      (resultado === "20000 Stepcoins" ? 20000 :
       resultado === "500 Stepcoins para volver a tirar" ? 500 : 0);

    await StepcoinTransaction.create({
      userId,
      cantidad,
      tipo: "ruleta",
      descripcion: `Resultado ruleta: ${resultado}`
    });

    res.json({ nuevosStepcoins: user.stepcoins, nuevaCarta });
  } catch (err) {
    console.error("❌ Error en ruleta:", err.message, err.stack);
    res.status(500).json({ error: "Error interno al procesar ruleta" });
  }
});

// Obtener usuarios ordenados por Stepcoins (ranking)
router.get("/ranking", async (req, res) => {
  try {
    const topUsuarios = await User.find({ role: "cliente" }) // solo clientes, puedes quitarlo si quieres incluir todos
      .sort({ stepcoins: -1 })
      .select("nombre stepcoins") // solo lo necesario
      .limit(100); // puedes ajustar el límite

    res.json(topUsuarios);
  } catch (err) {
    console.error("❌ Error obteniendo ranking:", err);
    res.status(500).json({ error: "Error interno" });
  }
});


module.exports = router;
