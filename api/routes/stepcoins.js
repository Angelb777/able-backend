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
  try {
    const { userId, resultado } = req.body;
    if (!userId || !resultado) {
      return res.status(400).json({ error: "Faltan datos" });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    const SPIN_COST = 500;
    const MIN_BALANCE_BIG_LOSS = 30000;

    // Normaliza etiquetas que pueden venir del cliente
    const normalize = (s) => {
      const r = String(s || "").trim().toLowerCase();
      if (r === "tira de nuevo" || r === "500 stepcoins para volver a tirar") return "Tirar otra vez";
      if (r === "carta aleatoria" || r === "armas") return "Carta aleatoria";
      if (r === "gana 20000 stepcoins" || r === "20000 stepcoins") return "Gana 20000 Stepcoins";
      if (r === "pierde 20000 stepcoins") return "Pierde 20000 Stepcoins";
      if (r === "juego de cultura") return "Juego de Cultura";
      if (r === "juego nave espacial") return "Juego Nave Espacial";
      if (r === "nada") return "Nada";
      // Cualquier cosa desconocida la tratamos como "Nada"
      return "Nada";
    };

    const saldoInicial = typeof user.stepcoins === "number" ? user.stepcoins : 0;
    if (saldoInicial < SPIN_COST) {
      return res.status(400).json({ error: "Saldo insuficiente" });
    }

    let applied = normalize(resultado);

    // Regla anti-pérdida: si no llega a 30k, convertir a "Nada"
    if (applied === "Pierde 20000 Stepcoins" && saldoInicial < MIN_BALANCE_BIG_LOSS) {
      applied = "Nada";
    }

    // Caso especial: si es Carta y NO hay cartas disponibles, no cobramos y devolvemos yaTienesTodas
    if (applied === "Carta aleatoria") {
      const todas = await Card.find().select("_id titulo imagenPortada");
      const tiene = new Set((user.cartas || []).map((id) => String(id)));
      const candidatas = todas.filter((c) => !tiene.has(String(c._id)));

      if (candidatas.length === 0) {
        return res.json({
          resultado: "Carta aleatoria",
          yaTienesTodas: true,
          nuevosStepcoins: saldoInicial, // no cobramos
        });
      }
    }

    // 1) Cobrar tirada
    user.stepcoins = saldoInicial - SPIN_COST;

    let nuevaCarta = null;

    // 2) Aplicar efecto del resultado
    switch (applied) {
      case "Tirar otra vez":
        user.stepcoins += SPIN_COST; // reintegro (neto 0)
        break;

      case "Gana 20000 Stepcoins":
        user.stepcoins += 20000;
        break;

      case "Pierde 20000 Stepcoins":
        user.stepcoins = Math.max(0, user.stepcoins - 20000);
        break;

      case "Carta aleatoria": {
        const todas = await Card.find().select("_id titulo imagenPortada");
        const tiene = new Set((user.cartas || []).map((id) => String(id)));
        const candidatas = todas.filter((c) => !tiene.has(String(c._id)));

        if (candidatas.length === 0) {
          // Si entre medias se quedó sin cartas, revertimos el cobro para ser amables
          user.stepcoins = saldoInicial;
          await user.save();
          await StepcoinTransaction.create({
            userId,
            cantidad: 0,
            tipo: "ruleta",
            descripcion: `Resultado ruleta: Carta aleatoria (ya tenía todas)`,
          });
          return res.json({
            resultado: "Carta aleatoria",
            yaTienesTodas: true,
            nuevosStepcoins: user.stepcoins,
          });
        }

        const randomCarta = candidatas[Math.floor(Math.random() * candidatas.length)];
        user.cartas = user.cartas || [];
        user.cartas.push(randomCarta._id);

        nuevaCarta = {
          _id: String(randomCarta._id),
          titulo: randomCarta.titulo,
          imagenPortada: randomCarta.imagenPortada || null,
        };
        break;
      }

      // "Nada", "Juego de Cultura", "Juego Nave Espacial" → no afectan saldo
      case "Nada":
      case "Juego de Cultura":
      case "Juego Nave Espacial":
      default:
        break;
    }

    await user.save();

    const delta = user.stepcoins - saldoInicial;
    await StepcoinTransaction.create({
      userId,
      cantidad: delta, // cambio neto real de la tirada
      tipo: "ruleta",
      descripcion: `Resultado ruleta aplicado: ${applied}`,
    });

    return res.json({
      resultado: applied,          // lo que se aplicó realmente
      nuevosStepcoins: user.stepcoins,
      nuevaCarta,                  // opcional
    });
  } catch (err) {
    console.error("❌ Error en ruleta:", err);
    return res.status(500).json({ error: "Error interno al procesar ruleta" });
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
