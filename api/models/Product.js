const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  name: { type:String, required:true },
  slug: { type:String, unique:true },
  shortDescription: String,
  description: String,
  category: { type:String, index:true }, // 'locks'
  images: [String],
  price: { type:Number, required:true }, // en centavos (USD)
  active: { type:Boolean, default:true },
  stock: { type:Number, default:0 },
}, { timestamps:true });

module.exports = mongoose.model('Product', productSchema);
