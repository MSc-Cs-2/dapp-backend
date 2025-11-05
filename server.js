const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const cors = require('cors');
const mongoose = require('mongoose');
const { spawn } = require('child_process');
const { ethers } = require('ethers');
const http = require('http'); // Added for Socket.IO
const { Server } = require('socket.io'); // Added for Socket.IO

const TransactionsSchema = require('./models/TransactionsSchema');

dotenv.config();
const app = express();
const server = http.createServer(app); // Create HTTP server manually
const io = new Server(server, { cors: { origin: '*' } }); // Enable Socket.IO

app.use(cors());
app.use(express.json());

// Custom log emitter (logs to console + sends to browser)
function logToClient(msg) {
  console.log(msg);
  io.emit('server-log', msg);
}

// Ethereum setup (optional on-chain logging)
const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
const wallet = new ethers.Wallet(process.env.SEPOLIA_PRIVATE_KEY || '', provider);

// MongoDB connection
mongoose.connect(process.env.MONGOURI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => logToClient('✅ MongoDB connection success!'))
  .catch((e) => logToClient(`❌ MongoDB connection error: ${e}`));

// Helper: get PayPal access token
async function getPayPalAccessToken() {
  const res = await axios({
    url: `${process.env.PAYPAL_API}/v1/oauth2/token`,
    method: 'post',
    auth: {
      username: process.env.PAYPAL_CLIENT_ID,
      password: process.env.PAYPAL_SECRET,
    },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: 'grant_type=client_credentials',
  });
  return res.data.access_token;
}

