const express = require("express");
const router = express.Router();
const UserLife = require("../models/UserLife");

// 🆕 importa para poder descontar y registrar la transacción
const User = require("../models/User");
const StepcoinTransaction = require("../models/StepcoinTransaction");

// 🆕 helper reutilizable
async function penalizarSiMuere(userId, vidaAnterior, vidaNueva) {
  if (vidaAnterior > 0 && vidaNueva === 0) {
    const user = await User.findById(userId);
    if (!user) return;

    const cantidadADescontar = Math.min(user.stepcoins, 100) * -1; // nunca por debajo de 0
    if (cantidadADescontar === 0) return;

    user.stepcoins += cantidadADescontar;
    await user.save();

    await StepcoinTransaction.create({
      userId,
      cantidad: cantidadADescontar,
      tipo: "muerte",              // ✅ recuerda añadir "muerte" al enum del modelo
      descripcion: "Penalización por morir"
    });
  }
}

// ✅ Obtener vida actual (GET /api/life/:userId)
router.get("/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    let vida = await UserLife.findOne({ userId });
    if (!vida) {
      vida = await UserLife.create({ userId }); // por defecto: vida = 1000
    }
    res.json({ vida: vida.vida });
  } catch (err) {
    console.error("❌ Error al obtener la vida:", err);
    res.status(500).json({ error: "Error al obtener la vida del usuario" });
  }
});

// ✅ Actualizar vida directamente (PUT /api/life/:userId)
router.put("/:userId", async (req, res) => {
  const { userId } = req.params;
  const { vida } = req.body;

  try {
    let registro = await UserLife.findOne({ userId });
    if (!registro) {
      registro = await UserLife.create({ userId });
    }

    const vidaAnterior = registro.vida;                // 🆕
    registro.vida = Math.max(0, Math.min(1000, vida)); // entre 0 y 1000
    await registro.save();

    await penalizarSiMuere(userId, vidaAnterior, registro.vida); // 🆕

    res.json({ vida: registro.vida });
  } catch (err) {
    console.error("❌ Error al actualizar la vida:", err);
    res.status(500).json({ error: "Error al actualizar la vida" });
  }
});

// ✅ Ruta extra opcional: reiniciar vida a 1000
router.post("/:userId/reset", async (req, res) => {
  const { userId } = req.params;

  try {
    let registro = await UserLife.findOne({ userId });
    if (!registro) {
      registro = await UserLife.create({ userId });
    }

    registro.vida = 1000;
    await registro.save();

    res.json({ vida: registro.vida, mensaje: "✅ Vida reseteada a 1000" });
  } catch (err) {
    console.error("❌ Error al resetear la vida:", err);
    res.status(500).json({ error: "Error al resetear la vida" });
  }
});

// 🔥 Restar daño desde OVNI (POST /api/life/:userId/hurt)
router.post("/:userId/hurt", async (req, res) => {
  const { userId } = req.params;
  const { damage } = req.body;

  if (!damage || typeof damage !== "number") {
    return res.status(400).json({ error: "Daño inválido" });
  }

  try {
    let vidaUsuario = await UserLife.findOne({ userId });
    if (!vidaUsuario) {
      vidaUsuario = await UserLife.create({ userId }); // vida por defecto = 1000
    }

    const vidaAnterior = vidaUsuario.vida;
    vidaUsuario.vida = Math.max(0, vidaUsuario.vida - damage);

    // ✅ Si pasa de vivo a muerto y aún no ha sido penalizado
    if (vidaAnterior > 0 && vidaUsuario.vida === 0 && !vidaUsuario.yaPenalizado) {
      const user = await User.findById(userId);
      if (user) {
        const cantidadADescontar = Math.min(user.stepcoins, 100) * -1;
        user.stepcoins += cantidadADescontar;
        await user.save();

        await StepcoinTransaction.create({
          userId,
          cantidad: cantidadADescontar,
          tipo: "muerte",
          descripcion: "Penalización por morir"
        });
      }

      vidaUsuario.yaPenalizado = true; // ✅ Para evitar penalizaciones múltiples
    }

    await vidaUsuario.save();

// 🆕 devolver también los stepcoins actuales del usuario
const user = await User.findById(userId);
res.json({
  vida: vidaUsuario.vida,
  stepcoins: user.stepcoins
});
  } catch (err) {
    console.error("❌ Error al aplicar daño:", err);
    res.status(500).json({ error: "Error al aplicar daño" });
  }
});

// (opcional) Resucitar cobrando 1000 stepcoins
router.post("/:userId/resurrect", async (req, res) => {
  const { userId } = req.params;

  try {
    let vida = await UserLife.findOneAndUpdate(
      { userId },
      { vida: 1000, yaPenalizado: false }, // 🆕 resetear flag
      { new: true, upsert: true }
    );

    await User.findByIdAndUpdate(userId, { $inc: { stepcoins: 0 } });

    res.json({ mensaje: "🧬 Vida reseteada y stepcoins descontados", vida: 1000 });
  } catch (err) {
    console.error("❌ Error al revivir:", err);
    res.status(500).json({ error: "Error al revivir" });
  }
});

module.exports = router;
