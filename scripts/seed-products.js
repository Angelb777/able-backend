// scripts/seed-products.js
require('dotenv').config();
const mongoose = require('mongoose');

// 👇 Ajusta la ruta al modelo según tu estructura
// Si tus modelos están en api/models (como parece por tus routes):
const Product = require('../api/models/Product');
// Si en tu proyecto REAL estuvieran en /models, sería:  const Product = require('../models/Product');

async function run() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Conectado a MongoDB');

    const candado = {
      name: "Candado Able73",
      slug: "candado-able73",
      shortDescription: "Keyless Bluetooth · Solar/DC · IPX6",
      description:
        "Candado inteligente con desbloqueo vía Bluetooth, carga solar y DC, resistencia IPX6.",
      category: "locks",
      images: ["/img/candado1.png"],
      price: 9900, // $99.00 (centavos)
      stock: 100,
      active: true,
    };

    const result = await Product.findOneAndUpdate(
      { slug: candado.slug },
      { $set: candado },
      { upsert: true, new: true }
    );

    console.log("✅ Producto insertado/actualizado:", {
      _id: result._id,
      name: result.name,
      price: result.price,
      category: result.category,
    });
    process.exit(0);
  } catch (err) {
    console.error("❌ Error al seedear:", err);
    process.exit(1);
  }
}

run();
