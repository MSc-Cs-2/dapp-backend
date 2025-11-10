const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const cors = require('cors');
const mongoose = require('mongoose');
const { spawn } = require('child_process');
const { ethers } = require('ethers');
const http = require('http'); // For Socket.IO
const { Server } = require('socket.io'); // For Socket.IO

const TransactionsSchema = require('./models/TransactionsSchema');

dotenv.config();
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// Custom log emitter
function logToClient(msg) {
  console.log(msg);
  io.emit('server-log', msg);
}

// ✅ Connect to MongoDB
mongoose.connect(process.env.MONGOURI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => logToClient('✅ MongoDB connection successful!'))
  .catch((err) => {
    logToClient('❌ MongoDB connection error: ' + err);
    process.exit(1);
  });

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
    const { sender, recipient, amount, broadcastToEthereum } = req.body;

    if (!sender || !recipient || !amount) {
      logToClient('⚠️ Missing sender, recipient, or amount.');
      return res.status(400).json({ error: 'Missing sender/recipient/amount' });
    }

    logToClient(`💸 Sending transaction: ${amount} USD from ${sender} → ${recipient}`);
    logToClient('🚦 Starting blockchain & HMAC verification via Python...');

    const pythonInput = { sender, recipient, amount, broadcastToEthereum };

    // starting python code from here to verify user
    const python = spawn('python', ['../blockchain/blockchain.py']);
    python.stdin.write(JSON.stringify(pythonInput));
    python.stdin.end();

    python.stdout.on('data', async (data) => {
      let result;
      
      try {
        result = JSON.parse(data.toString());
      } catch (e) {
        logToClient('❌ Invalid JSON from Python script: ' + data.toString());
        return res.status(500).json({ error: 'Invalid verifier output' });
      }

      if (!result.valid) {
        logToClient('❌ Transaction verification failed: ' + result.error);
        return res.status(400).json({ error: 'Transaction verification failed', details: result.error });
      }

      const blockHash = result.block_hash || null;
      logToClient('✅ Verified by blockchain. Block hash: ' + blockHash);

      // Always log Ethereum result from Python
      const ethTxHash = result.ethereum_tx || null;
      logToClient(`🌐 Ethereum tx status from Python: ${result.ethereum_status}, hash: ${ethTxHash || 'none'}`);

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
          ethereumTxHash: ethTxHash,
          status: result.ethereum_status === 'error' ? 'partial' : 'completed',
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
          ethereumTxHash: ethTxHash || null,
          status: 'failed',
          broadcasted: broadcastToEthereum,
          timestamp: new Date(),
        });

        await failedTx.save();
        logToClient('⚠️ Failed transaction saved to MongoDB.');
        return res.status(500).json({
          error: 'PayPal API error',
          details: paypalErr.response ? paypalErr.response.data : paypalErr.message,
        });
      }
    });

    python.stderr.on('data', (d) => logToClient('🐍 Python stderr: ' + d.toString()));
    python.on('close', (code) => logToClient(`🐍 Python exited with code: ${code}`));

  } catch (err) {
    logToClient('❌ Server error: ' + err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Route to manually create transactions
app.post('/transactions', async (req, res) => {
  try {
    const { sender, recipient, amount, blockHash, status, broadcasted } = req.body;

    const newTx = new TransactionsSchema({
      sender,
      recipient,
      amount,
      blockHash,
      ethereumTxHash: ethTxHash || null,
      status: ethTxHash ? 'completed' : 'partial', // decide based on runtime
      broadcasted: broadcastToEthereum,
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

// Route to fetch transactions
app.get('/get-transactions', async (req, res) => {
  try {
    const txs = await TransactionsSchema.find().sort({ timestamp: -1 });
    console.log(`📊 Transactions fetched: ${txs.length}`);
    res.json(txs);
    io.emit('serverLog', `📊 Transactions fetched: ${txs.length}`);
  } catch (err) {
    console.error('❌ Error fetching transactions:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => logToClient(`🚀 Server running on port ${PORT}`));

// Handle Socket.IO connections
io.on('connection', (socket) => {
  console.log('🧠 Browser connected for live logs.');
  socket.emit('server-log', '📡 Connected to live backend logs!');
});
