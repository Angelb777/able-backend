const mongoose = require("mongoose");

const BUCKET_NAME = "media";

function getBucket() {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    throw new Error("MongoDB no está disponible para guardar la imagen");
  }
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
    bucketName: BUCKET_NAME
  });
}

function saveImage(file, folder) {
  if (!file?.buffer?.length) {
    return Promise.reject(new Error("El archivo de imagen está vacío"));
  }

  return new Promise((resolve, reject) => {
    const filename = `${folder}/${Date.now()}-${file.originalname || "image"}`;
    const stream = getBucket().openUploadStream(filename, {
      contentType: file.mimetype,
      metadata: { folder, originalName: file.originalname }
    });

    stream.on("error", reject);
    stream.on("finish", () => resolve(`/api/media/${stream.id}`));
    stream.end(file.buffer);
  });
}

async function sendImage(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ error: "Imagen no encontrada" });
  }

  const id = new mongoose.Types.ObjectId(req.params.id);
  const bucket = getBucket();
  const files = await bucket.find({ _id: id }).limit(1).toArray();
  const file = files[0];
  if (!file) {
    return res.status(404).json({ error: "Imagen no encontrada" });
  }

  res.set({
    "Content-Type": file.contentType || "application/octet-stream",
    "Content-Length": file.length,
    "Cache-Control": "public, max-age=31536000, immutable"
  });

  const stream = bucket.openDownloadStream(id);
  stream.on("error", (error) => {
    if (!res.headersSent) {
      res.status(404).json({ error: "Imagen no encontrada" });
    } else {
      res.destroy(error);
    }
  });
  stream.pipe(res);
}

module.exports = { saveImage, sendImage };
