// api/routes/rewards.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const mongoose = require("mongoose");
const Reward = require("../models/Reward");
const User = require("../models/User");
const StepcoinTransaction = require("../models/StepcoinTransaction");
const Establishment = require("../models/Establishment");
const CommercialRequest = require("../models/CommercialRequest");
const { recordTransition } = require("../services/commercialWorkflow");
const { verifyToken, checkRole } = require("../middlewares/authMiddleware");
const { saveImage } = require("../utils/mediaStorage");
const adminOnly = [verifyToken, checkRole(["admin"])];

const publicRewardFilter = {
  $or: [
    { validado: true },
    { creadoPorAdmin: true }
  ],
  publicationStatus: { $nin: ["disabled", "retired"] }
};

function hasCatalogOrder(reward) {
  return Number.isFinite(reward.ordenCatalogo) && reward.ordenCatalogo >= 0;
}

async function requireRewardOwnerOrAdmin(req, res, next) {
  try {
    const rewardId = req.params.id || req.body.rewardId;
    const reward = await Reward.findById(rewardId);
    if (!reward) return res.status(404).json({ error: "Reward no encontrado" });
    const owner = reward.comercioId && String(reward.comercioId) === String(req.user.id);
    if (req.user.role !== "admin" && !(req.user.role === "comercio" && owner)) {
      return res.status(403).json({ error: "No puedes gestionar un reward de otro comercio" });
    }
    req.reward = reward;
    next();
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

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

// Guarda las imágenes temporalmente en memoria y después en MongoDB/GridFS.
// Así no dependen del sistema de archivos efímero del servidor y sobreviven
// a commits, reinicios y nuevos despliegues, igual que cartas y OVNIs.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype?.startsWith("image/")) {
      return cb(new Error("Sólo se permiten archivos de imagen"));
    }
    cb(null, true);
  }
});

function uploadRewardImages(req, res, next) {
  upload.array("imagenes", 3)(req, res, (error) => {
    if (error) {
      console.error("Error subiendo imágenes del reward:", error);
      return res.status(400).json({ error: `No se pudo subir la imagen: ${error.message}` });
    }
    next();
  });
}

// =========================
//     CREATE / READ
// =========================

