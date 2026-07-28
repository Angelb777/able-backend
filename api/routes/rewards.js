// api/routes/rewards.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const Reward = require("../models/Reward");
const User = require("../models/User");
const { verifyToken, checkRole } = require("../middlewares/authMiddleware");

// El catálogo cambia desde el panel de administración. Evita que Flutter,
// navegadores o proxies reutilicen una respuesta anterior después de un borrado.
router.use((req, res, next) => {
  if (req.method === "GET") {
    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });
  }
  next();
});

// Configuración de Multer para subir imágenes localmente
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/rewards");
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

// Crear nuevo descuento o premio. Los creados por un administrador se
// publican directamente; los de comercios requieren validación.
router.post(
  "/",
  verifyToken,
  checkRole(["admin", "comercio"]),
  upload.array("imagenes", 3),
  async (req, res) => {
  try {
    const {
      tipo,
      titulo,
      descripcion,
      direccion,
      porcentaje,
      cantidadEuros,
      stepcoins
    } = req.body;

    const creadoPorAdmin = req.user.role === "admin";

    // ⚠️ Mantengo exactamente como lo tenías:
    const imagenes = (req.files || []).map((file) => file.path);

    const nuevo = new Reward({
      tipo,
      titulo,
      descripcion,
      direccion,
      porcentaje,
      cantidadEuros,
      stepcoins,
      imagenes,
      comercioId: creadoPorAdmin ? null : req.user.id,
      validado: creadoPorAdmin,
      creadoPorAdmin
    });

    await nuevo.save();
    res.status(201).json({ message: "Descuento/Premio creado correctamente" });
  } catch (err) {
    console.error("Error al crear reward:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
  }
);

// Obtener rewards validados y ordenados por prioridad
router.get("/validados", async (req, res) => {
  try {
    // Incluye también rewards antiguos del admin que quedaron guardados como
    // pendientes antes de que la publicación automática estuviera corregida.
    const rewards = await Reward.find({
      $or: [
        { validado: true },
        { creadoPorAdmin: true }
      ]
    });

    const conPrioridad = rewards.map(r => {
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
        fechaCreacion: r.fechaCreacion || new Date(0), // fallback
        creadoPorAdmin: r.creadoPorAdmin
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

// Obtener todos los rewards validados (para clientes)
router.get("/", async (req, res) => {
  try {
    const rewards = await Reward.find({
      $or: [
        { validado: true },
        { creadoPorAdmin: true }
      ]
    }).sort({ fechaCreacion: -1 });
    res.json(rewards);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener rewards" });
  }
});

// Catálogo completo para la gestión del superadmin. La ruta /mis/:comercioId
// solo contiene los anuncios de un propietario y no representa lo que Flutter
// muestra en el catálogo público.
router.get("/gestion", verifyToken, checkRole(["admin"]), async (req, res) => {
  try {
    const rewards = await Reward.find().sort({ fechaCreacion: -1 });
    res.json(rewards);
  } catch (err) {
    console.error("Error al obtener el catálogo para gestión:", err);
    res.status(500).json({ error: "Error al obtener el catálogo" });
  }
});

// Obtener rewards de un comercio específico
router.get("/mis/:comercioId", async (req, res) => {
  try {
    const rewards = await Reward.find({ comercioId: req.params.comercioId });
    res.json(rewards);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener tus rewards" });
  }
});

// Validar (publicar) un reward (solo admin)
router.patch("/:id/validar", async (req, res) => {
  try {
    await Reward.findByIdAndUpdate(req.params.id, { validado: true });
    res.json({ message: "✅ Validado correctamente" });
  } catch (err) {
    res.status(500).json({ error: "Error al validar reward" });
  }
});

// Eliminar reward (admin o comercio propietario)
router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const reward = await Reward.findById(req.params.id);
    if (!reward) return res.status(404).json({ error: "No encontrado" });

    const esAdmin = req.user.role === "admin";
    const esComercioPropietario =
      req.user.role === "comercio" &&
      reward.comercioId &&
      String(reward.comercioId) === String(req.user.id);

    if (!esAdmin && !esComercioPropietario) {
      return res.status(403).json({ error: "No tienes permiso para eliminar este reward" });
    }

    const eliminado = await Reward.findByIdAndDelete(req.params.id);
    if (!eliminado) {
      return res.status(404).json({ error: "El reward ya no existe" });
    }

    // Limpia referencias antiguas si algún usuario lo tenía guardado en este
    // campo. El reward ya está eliminado: un fallo de limpieza no debe hacer
    // creer al panel que el borrado principal falló.
    try {
      await User.updateMany(
        { rewardsComprados: eliminado._id },
        { $pull: { rewardsComprados: eliminado._id } }
      );
    } catch (cleanupError) {
      console.error("Reward eliminado, pero falló la limpieza de referencias:", cleanupError);
    }

    res.json({ message: "Reward eliminado", id: String(eliminado._id) });
  } catch (err) {
    console.error("Error al eliminar reward:", err);
    res.status(500).json({ error: "Error al eliminar" });
  }
});

// =========================
//       COMPRAS (USER)
// =========================

// Comprar un reward (cliente)
router.post("/:id/comprar", async (req, res) => {
  console.log("📥 Body recibido en el backend:", req.body);
  const { userId } = req.body;
  const rewardId = req.params.id;

  console.log("📥 Compra solicitada:", { userId, rewardId });

  if (!userId || !rewardId) {
    console.warn("❌ Faltan datos obligatorios");
    return res.status(400).json({ error: "Faltan datos obligatorios (userId o rewardId)" });
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

    if (user.stepcoins < reward.stepcoins) {
      console.warn("❌ Stepcoins insuficientes:", user.stepcoins, "<", reward.stepcoins);
      return res.status(400).json({ error: "No tienes suficientes stepcoins" });
    }

    // Descontar y guardar
    user.stepcoins -= reward.stepcoins;
    await user.save();

    // Guardar la compra
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
router.get("/mis-compras", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) return res.status(400).json({ error: "Falta userId" });

    // Rewards donde el usuario aparece en compradores con validado:false
    const rewards = await Reward.find({
      "compradores.userId": userId,
      "compradores.validado": false,
    })
      .select("tipo titulo descripcion direccion porcentaje cantidadEuros stepcoins imagenes compradores fechaCreacion")
      .lean();

    // Normalizar respuesta para el front
    const out = [];
    for (const r of rewards) {
      const compra = (r.compradores || []).find(
        (c) => String(c.userId) === userId && c.validado === false
      );
      if (!compra) continue;

      out.push({
        rewardId: r._id,
        purchaseId: compra._id, // útil si luego validáis por purchaseId
        validado: !!compra.validado, // false por filtro
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
    const reward = await Reward.findById(req.params.id).populate("compradores.userId", "nombre email");
    if (!reward) return res.status(404).json({ error: "Reward no encontrado" });

    res.json(reward.compradores || []);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener compradores" });
  }
});

// Validar compra (por el comercio)
router.patch("/:id/validar-compra/:userId", async (req, res) => {
  try {
    const reward = await Reward.findById(req.params.id);
    if (!reward || !reward.compradores) return res.status(404).json({ error: "No encontrado" });

    const comprador = reward.compradores.find(c => c.userId.toString() === req.params.userId);
    if (comprador) {
      comprador.validado = true;
      await reward.save();
      res.json({ message: "Compra validada" });
    } else {
      res.status(404).json({ error: "Comprador no encontrado" });
    }
  } catch (err) {
    res.status(500).json({ error: "Error al validar compra" });
  }
});

// /api/rewards/compras/:comercioId
router.get("/compras/:comercioId", async (req, res) => {
  try {
    const rewards = await Reward.find({ comercioId: req.params.comercioId })
      .populate("compradores.userId", "nombre email")
      .select("titulo compradores");

    const compradores = rewards.flatMap(reward =>
      (reward.compradores || [])
        .filter(c => !c.validado)
        .map(c => ({
          rewardId: reward._id,
          rewardTitulo: reward.titulo,
          compradorId: c.userId._id,
          compradorNombre: c.userId.nombre,
          compradorEmail: c.userId.email
        }))
    );

    res.json(compradores);
  } catch (err) {
    console.error("❌ Error al cargar compradores:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

// /api/rewards/validar-compra
router.post("/validar-compra", async (req, res) => {
  const { rewardId, compradorId } = req.body;

  try {
    const reward = await Reward.findById(rewardId);
    const comprador = (reward.compradores || []).find(c => c.userId.toString() === compradorId);
    if (!comprador) return res.status(404).json({ error: "Comprador no encontrado" });

    comprador.validado = true;
    await reward.save();

    res.json({ message: "Compra validada correctamente" });
  } catch (err) {
    console.error("❌ Error al validar compra:", err);
    res.status(500).json({ error: "Error al validar compra" });
  }
});

// Obtener todas las compras si es admin
router.get("/compras", async (req, res) => {
  try {
    const rewards = await Reward.find()
      .populate("compradores.userId", "nombre email")
      .select("titulo compradores");

    const compradores = rewards.flatMap(reward =>
      (reward.compradores || [])
        .filter(c => !c.validado && c.userId) // solo los no validados y con user válido
        .map(c => ({
          rewardId: reward._id,
          rewardTitulo: reward.titulo,
          compradorId: c.userId._id,
          compradorNombre: c.userId.nombre,
          compradorEmail: c.userId.email
        }))
    );

    res.json(compradores);
  } catch (err) {
    console.error("❌ Error al obtener compras (admin):", err);
    res.status(500).json({ error: "Error al obtener compras" });
  }
});

// =========================

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
    res.status(500).json({ error: "Error al destacar reward" });
  }
});

// Pendientes de validación (para admin): rewards aún no publicados
router.get("/pendientes", async (req, res) => {
  try {
    const rewards = await Reward.find({
      validado: false,
      $or: [
        { creadoPorAdmin: false },
        { creadoPorAdmin: { $exists: false } }
      ]
    })
      .select("_id tipo titulo descripcion direccion porcentaje cantidadEuros stepcoins imagenes comercioId fechaCreacion creadoPorAdmin")
      .sort({ fechaCreacion: -1 })
      .lean();

    res.json(rewards);
  } catch (err) {
    console.error("❌ Error al obtener rewards pendientes:", err);
    res.status(500).json({ error: "Error al obtener pendientes" });
  }
});

module.exports = router;
