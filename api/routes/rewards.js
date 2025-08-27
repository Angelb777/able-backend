// api/routes/rewards.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");

const Reward = require("../models/Reward");
const User = require("../models/User");

// --- Asegurar carpeta de uploads ---
const UPLOAD_DIR = path.join(process.cwd(), "uploads", "rewards");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// --- Multer: subir imágenes localmente ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

// =========================
//     CREATE / READ
// =========================

// Crear nuevo descuento o premio
router.post("/", upload.array("imagenes", 3), async (req, res) => {
  try {
    const {
      tipo,
      titulo,
      descripcion,
      direccion,
      porcentaje,
      cantidadEuros,
      stepcoins,
      comercioId,
    } = req.body;

    const imagenes = (req.files || []).map((file) => {
      // devolver ruta pública relativa
      const rel = path.relative(process.cwd(), file.path).replace(/\\/g, "/");
      return `/${rel}`;
    });

    const nuevo = new Reward({
      tipo,
      titulo,
      descripcion,
      direccion,
      porcentaje,
      cantidadEuros,
      stepcoins,
      imagenes,
      comercioId: comercioId || null,
      validado: false,
      creadoPorAdmin: !comercioId, // si no hay comercio => creado por admin
    });

    await nuevo.save();
    res.status(201).json({ message: "Descuento/Premio creado correctamente" });
  } catch (err) {
    console.error("Error al crear reward:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// Obtener rewards validados y ordenados por prioridad
router.get("/validados", async (req, res) => {
  try {
    const rewards = await Reward.find({ validado: true }).lean();

    const conPrioridad = rewards.map((r) => {
      let prioridad = 0;
      if (r.creadoPorAdmin) prioridad = 100;
      else if (r.destacado) {
        if (r.nivelDestacado === 1) prioridad = 90;
        else if (r.nivelDestacado === 2) prioridad = 80;
        else if (r.nivelDestacado === 3) prioridad = 70;
        else prioridad = 60;
      }

      return {
        _id: r._id,
        tipo: r.tipo,
        titulo: r.titulo,
        descripcion: r.descripcion,
        direccion: r.direccion,
        porcentaje: r.porcentaje,
        cantidadEuros: r.cantidadEuros,
        stepcoins: r.stepcoins,
        imagenes: r.imagenes,
        prioridad,
        fechaCreacion: r.fechaCreacion || new Date(0),
        creadoPorAdmin: r.creadoPorAdmin,
      };
    });

    conPrioridad.sort((a, b) => {
      if (b.prioridad !== a.prioridad) return b.prioridad - a.prioridad;
      return new Date(b.fechaCreacion) - new Date(a.fechaCreacion);
    });

    res.json(conPrioridad);
  } catch (err) {
    console.error("Error al obtener rewards validados:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// Obtener todos los rewards validados (listado simple para clientes)
router.get("/", async (req, res) => {
  try {
    const rewards = await Reward.find({ validado: true }).sort({ fechaCreacion: -1 });
    res.json(rewards);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener rewards" });
  }
});

// Obtener rewards de un comercio específico
router.get("/mis/:comercioId", async (req, res) => {
  try {
    const rewards = await Reward.find({ comercioId: req.params.comercioId });
    res.json(rewards);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener tus rewards" });
  }
});

// =========================
//      DESTACAR / CRUD
// =========================

// Marcar un reward como destacado (nivel 1, 2, 3) – versión A
router.put("/destacar/:id", async (req, res) => {
  const { nivel } = req.body; // 1 = top5, 2 = top10, 3 = top20
  try {
    const reward = await Reward.findById(req.params.id);
    if (!reward) return res.status(404).json({ error: "Reward no encontrado" });

    reward.destacado = true;
    reward.nivelDestacado = nivel;
    await reward.save();

    res.json({ mensaje: "✅ Reward destacado con éxito", reward });
  } catch (err) {
    console.error("Error al destacar reward:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// Marcar un reward como destacado (nivel 1, 2, 3) – versión B (compat)
router.patch("/:id/destacar", async (req, res) => {
  const { nivel } = req.body; // 1, 2, 3
  try {
    const reward = await Reward.findById(req.params.id);
    if (!reward) return res.status(404).json({ error: "Reward no encontrado" });

    reward.destacado = true;
    reward.nivelDestacado = nivel;
    await reward.save();

    res.json({ message: "✅ Reward destacado correctamente" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al destacar reward" });
  }
});

// Validar (publicar) un reward (solo admin)
router.patch("/:id/validar", async (req, res) => {
  try {
    await Reward.findByIdAndUpdate(req.params.id, { validado: true });
    res.json({ message: "✅ Validado correctamente" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al validar reward" });
  }
});

// Eliminar reward (admin o comercio)
router.delete("/:id", async (req, res) => {
  try {
    const reward = await Reward.findById(req.params.id);
    if (!reward) return res.status(404).json({ error: "No encontrado" });

    await Reward.findByIdAndDelete(req.params.id);
    res.json({ message: "Reward eliminado" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al eliminar" });
  }
});

// =========================
//       COMPRAS (USER)
// =========================

// Comprar un reward (cliente) -> descuenta stepcoins y añade a compradores {userId, validado:false}
router.post("/:id/comprar", async (req, res) => {
  console.log("📥 Body recibido en el backend:", req.body);
  const { userId } = req.body;
  const rewardId = req.params.id;

  console.log("📥 Compra solicitada:", { userId, rewardId });

  if (!userId || !rewardId) {
    console.warn("❌ Faltan datos obligatorios");
    return res.status(400).json({ error: "Faltan datos obligatorios (userId o rewardId)" });
  }

  if (!mongoose.Types.ObjectId.isValid(rewardId)) {
    return res.status(400).json({ error: "RewardId inválido" });
  }
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return res.status(400).json({ error: "UserId inválido" });
  }

  try {
    const reward = await Reward.findById(rewardId);
    const user = await User.findById(userId);

    if (!reward) {
      console.warn("❌ Reward no encontrado:", rewardId);
      return res.status(404).json({ error: "Reward no encontrado" });
    }

    if (!user) {
      console.warn("❌ Usuario no encontrado:", userId);
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    // Evita duplicados pendientes del mismo reward
    const yaPendiente = (reward.compradores || []).some(
      (c) => String(c.userId) === String(userId) && c.validado === false
    );
    if (yaPendiente) {
      return res.status(400).json({ error: "Ya tienes este descuento pendiente de validar" });
    }

    if ((user.stepcoins || 0) < (reward.stepcoins || 0)) {
      console.warn("❌ Stepcoins insuficientes:", user.stepcoins, "<", reward.stepcoins);
      return res.status(400).json({ error: "No tienes suficientes stepcoins" });
    }

    // Descontar y guardar usuario
    user.stepcoins = (user.stepcoins || 0) - (reward.stepcoins || 0);
    await user.save();

    // Guardar la compra en el reward
    if (!reward.compradores) reward.compradores = [];
    reward.compradores.push({ userId, validado: false });
    await reward.save();

    console.log(`✅ Compra registrada. Usuario ${userId} compró reward ${rewardId}`);
    res.json({ message: "✅ Compra realizada con éxito" });
  } catch (err) {
    console.error("❌ Error interno al procesar la compra:", err);
    res.status(500).json({ error: "Error interno al procesar la compra" });
  }
});

// >>> NUEVO: Mis compras pendientes de validar (para el pop-up del cliente)
// GET /api/rewards/mis-compras?userId=...
router.get("/mis-compras", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) return res.status(400).json({ error: "Falta userId" });
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: "UserId inválido" });
    }

    // Rewards donde el usuario aparece en compradores con validado:false
    const rewards = await Reward.find({
      "compradores.userId": userId,
      "compradores.validado": false,
    })
      .select(
        "tipo titulo descripcion direccion porcentaje cantidadEuros stepcoins imagenes compradores fechaCreacion"
      )
      .lean();

    // Normalizar: devolver solo la "compra" del user y campos útiles para el front
    const out = [];
    for (const r of rewards) {
      const compra = (r.compradores || []).find(
        (c) => String(c.userId) === userId && c.validado === false
      );
      if (!compra) continue;

      out.push({
        rewardId: r._id,
        purchaseId: compra._id, // útil si luego validáis por purchaseId
        validado: !!compra.validado, // false aquí por filtro
        tipo: r.tipo,
        titulo: r.titulo,
        descripcion: r.descripcion,
        direccion: r.direccion,
        porcentaje: r.porcentaje,
        cantidadEuros: r.cantidadEuros,
        stepcoins: r.stepcoins,
        imagenes: r.imagenes || [],
        createdAt: r.fechaCreacion || new Date(0),
      });
    }

    // Orden: más recientes primero
    out.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.json(out);
  } catch (err) {
    console.error("mis-compras error:", err);
    return res.status(500).json({ error: "Error al obtener tus compras" });
  }
});

// =========================
//     VALIDACIONES
// =========================

// Ver compradores (para comercio)
router.get("/:id/compradores", async (req, res) => {
  try {
    const reward = await Reward.findById(req.params.id).populate(
      "compradores.userId",
      "nombre email"
    );
    if (!reward) return res.status(404).json({ error: "Reward no encontrado" });

    res.json(reward.compradores || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener compradores" });
  }
});

// Validar compra (por el comercio) usando userId
router.patch("/:id/validar-compra/:userId", async (req, res) => {
  try {
    const reward = await Reward.findById(req.params.id);
    if (!reward || !reward.compradores) return res.status(404).json({ error: "No encontrado" });

    const comprador = reward.compradores.find((c) => c.userId.toString() === req.params.userId);
    if (comprador) {
      comprador.validado = true;
      await reward.save();
      res.json({ message: "Compra validada" });
    } else {
      res.status(404).json({ error: "Comprador no encontrado" });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al validar compra" });
  }
});

// /api/rewards/validar-compra (opción POST con body { rewardId, compradorId })
router.post("/validar-compra", async (req, res) => {
  const { rewardId, compradorId } = req.body;

  try {
    if (!mongoose.Types.ObjectId.isValid(rewardId)) {
      return res.status(400).json({ error: "RewardId inválido" });
    }
    if (!mongoose.Types.ObjectId.isValid(compradorId)) {
      return res.status(400).json({ error: "compradorId inválido" });
    }

    const reward = await Reward.findById(rewardId);
    if (!reward) return res.status(404).json({ error: "Reward no encontrado" });

    const comprador = (reward.compradores || []).find(
      (c) => String(c.userId) === String(compradorId)
    );
    if (!comprador) return res.status(404).json({ error: "Comprador no encontrado" });

    comprador.validado = true;
    await reward.save();

    res.json({ message: "Compra validada correctamente" });
  } catch (err) {
    console.error("❌ Error al validar compra:", err);
    res.status(500).json({ error: "Error al validar compra" });
  }
});

// =========================
//    VISTAS AUXILIARES
// =========================

// Obtener rewards pendientes de validación (admin / panel)
router.get("/pendientes", async (req, res) => {
  try {
    const pendientes = await Reward.find({ validado: false }).sort({ fechaCreacion: -1 });
    res.json(pendientes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener promociones pendientes" });
  }
});

// Compras agrupadas por comercio (pendientes)
router.get("/compras/:comercioId", async (req, res) => {
  try {
    const rewards = await Reward.find({ comercioId: req.params.comercioId })
      .populate("compradores.userId", "nombre email")
      .select("titulo compradores");

    const compradores = rewards.flatMap((reward) =>
      (reward.compradores || [])
        .filter((c) => !c.validado && c.userId)
        .map((c) => ({
          rewardId: reward._id,
          rewardTitulo: reward.titulo,
          compradorId: c.userId._id,
          compradorNombre: c.userId.nombre,
          compradorEmail: c.userId.email,
        }))
    );

    res.json(compradores);
  } catch (err) {
    console.error("❌ Error al cargar compradores:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

// Todas las compras (pendientes) – modo admin
router.get("/compras", async (req, res) => {
  try {
    const rewards = await Reward.find()
      .populate("compradores.userId", "nombre email")
      .select("titulo compradores");

    const compradores = rewards.flatMap((reward) =>
      (reward.compradores || [])
        .filter((c) => !c.validado && c.userId)
        .map((c) => ({
          rewardId: reward._id,
          rewardTitulo: reward.titulo,
          compradorId: c.userId._id,
          compradorNombre: c.userId.nombre,
          compradorEmail: c.userId.email,
        }))
    );

    res.json(compradores);
  } catch (err) {
    console.error("❌ Error al obtener compras (admin):", err);
    res.status(500).json({ error: "Error al obtener compras" });
  }
});

module.exports = router;
