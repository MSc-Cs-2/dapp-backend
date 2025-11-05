const mongoose = require("mongoose");

const TransactionsSchema = new mongoose.Schema({
  sender: { type: String, required: true },
  recipient: { type: String, required: true },
  amount: { type: Number, required: true },
  timestamp: { type: Date, default: Date.now },
  blockHash: { type: String, required: true },
  ethereumTxHash: { type: String, default: null },
  broadcasted: {type: Boolean, default: true},
  status: { type: String, enum: ['completed', 'failed'], default: 'completed' },
});

module.exports = mongoose.model("Blockchain_Transactions", TransactionsSchema, "transactions");