// Crear nuevo descuento o premio. Los creados por un administrador se
// publican directamente; los de comercios requieren validación.
router.post(
  "/",
  verifyToken,
  checkRole(["admin", "comercio"]),
  uploadRewardImages,
  async (req, res) => {
  try {
    const {
      tipo,
      titulo,
      descripcion,
      direccion,
      porcentaje,
      cantidadEuros,
      stepcoins,
      unidades
    } = req.body;

    const creadoPorAdmin = req.user.role === "admin";
    const parsedStepcoins = Number(stepcoins);
    const parsedPercentage = Number(porcentaje || 0);
    const parsedAmount = Number(cantidadEuros || 0);
    const parsedUnits = Number(unidades);
    if (!["descuento", "premio"].includes(tipo) || !String(titulo || "").trim()) {
      return res.status(400).json({ error: "Tipo y título válidos son obligatorios" });
    }
    if (!Number.isFinite(parsedStepcoins) || parsedStepcoins < 0) {
      return res.status(400).json({ error: "Stepcoins no válidos" });
    }
    if (tipo === "premio" && (!Number.isInteger(parsedUnits) || parsedUnits < 0)) {
      return res.status(400).json({ error: "Unidades no validas" });
    }
    if (tipo === "descuento" && (
      !Number.isFinite(parsedPercentage) || parsedPercentage < 0 || parsedPercentage > 100
      || !Number.isFinite(parsedAmount) || parsedAmount < 0
      || (parsedPercentage <= 0 && parsedAmount <= 0)
    )) {
      return res.status(400).json({ error: "Descuento no válido" });
    }

    const imagenesPersistentes = await Promise.all(
      (req.files || []).map((file) => saveImage(file, "rewards"))
    );
    // La app móvil compone las rutas relativas con la URL del backend.
    const imagenes = imagenesPersistentes;

    const nuevo = new Reward({
      tipo,
      titulo,
      descripcion,
      direccion,
      porcentaje: parsedPercentage,
      cantidadEuros: parsedAmount,
      stepcoins: parsedStepcoins,
      unidades: tipo === "premio" ? parsedUnits : null,
      imagenes,
      comercioId: creadoPorAdmin ? null : req.user.id,
      validado: creadoPorAdmin,
      creadoPorAdmin,
      publicationStatus: creadoPorAdmin ? "published" : "pending",
      publishedAt: creadoPorAdmin ? new Date() : undefined,
    });

    await nuevo.save();
    if (!creadoPorAdmin) {
      try {
        const establishment = await Establishment.findOne({ ownerId: req.user.id });
        const request = await CommercialRequest.create({
          ownerId: req.user.id,
          establishmentId: establishment?._id,
          type: "reward",
          subtype: tipo === "premio" ? "prize" : "discount",
          title: String(titulo).trim(),
          status: "pending_review",
          price: 0,
          paymentStatus: "not_required",
          formData: {
            rewardType: tipo,
            description: descripcion,
            address: direccion,
            percentage: parsedPercentage,
            amountEuros: parsedAmount,
            stepcoins: parsedStepcoins,
            unidades: tipo === "premio" ? parsedUnits : null,
          },
          materials: (req.files || []).map((file, index) => ({
            url: imagenes[index], originalName: file.originalname,
            mimeType: file.mimetype, size: file.size, label: "reward-image",
          })),
          targetModel: "Reward",
          targetId: nuevo._id,
          legacySource: "rewards-commerce-endpoint",
          history: [{
            action: "created_compatibility_endpoint",
            toStatus: "pending_review",
            actorId: req.user.id,
            actorRole: req.user.role,
          }],
        });
        nuevo.commercialRequestId = request._id;
        await nuevo.save();
      } catch (workflowError) {
        await Reward.deleteOne({ _id: nuevo._id });
        throw workflowError;
      }
    }
    res.status(201).json({
      message: creadoPorAdmin
        ? "Descuento/Premio publicado por Superadmin"
        : "Solicitud creada y pendiente de revisión",
      id: String(nuevo._id),
      status: creadoPorAdmin ? "published" : "pending_review",
    });
  } catch (err) {
    console.error("Error al crear reward:", err);
    res.status(500).json({ error: `Error al guardar el reward: ${err.message}` });
  }
  }
);

