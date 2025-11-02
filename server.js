const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const cors = require('cors');
const mongoose = require('mongoose');
const { spawn } = require('child_process');
const { ethers } = require('ethers');

const TransactionsSchema = require('./models/TransactionsSchema');

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// Ethereum setup (optional on-chain logging)
const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
const wallet = new ethers.Wallet(process.env.SEPOLIA_PRIVATE_KEY || '', provider);

mongoose.connect(process.env.MONGOURI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log('✅ MongoDB connection success!'))
  .catch((e) => console.error(`❌ MongoDB connection error: ${e}`));


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


app.post('/send-money', async (req, res) => {
  const logs = []; // Log collector for browser console

  try {
    const { sender, recipient, amount, signature, broadcastToEthereum } = req.body;

    if (!sender || !recipient || !amount || !signature) {
      console.warn('⚠️ Missing sender, recipient, amount, or signature.');
      logs.push('⚠️ Missing sender, recipient, amount, or signature.');
      return res.status(400).json({ error: 'Missing sender/recipient/amount/signature', logs });
    }

    console.log(`💸 Verifying transaction: ${amount} USD from ${sender} → ${recipient}`);
    logs.push(`💸 Verifying transaction: ${amount} USD from ${sender} → ${recipient}`);
    console.log('🚦 Starting blockchain verification process...');
    logs.push('🚦 Starting blockchain verification process...');

    const python = spawn('python', ['../blockchain/blockchain.py']);
    python.stdin.write(JSON.stringify({ sender, recipient, amount, signature }));
    python.stdin.end();

    python.stdout.on('data', async (data) => {
      let result;
      try {
        result = JSON.parse(data.toString());
      } catch (e) {
        console.error('❌ Invalid JSON from Python script:', data.toString());
        logs.push('❌ Invalid JSON from Python script');
        console.log('🏁 Execution complete — invalid verifier output.');
        logs.push('🏁 Execution complete — invalid verifier output.');
        return res.status(500).json({ error: 'Invalid verifier output', logs });
      }

      if (!result.valid) {
        console.warn('❌ Transaction verification failed:', result.error);
        logs.push(`❌ Transaction verification failed: ${result.error}`);
        console.log('🏁 Execution complete — terminated due to failed verification.');
        logs.push('🏁 Execution complete — terminated due to failed verification.');
        return res.status(400).json({ error: 'Transaction verification failed', details: result.error, logs });
      }

      const blockHash = result.block_hash || null;
      console.log('✅ Verified by blockchain. Block hash:', blockHash);
      logs.push(`✅ Verified by blockchain. Block hash: ${blockHash}`);

      // Ethereum broadcast (optional)
      let ethTxHash = null;
      if (broadcastToEthereum) {
        console.log('🌐 Broadcasting transaction to Ethereum...');
        logs.push('🌐 Broadcasting transaction to Ethereum...');
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

          console.log('🌐 Ethereum tx sent:', tx.hash);
          logs.push(`🌐 Ethereum tx sent: ${tx.hash}`);

          const receipt = await tx.wait();
          ethTxHash = tx.hash;
          console.log(`✅ Ethereum tx confirmed (block ${receipt.blockNumber})`);
          logs.push(`✅ Ethereum tx confirmed (block ${receipt.blockNumber})`);
        } catch (ethErr) {
          console.error('⚠️ Ethereum logging failed:', ethErr.message || ethErr);
          logs.push(`⚠️ Ethereum logging failed: ${ethErr.message || ethErr}`);
          console.log('📦 Continuing with PayPal payout (Ethereum skipped)');
          logs.push('📦 Continuing with PayPal payout (Ethereum skipped)');
        }
      } else {
        console.log('⏩ Ethereum broadcast skipped — transaction not logged on-chain.');
        logs.push('⏩ Ethereum broadcast skipped — transaction not logged on-chain.');
        console.log('📦 Proceeding to PayPal payout...');
        logs.push('📦 Proceeding to PayPal payout...');
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

        console.log('✅ PayPal payout successful.');
        logs.push('✅ PayPal payout successful.');

        // 🗃️ Save to MongoDB
        const newTx = new TransactionsSchema({
          sender,
          recipient,
          amount,
          blockHash,
          status: 'completed',
          broadcasted: broadcastToEthereum,
          timestamp: new Date(),
        });

        await newTx.save();
        console.log('🗃️ Transaction saved to MongoDB.');
        logs.push('🗃️ Transaction saved to MongoDB.');
        console.log('🏁 Execution complete — transaction fully successful.');
        logs.push('🏁 Execution complete — transaction fully successful.');

        return res.json({
          status: 'success',
          python_block_hash: blockHash,
          ethereum_tx_hash: ethTxHash || 'skipped',
          broadcasted_to_ethereum: broadcastToEthereum,
          broadcast_message: broadcastToEthereum
            ? 'Transaction was successfully broadcasted to Ethereum network.'
            : 'Transaction skipped Ethereum broadcast.',
          paypal_response: payoutRes.data,
          logs, // 🪵 include logs for frontend console
        });
      } catch (paypalErr) {
        console.error('❌ PayPal payout failed:', paypalErr.response ? paypalErr.response.data : paypalErr.message);
        logs.push(`❌ PayPal payout failed: ${paypalErr.message}`);

        const failedTx = new TransactionsSchema({
          sender,
          recipient,
          amount,
          blockHash,
          status: 'failed',
          broadcasted: broadcastToEthereum,
          timestamp: new Date(),
        });

        await failedTx.save();
        console.log('⚠️ Failed transaction saved to MongoDB.');
        logs.push('⚠️ Failed transaction saved to MongoDB.');
        console.log('🏁 Execution complete — terminated due to PayPal failure.');
        logs.push('🏁 Execution complete — terminated due to PayPal failure.');

        return res.status(500).json({
          error: 'PayPal API error',
          details: paypalErr.response ? paypalErr.response.data : paypalErr.message,
          logs,
        });
      }
    });

    python.stderr.on('data', (d) => {
      console.error('🐍 Python stderr:', d.toString());
      logs.push(`🐍 Python stderr: ${d.toString()}`);
    });

    python.on('close', (code) => {
      console.log(`🐍 Python exited with code: ${code}`);
      logs.push(`🐍 Python exited with code: ${code}`);
      console.log('🏁 Request cleanup complete — Python subprocess closed.');
      logs.push('🏁 Request cleanup complete — Python subprocess closed.');
    });

  } catch (err) {
    console.error('❌ Server error:', err);
    console.log('🏁 Execution complete — terminated with server error.');
    return res.status(500).json({ error: 'Server error', logs: [err.message] });
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
    console.log('🗃️ Custom transaction added to MongoDB.');
    res.status(201).json(newTx);
  } catch (err) {
    console.error('❌ Error saving custom transaction:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.get('/get-transactions', async (req, res) => {
  try {
    const txs = await TransactionsSchema.find().sort({ timestamp: -1 });
    res.json(txs);
  } catch (err) {
    console.error('❌ Error fetching transactions:', err.message);
    res.status(500).json({ err: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
