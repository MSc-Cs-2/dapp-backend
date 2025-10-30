// const { ethers } = require("ethers");
// const wallet = ethers.Wallet.createRandom();
// console.log("Address:", wallet.address);
// console.log("Private key:", wallet.privateKey);

require('dotenv').config();
const { ethers } = require("ethers");

const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);

provider.getBlockNumber().then(
  (block) => console.log("✅ Connected! Latest block:", block),
  (err) => console.error("❌ RPC Error:", err)
);