// Obtener rewards validados y ordenados por prioridad
router.get("/validados", async (req, res) => {
  try {
    // Incluye también rewards antiguos del admin que quedaron guardados como
    // pendientes antes de que la publicación automática estuviera corregida.
    const rewards = await Reward.find(publicRewardFilter);

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
        unidades: r.unidades,
        imagenes: r.imagenes,
        prioridad,
        fechaCreacion: r.fechaCreacion || new Date(0), // fallback
        creadoPorAdmin: r.creadoPorAdmin,
        ordenCatalogo: r.ordenCatalogo
      };
    });

    conPrioridad.sort((a, b) => {
      const aOrdenado = hasCatalogOrder(a);
      const bOrdenado = hasCatalogOrder(b);
      if (aOrdenado && bOrdenado && a.ordenCatalogo !== b.ordenCatalogo) {
        return a.ordenCatalogo - b.ordenCatalogo;
      }
      if (aOrdenado !== bOrdenado) return aOrdenado ? -1 : 1;
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
    const rewards = await Reward.find(publicRewardFilter).sort({ fechaCreacion: -1 });
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

// Guarda el orden exacto del catalogo que consumen Flutter y los clientes web.
// Se exige la lista completa para detectar catalogos desactualizados.
router.patch("/orden-catalogo", ...adminOnly, async (req, res) => {
  try {
    const orderedIds = req.body?.orderedIds;
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return res.status(400).json({ error: "Debes enviar el catalogo publicado completo" });
    }

    const normalizedIds = orderedIds.map(String);
    if (new Set(normalizedIds).size !== normalizedIds.length
      || normalizedIds.some((id) => !mongoose.isValidObjectId(id))) {
      return res.status(400).json({ error: "El orden contiene identificadores no validos o repetidos" });
    }

    const published = await Reward.find(publicRewardFilter).select("_id").lean();
    const publishedIds = new Set(published.map((reward) => String(reward._id)));
    if (publishedIds.size !== normalizedIds.length
      || normalizedIds.some((id) => !publishedIds.has(id))) {
      return res.status(409).json({
        error: "El catalogo ha cambiado. Actualiza la lista antes de volver a ordenar."
      });
    }

    await Reward.bulkWrite(normalizedIds.map((id, index) => ({
      updateOne: {
        filter: { _id: id },
        update: { $set: { ordenCatalogo: index } }
      }
    })));

    res.json({ message: "Orden del catalogo guardado", orderedIds: normalizedIds });
  } catch (err) {
    console.error("Error al ordenar el catalogo de rewards:", err);
    res.status(500).json({ error: "No se pudo guardar el orden del catalogo" });
  }
});

// Obtener rewards de un comercio específico
router.get("/mis/:comercioId", verifyToken, async (req, res) => {
  try {
    if (req.user.role !== "admin" &&
        !(req.user.role === "comercio" && String(req.user.id) === String(req.params.comercioId))) {
      return res.status(403).json({ error: "No puedes consultar otro comercio" });
    }
    const rewards = await Reward.find({ comercioId: req.params.comercioId });
    res.json(rewards);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener tus rewards" });
  }
});

// Validar (publicar) un reward (solo admin)
router.patch("/:id/validar", ...adminOnly, async (req, res) => {
  try {
    const reward = await Reward.findById(req.params.id);
    if (!reward) return res.status(404).json({ error: "Reward no encontrado" });
    const now = new Date();
    if (reward.commercialRequestId) {
      const request = await CommercialRequest.findById(reward.commercialRequestId);
      if (request && ["rejected", "withdrawn", "retired"].includes(request.status)) {
        return res.status(409).json({ error: "La solicitud comercial está cerrada" });
      }
      if (request && request.status !== "published") {
        request.reviewedBy = req.user.id;
        request.reviewedAt = now;
        request.approvedAt = now;
        request.publishedAt = now;
        recordTransition(request, {
          action: "legacy_validate_and_publish",
          status: "published",
          actorId: req.user.id,
          actorRole: req.user.role,
          notes: String(req.body?.notes || ""),
          now,
        });
        await request.save();
      }
    }
    reward.validado = true;
    reward.publicationStatus = "published";
    reward.publishedAt = now;
    await reward.save();
    res.json({ message: "✅ Validado correctamente" });
  } catch (err) {
    res.status(500).json({ error: "Error al validar reward" });
  }
});

// Actualizar el stock disponible de un premio (admin o comercio propietario).
router.patch("/:id", verifyToken, requireRewardOwnerOrAdmin, async (req, res) => {
  try {
    const reward = req.reward;
    if (reward.tipo !== "premio") {
      return res.status(400).json({ error: "Las unidades solo se aplican a premios" });
    }
    const unidades = Number(req.body?.unidades);
    if (!Number.isInteger(unidades) || unidades < 0) {
      return res.status(400).json({ error: "Unidades no validas" });
    }

    reward.unidades = unidades;
    await reward.save();
    if (reward.commercialRequestId) {
      await CommercialRequest.updateOne(
        { _id: reward.commercialRequestId },
        { $set: { "formData.unidades": unidades } }
      );
    }
    res.json({ message: "Unidades actualizadas", unidades });
  } catch (err) {
    res.status(500).json({ error: "No se pudieron actualizar las unidades" });
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

    if (!esAdmin && reward.commercialRequestId) {
      const linkedRequest = await CommercialRequest.findById(reward.commercialRequestId)
        .select("status");
      if (linkedRequest && ["published", "disabled", "renewal_due"].includes(linkedRequest.status)) {
        return res.status(409).json({
          error: "Una publicación aprobada debe retirarla el Superadmin",
        });
      }
    }

    const eliminado = await Reward.findByIdAndDelete(req.params.id);
    if (!eliminado) {
      return res.status(404).json({ error: "El reward ya no existe" });
    }

    if (eliminado.commercialRequestId) {
      const request = await CommercialRequest.findById(eliminado.commercialRequestId);
      if (request && !["withdrawn", "retired"].includes(request.status)) {
        const nextStatus = esAdmin ? "retired" : "withdrawn";
        recordTransition(request, {
          action: "legacy_reward_delete",
          status: nextStatus,
          actorId: req.user.id,
          actorRole: req.user.role,
          notes: "Reward eliminado desde la pantalla compatible",
        });
        if (esAdmin) request.retiredAt = new Date();
        await request.save();
      }
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
router.post("/:id/comprar", verifyToken, checkRole(["cliente"]), async (req, res) => {
  console.log("📥 Body recibido en el backend:", req.body);
  const userId = req.user.id;
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

    if ((!reward.validado && !reward.creadoPorAdmin) ||
        ["disabled", "retired"].includes(reward.publicationStatus)) {
      return res.status(409).json({ error: "Reward no disponible" });
    }

    if (Number.isFinite(reward.unidades) && reward.unidades <= 0) {
      return res.status(409).json({ error: "Premio agotado" });
    }

    const alreadyPending = (reward.compradores || []).some(
      (purchase) => String(purchase.userId) === String(userId) && !purchase.validado
    );
    if (alreadyPending) {
      return res.status(409).json({
        error: "Ya tienes este descuento o premio pendiente de validar",
      });
    }

    if (!user) {
      console.warn("❌ Usuario no encontrado:", userId);
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    const debitedUser = await User.findOneAndUpdate(
      { _id: userId, stepcoins: { $gte: reward.stepcoins } },
      { $inc: { stepcoins: -reward.stepcoins } },
      { new: true }
    );
    if (!debitedUser) {
      return res.status(400).json({ error: "No tienes suficientes stepcoins" });
    }

    const tracksStock = Number.isFinite(reward.unidades);
    const rewardFilter = {
      _id: rewardId,
      $or: [{ validado: true }, { creadoPorAdmin: true }],
      publicationStatus: { $nin: ["disabled", "retired"] },
      compradores: { $not: { $elemMatch: { userId, validado: false } } },
      ...(tracksStock ? { unidades: { $gt: 0 } } : {}),
    };
    const purchasedAt = new Date();
    const rewardUpdate = {
      $push: { compradores: { userId, validado: false, purchasedAt } },
      ...(tracksStock ? { $inc: { unidades: -1 } } : {}),
    };

    let purchasedReward;
    try {
      purchasedReward = await Reward.findOneAndUpdate(
        rewardFilter,
        rewardUpdate,
        { new: true }
      );
    } catch (purchaseError) {
      await User.updateOne({ _id: userId }, { $inc: { stepcoins: reward.stepcoins } });
      throw purchaseError;
    }
    if (!purchasedReward) {
      await User.updateOne({ _id: userId }, { $inc: { stepcoins: reward.stepcoins } });
      return res.status(409).json({
        error: tracksStock ? "Premio agotado o ya pendiente" : "Reward ya pendiente",
      });
    }

    try {
      await StepcoinTransaction.create({
        userId,
        cantidad: -reward.stepcoins,
        tipo: "canje",
        descripcion: `Canje de ${reward.tipo}: ${reward.titulo}`,
        operationKey: `reward-purchase:${userId}:${rewardId}:${purchasedAt.getTime()}`,
        metadata: { rewardId, rewardType: reward.tipo },
      });
    } catch (ledgerError) {
      console.error("Compra completada, pero no se pudo registrar el movimiento Stepcoin:", ledgerError);
    }

    console.log(`✅ Compra registrada. Usuario ${userId} compró reward ${rewardId}`);
    res.json({
      message: "✅ Compra realizada con éxito",
      stepcoins: debitedUser.stepcoins,
      unidades: purchasedReward.unidades,
    });
  } catch (err) {
    console.error("❌ Error interno al procesar la compra:", err);
    res.status(500).json({ error: "Error interno al procesar la compra" });
  }
});

// >>> NUEVO: Mis compras pendientes de validar (para el pop-up del cliente)
router.get("/mis-compras", verifyToken, checkRole(["cliente"]), async (req, res) => {
  try {
    const userId = String(req.user.id);

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
        createdAt: compra.purchasedAt || r.fechaCreacion || new Date(0),
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
router.get("/:id/compradores", verifyToken, requireRewardOwnerOrAdmin, async (req, res) => {
  try {
    const reward = await Reward.findById(req.params.id).populate("compradores.userId", "nombre email");
    if (!reward) return res.status(404).json({ error: "Reward no encontrado" });

    res.json(reward.compradores || []);
  } catch (err) {
    res.status(500).json({ error: "Error al obtener compradores" });
  }
});

// Validar compra (por el comercio)
router.patch("/:id/validar-compra/:userId", verifyToken, requireRewardOwnerOrAdmin, async (req, res) => {
  try {
    const reward = await Reward.findById(req.params.id);
    if (!reward || !reward.compradores) return res.status(404).json({ error: "No encontrado" });

    const comprador = reward.compradores.find(
      c => String(c.userId) === String(req.params.userId) && !c.validado
    );
    if (comprador) {
      comprador.validado = true;
      comprador.validatedAt = new Date();
      comprador.validatedBy = req.user.id;
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
router.get("/compras/:comercioId", verifyToken, async (req, res) => {
  try {
    if (req.user.role !== "admin" &&
        !(req.user.role === "comercio" && String(req.user.id) === String(req.params.comercioId))) {
      return res.status(403).json({ error: "No puedes consultar otro comercio" });
    }
    const rewards = await Reward.find({ comercioId: req.params.comercioId })
      .populate("compradores.userId", "nickname nombre email")
      .select("titulo compradores");

    const compradores = rewards.flatMap(reward =>
      (reward.compradores || [])
        .filter(c => !c.validado && c.userId)
        .map(c => ({
          rewardId: reward._id,
          rewardTitulo: reward.titulo,
          compradorId: c.userId._id,
          compradorNombre: c.userId.nickname || c.userId.nombre || "Usuario Able",
          compradorEmail: c.userId.email,
          purchasedAt: c.purchasedAt || null,
        }))
    );

    compradores.sort((a, b) => new Date(b.purchasedAt || 0) - new Date(a.purchasedAt || 0));
    res.json(compradores);
  } catch (err) {
    console.error("❌ Error al cargar compradores:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

// /api/rewards/validar-compra
router.post("/validar-compra", verifyToken, requireRewardOwnerOrAdmin, async (req, res) => {
  const { rewardId, compradorId } = req.body;

  try {
    const reward = await Reward.findById(rewardId);
    const comprador = (reward.compradores || []).find(
      c => String(c.userId) === String(compradorId) && !c.validado
    );
    if (!comprador) return res.status(404).json({ error: "Comprador no encontrado" });

    comprador.validado = true;
    comprador.validatedAt = new Date();
    comprador.validatedBy = req.user.id;
    await reward.save();

    res.json({ message: "Compra validada correctamente" });
  } catch (err) {
    console.error("❌ Error al validar compra:", err);
    res.status(500).json({ error: "Error al validar compra" });
  }
});

// El Superadmin entrega únicamente premios creados por Able. Las compras de
// un comercio aparecen exclusivamente en la cuenta propietaria del anuncio.
router.get("/compras", ...adminOnly, async (req, res) => {
  try {
    const rewards = await Reward.find({
      $or: [{ creadoPorAdmin: true }, { comercioId: null }],
    })
      .populate("compradores.userId", "nickname nombre email")
      .select("titulo compradores");

    const compradores = rewards.flatMap(reward =>
      (reward.compradores || [])
        .filter(c => !c.validado && c.userId) // solo los no validados y con user válido
        .map(c => ({
          rewardId: reward._id,
          rewardTitulo: reward.titulo,
          compradorId: c.userId._id,
          compradorNombre: c.userId.nickname || c.userId.nombre || "Usuario Able",
          compradorEmail: c.userId.email,
          purchasedAt: c.purchasedAt || null,
        }))
    );

    compradores.sort((a, b) => new Date(b.purchasedAt || 0) - new Date(a.purchasedAt || 0));
    res.json(compradores);
  } catch (err) {
    console.error("❌ Error al obtener compras (admin):", err);
    res.status(500).json({ error: "Error al obtener compras" });
  }
});

// =========================

router.patch("/:id/destacar", ...adminOnly, async (req, res) => {
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
router.get("/pendientes", ...adminOnly, async (req, res) => {
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
