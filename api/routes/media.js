const express = require("express");
const { sendImage } = require("../utils/mediaStorage");

const router = express.Router();

router.get("/:id", async (req, res) => {
  try {
    await sendImage(req, res);
  } catch (error) {
    console.error("Error al servir imagen persistente:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Error al cargar la imagen" });
    }
  }
});

module.exports = router;
