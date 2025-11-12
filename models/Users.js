const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const UsersSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ["admin", "user"], default: "user" },
  paypal_client_id: { type: String, required: true },
  paypal_client_secret: { type: String, required: true },
  sandbox_email: { type: String },
  createdAt: { type: Date, default: Date.now },
});

// hash password before saving
UsersSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

module.exports = mongoose.models.Users || mongoose.model("Users", UsersSchema, "users");
