const mongoose = require('mongoose');

const SecretSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  secretKey: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Secret', SecretSchema);
