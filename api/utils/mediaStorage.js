const mongoose = require("mongoose");

const BUCKET_NAME = "media";

function detectedImageContentType(buffer) {
  if (!Buffer.isBuffer(buffer)) return '';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  )) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) {
    return 'image/gif';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}

function detectedMaterialContentType(buffer) {
  const imageType = detectedImageContentType(buffer);
  if (imageType) return imageType;
  if (!Buffer.isBuffer(buffer)) return '';
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-') {
    return 'application/pdf';
  }
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b &&
      [[0x03, 0x04], [0x05, 0x06], [0x07, 0x08]].some(
        ([a, b]) => buffer[2] === a && buffer[3] === b
      )) return 'application/zip';
  return '';
}

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
  const contentType = detectedImageContentType(file.buffer);
  if (!contentType) {
    return Promise.reject(new Error('El archivo no es una imagen PNG, JPEG, GIF o WebP valida'));
  }

  return new Promise((resolve, reject) => {
    const filename = `${folder}/${Date.now()}-${file.originalname || "image"}`;
    const stream = getBucket().openUploadStream(filename, {
      contentType,
      metadata: { folder, originalName: file.originalname }
    });

    stream.on("error", reject);
    stream.on("finish", () => resolve(`/api/media/${stream.id}`));
    stream.end(file.buffer);
  });
}

function saveMaterial(file, folder) {
  if (!file?.buffer?.length) {
    return Promise.reject(new Error('El material esta vacio'));
  }
  const contentType = detectedMaterialContentType(file.buffer);
  if (!contentType) {
    return Promise.reject(new Error('El material no es una imagen, PDF o ZIP valido'));
  }

  return new Promise((resolve, reject) => {
    const filename = `${folder}/${Date.now()}-${file.originalname || 'material'}`;
    const stream = getBucket().openUploadStream(filename, {
      contentType,
      metadata: { folder, originalName: file.originalname }
    });
    stream.on('error', reject);
    stream.on('finish', () => resolve(`/api/media/${stream.id}`));
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

module.exports = {
  detectedImageContentType,
  detectedMaterialContentType,
  saveImage,
  saveMaterial,
  sendImage,
};