// Route: Send Money
app.post('/send-money', async (req, res) => {
  try {
    const { sender, recipient, amount, signature, broadcastToEthereum } = req.body;

    if (!sender || !recipient || !amount || !signature) {
      logToClient('⚠️ Missing sender, recipient, amount, or signature.');
      return res.status(400).json({ error: 'Missing sender/recipient/amount/signature' });
    }

    logToClient(`💸 Verifying transaction: ${amount} USD from ${sender} → ${recipient}`);
    logToClient('🚦 Starting blockchain verification process...');

    const python = spawn('python', ['../blockchain/blockchain.py']);
    python.stdin.write(JSON.stringify({ sender, recipient, amount, signature }));
    python.stdin.end();

    python.stdout.on('data', async (data) => {
      let result;
      try {
        result = JSON.parse(data.toString());
      } catch (e) {
        logToClient('❌ Invalid JSON from Python script: ' + data.toString());
        logToClient('🏁 Execution complete — invalid verifier output.');
        return res.status(500).json({ error: 'Invalid verifier output' });
      }

      if (!result.valid) {
        logToClient('❌ Transaction verification failed: ' + result.error);
        logToClient('🏁 Execution complete — terminated due to failed verification.');
        return res.status(400).json({ error: 'Transaction verification failed', details: result.error });
      }

      const blockHash = result.block_hash || null;
      logToClient('✅ Verified by blockchain. Block hash: ' + blockHash);

      // Ethereum broadcast (optional)
      let ethTxHash = null;
      if (broadcastToEthereum) {
        logToClient('🌐 Broadcasting transaction to Ethereum...');
        try {
          const metadata = JSON.stringify({
            sender,
            recipient,
            amount,
            timestamp: Date.now(),
            block_hash: blockHash,
          });

          const dataHex = ethers.hexlify(ethers.toUtf8Bytes(metadata));
          const tx = await wallet.sendTransaction({
            to: wallet.address,
            value: 0,
            data: dataHex,
          });

          logToClient('🌐 Ethereum tx sent: ' + tx.hash);

          const receipt = await tx.wait();
          ethTxHash = tx.hash;
          logToClient(`✅ Ethereum tx confirmed (block ${receipt.blockNumber})`);
        } catch (ethErr) {
          logToClient('⚠️ Ethereum logging failed: ' + (ethErr.message || ethErr));
          logToClient('📦 Continuing with PayPal payout (Ethereum skipped)');
        }
      } else {
        logToClient('⏩ Ethereum broadcast skipped — transaction not logged on-chain.');
        logToClient('📦 Proceeding to PayPal payout...');
      }

      // PayPal Payout
      try {
        const token = await getPayPalAccessToken();
        const payoutBody = {
          sender_batch_header: {
            sender_batch_id: `batch_${Date.now()}`,
            email_subject: "You've received a payment",
          },
          items: [
            {
              recipient_type: 'EMAIL',
              amount: { value: amount, currency: 'USD' },
              receiver: recipient,
              note: 'Payout via blockchain verification',
            },
          ],
        };

        const payoutRes = await axios.post(
          `${process.env.PAYPAL_API}/v1/payments/payouts`,
          payoutBody,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
          }
        );

        logToClient('✅ PayPal payout successful.');

        // Save to MongoDB
        const newTx = new TransactionsSchema({
          sender,
          recipient,
          amount,
          blockHash,
          ethereumTxHash: ethTxHash || null,
          status: 'completed',
          broadcasted: broadcastToEthereum,
          timestamp: new Date(),
        });

        await newTx.save();
        logToClient('🗃️ Transaction saved to MongoDB.');
        logToClient('🏁 Execution complete — transaction fully successful.');

        return res.json({
          status: 'success',
          python_block_hash: blockHash,
          ethereum_tx_hash: ethTxHash || 'skipped',
          broadcasted_to_ethereum: broadcastToEthereum,
          paypal_response: payoutRes.data,
        });
      } catch (paypalErr) {
        logToClient('❌ PayPal payout failed: ' + (paypalErr.response ? JSON.stringify(paypalErr.response.data) : paypalErr.message));

        const failedTx = new TransactionsSchema({
          sender,
          recipient,
          amount,
          blockHash,
          ethereumTxHash: null,
          status: 'failed',
          broadcasted: broadcastToEthereum,
          timestamp: new Date(),
        });

        await failedTx.save();
        logToClient('⚠️ Failed transaction saved to MongoDB.');
        logToClient('🏁 Execution complete — terminated due to PayPal failure.');

        return res.status(500).json({
          error: 'PayPal API error',
          details: paypalErr.response ? paypalErr.response.data : paypalErr.message,
        });
      }
    });

    python.stderr.on('data', (d) => logToClient('🐍 Python stderr: ' + d.toString()));
    python.on('close', (code) => {
      logToClient(`🐍 Python exited with code: ${code}`);
      logToClient('🏁 Request cleanup complete — Python subprocess closed.');
    });

  } catch (err) {
    logToClient('❌ Server error: ' + err);
    logToClient('🏁 Execution complete — terminated with server error.');
    return res.status(500).json({ error: 'Server error' });
  }
});

// lets you create a MongoDB record manually, without actually sending money, calling PayPal, or verifying via Python
// for testing
app.post('/transactions', async (req, res) => {
  try {
    const { sender, recipient, amount, blockHash, status, broadcasted } = req.body;
    const newTx = new TransactionsSchema({
      sender,
      recipient,
      amount,
      blockHash,
      status: status || 'completed',
      broadcasted: broadcasted ?? false,
      timestamp: new Date(),
    });

    await newTx.save();
    logToClient('🗃️ Custom transaction added to MongoDB.');
    res.status(201).json(newTx);
  } catch (err) {
    logToClient('❌ Error saving custom transaction: ' + err.message);
    res.status(400).json({ error: err.message });
  }
});

app.get('/get-transactions', async (req, res) => {
  try {
    const txs = await TransactionsSchema.find().sort({ timestamp: -1 });
    console.log(`📊 Transactions fetched: ${txs.length}`);

    res.json(txs);
    // (Optional) emit logs to client via socket.io if you’ve set that up
    io.emit('serverLog', `📊 Transactions fetched: ${txs.length}`);

  } catch (err) {
    console.error('❌ Error fetching transactions:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => logToClient(`🚀 Server running on port ${PORT}`));

// Handle client connections
io.on('connection', (socket) => {
  console.log('🧠 Browser connected for live logs.');
  socket.emit('server-log', '📡 Connected to live backend logs!');
});
